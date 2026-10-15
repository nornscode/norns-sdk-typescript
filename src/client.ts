import { Socket, type SocketConnectOption } from "phoenix";
import { type AgentDefinition, agentBody } from "./agent.js";
import { AsyncQueue } from "./async-queue.js";
import {
  NornsApiError,
  NornsError,
  NornsTimeoutError,
  NotFoundError,
  StreamClosedError,
} from "./errors.js";
import {
  type AgentInfo,
  type Conversation,
  type MessageResult,
  type Run,
  type RunEvent,
  type RunStatus,
  type StreamEvent,
  TERMINAL_EVENTS,
  type WaitingFor,
} from "./types.js";

/** A class that behaves like the browser `WebSocket`; the global one by default. */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => object;

export interface NornsClientOptions {
  /** The Norns base URL. Defaults to `NORNS_URL`. */
  url?: string;
  /** The tenant's bearer token. Defaults to `NORNS_API_KEY`. */
  apiKey?: string;
  /** Replace the global `fetch`, for tests or custom transport. */
  fetch?: typeof globalThis.fetch;
  /** Replace the global `WebSocket` for streams. */
  transport?: WebSocketConstructor;
  /** Extra options for the Phoenix socket that streams use. */
  socketOptions?: Partial<SocketConnectOption>;
}

/** An agent's id, or its name. */
export type AgentRef = number | string;

export interface SendMessageOptions {
  /** Key for multi-turn conversations, e.g. a Slack user id. */
  conversationKey?: string;
  /** Opaque context stored on the run. */
  context?: Record<string, unknown>;
  /** Pin the run to a gard. */
  gardId?: number;
  /**
   * Poll until the run completes, fails, or parks on a question. A parked
   * agent is waiting on you, so the wait ends there too.
   */
  wait?: boolean;
  /** How long to wait, with `wait`. Default 30 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamOptions {
  conversationKey?: string;
  context?: Record<string, unknown>;
  gardId?: number;
  /** Give up if no event arrives for this long. Default 2 minutes. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ListRunsOptions {
  /** How many the server returns, most recent first. Default 50. */
  limit?: number;
  status?: RunStatus;
  agentId?: number;
}

const WAIT_STOPS: ReadonlySet<string> = new Set(["completed", "failed", "error", "waiting"]);

/**
 * Talks to Norns from application code: sends messages, reads runs, streams
 * events. For serving an agent, see `NornsWorker`.
 *
 *     const client = new NornsClient({ url, apiKey });
 *     const result = await client.sendMessage("support-bot", "Where's my order?", { wait: true });
 */
export class NornsClient {
  readonly url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #transport: WebSocketConstructor | undefined;
  readonly #socketOptions: Partial<SocketConnectOption>;

  constructor(options: NornsClientOptions = {}) {
    this.url = resolveUrl(options.url);
    this.#apiKey = resolveApiKey(options.apiKey);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#transport = options.transport;
    this.#socketOptions = options.socketOptions ?? {};
  }

  // --- Agents ---

  readonly agents = {
    list: async (): Promise<AgentInfo[]> => {
      const res = await this.#request<{ data: Record<string, unknown>[] }>("GET", "/api/v1/agents");
      return res.data.map(parseAgent);
    },

    /** By id, or by name. */
    get: async (agent: AgentRef): Promise<AgentInfo> => {
      if (typeof agent === "number") {
        const res = await this.#request<{ data: Record<string, unknown> }>(
          "GET",
          `/api/v1/agents/${agent}`,
        );
        return parseAgent(res.data);
      }
      const found = (await this.agents.list()).find((a) => a.name === agent);
      if (!found) throw new NotFoundError(`Agent '${agent}'`);
      return found;
    },

    /**
     * Create the agent, or update it to match the definition if it exists,
     * so code changes are always picked up. The worker does this on start.
     */
    ensure: async (definition: AgentDefinition): Promise<AgentInfo> => {
      const body = agentBody(definition);
      const existing = (await this.agents.list()).find((a) => a.name === definition.name);
      if (existing) {
        const res = await this.#request<{ data: Record<string, unknown> }>(
          "PUT",
          `/api/v1/agents/${existing.id}`,
          { body },
        );
        return parseAgent(res.data);
      }
      const res = await this.#request<{ data: Record<string, unknown> }>("POST", "/api/v1/agents", {
        body,
      });
      return parseAgent(res.data);
    },
  };

  // --- Messages ---

  /**
   * Send a message to an agent. Returns at once with the run id, or, with
   * `wait`, once the run completes, fails, or parks on a question.
   */
  async sendMessage(
    agent: AgentRef,
    content: string,
    options: SendMessageOptions = {},
  ): Promise<MessageResult> {
    const agentId = await this.#resolveAgentId(agent);
    const runId = await this.#post(agentId, content, options);

    if (!options.wait) {
      return {
        runId,
        status: "accepted",
        output: null,
        conversationKey: options.conversationKey,
        isWaiting: false,
        waitingFor: null,
      };
    }

    const run = await this.#waitForRun(runId, options.timeoutMs ?? 30_000, options.signal);
    return {
      runId,
      status: run.status,
      output: run.output,
      conversationKey: options.conversationKey,
      isWaiting: run.status === "waiting",
      waitingFor: run.waitingFor,
    };
  }

  /**
   * Send a message and iterate the run's events as they happen, until it
   * completes or errors.
   *
   *     for await (const event of client.stream("researcher", "Summarise this")) {
   *       if (event.type === "completed") console.log(event.data.output);
   *     }
   */
  async *stream(
    agent: AgentRef,
    content: string,
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const agentId = await this.#resolveAgentId(agent);
    const runId = await this.#post(agentId, content, options);
    yield* this.#watch(agentId, runId, options);
  }

  // --- Runs ---

  readonly runs = {
    get: async (runId: number): Promise<Run> => {
      const res = await this.#request<{ data: Record<string, unknown> }>(
        "GET",
        `/api/v1/runs/${runId}`,
      );
      return parseRun(res.data);
    },

    /**
     * The tenant's runs, most recent first. Use it to find runs nobody holds
     * a handle to, above all the ones parked on an `ask_human` question:
     *
     *     for (const run of await client.runs.list({ status: "waiting" })) {
     *       console.log(run.id, run.waitingFor?.question);
     *     }
     *
     * `status` and `agentId` filter the page the server returned, so a
     * narrow filter over a busy tenant may need a larger `limit`.
     */
    list: async (options: ListRunsOptions = {}): Promise<Run[]> => {
      const res = await this.#request<{ data: Record<string, unknown>[] }>("GET", "/api/v1/runs", {
        query: { limit: options.limit ?? 50 },
      });
      let runs = res.data.map(parseRun);
      if (options.status) runs = runs.filter((r) => r.status === options.status);
      if (options.agentId !== undefined) runs = runs.filter((r) => r.agentId === options.agentId);
      return runs;
    },

    events: async (runId: number): Promise<RunEvent[]> => {
      const res = await this.#request<{ data: Record<string, unknown>[] }>(
        "GET",
        `/api/v1/runs/${runId}/events`,
      );
      return res.data.map(parseEvent);
    },

    /**
     * Answer a run parked on an `ask_human` question. Sending the agent a
     * normal message does the same and is usually what a chat client wants;
     * this targets one specific run.
     */
    reply: async (runId: number, answer: string): Promise<void> => {
      await this.#request("POST", `/api/v1/runs/${runId}/reply`, { body: { answer } });
    },

    /** Re-run a finished or failed run's message. Returns the new run id. */
    retry: async (runId: number): Promise<number> => {
      const res = await this.#request<{ run_id: number }>("POST", `/api/v1/runs/${runId}/retry`);
      return res.run_id;
    },

    /** Iterate an existing run's events as they happen, until it finishes. */
    watch: (
      runId: number,
      options: Pick<StreamOptions, "idleTimeoutMs" | "signal"> = {},
    ): AsyncGenerator<StreamEvent, void, undefined> => {
      const self = this;
      return (async function* () {
        const run = await self.runs.get(runId);
        yield* self.#watch(run.agentId, runId, options);
      })();
    },
  };

  // --- Conversations ---

  readonly conversations = {
    list: async (agent: AgentRef): Promise<Conversation[]> => {
      const agentId = await this.#resolveAgentId(agent);
      const res = await this.#request<{ data: Record<string, unknown>[] }>(
        "GET",
        `/api/v1/agents/${agentId}/conversations`,
      );
      return res.data.map(parseConversation);
    },

    get: async (agent: AgentRef, key: string): Promise<Conversation> => {
      const agentId = await this.#resolveAgentId(agent);
      const res = await this.#request<{ data: Record<string, unknown> }>(
        "GET",
        `/api/v1/agents/${agentId}/conversations/${encodeURIComponent(key)}`,
      );
      return parseConversation(res.data);
    },

    /** Reset a conversation: its history is gone, the next message starts fresh. */
    delete: async (agent: AgentRef, key: string): Promise<void> => {
      const agentId = await this.#resolveAgentId(agent);
      await this.#request(
        "DELETE",
        `/api/v1/agents/${agentId}/conversations/${encodeURIComponent(key)}`,
      );
    },
  };

  // --- Internals ---

  async #resolveAgentId(agent: AgentRef): Promise<number> {
    return typeof agent === "number" ? agent : (await this.agents.get(agent)).id;
  }

  async #post(
    agentId: number,
    content: string,
    options: {
      conversationKey?: string;
      context?: Record<string, unknown>;
      gardId?: number;
      signal?: AbortSignal;
    },
  ): Promise<number> {
    const body: Record<string, unknown> = { content };
    if (options.conversationKey !== undefined) body.conversation_key = options.conversationKey;
    if (options.context !== undefined) body.context = options.context;
    if (options.gardId !== undefined) body.gard_id = options.gardId;
    const res = await this.#request<{ run_id: number }>(
      "POST",
      `/api/v1/agents/${agentId}/messages`,
      {
        body,
        signal: options.signal,
      },
    );
    return res.run_id;
  }

  // Poll until the run stops progressing. "waiting" is not terminal, but
  // the agent is parked on a question and will not move until someone
  // answers, so it ends the wait too.
  async #waitForRun(runId: number, timeoutMs: number, signal?: AbortSignal): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    let interval = 500;
    while (Date.now() < deadline) {
      const run = await this.runs.get(runId);
      if (WAIT_STOPS.has(run.status)) return run;
      await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)), signal);
      interval = Math.min(interval * 1.5, 3000);
    }
    throw new NornsTimeoutError(`Run ${runId} did not complete within ${timeoutMs}ms`);
  }

  async *#watch(
    agentId: number,
    runId: number,
    options: Pick<StreamOptions, "idleTimeoutMs" | "signal">,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const idle = options.idleTimeoutMs ?? 120_000;
    const queue = new AsyncQueue<StreamEvent>();
    const socket = new Socket(`${wsBase(this.url)}/socket`, {
      params: { token: this.#apiKey },
      ...(this.#transport
        ? { transport: this.#transport as SocketConnectOption["transport"] }
        : {}),
      ...this.#socketOptions,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => queue.fail(new NornsTimeoutError(`No event for ${idle}ms on run ${runId}`)),
        idle,
      );
    };
    const onAbort = () => queue.fail(options.signal?.reason ?? abortError());

    socket.onError((err) => queue.fail(new StreamClosedError(err)));
    socket.onClose((ev) => queue.fail(new StreamClosedError(ev)));

    const channel = socket.channel(`agent:${agentId}`, { run_id: runId });
    channel.onMessage = (event: string, payload: Record<string, unknown>) => {
      if (!event.startsWith("phx_") && !event.startsWith("chan_reply_") && event !== "heartbeat") {
        // The channel is per agent, so another run's events arrive here too.
        if (payload?.run_id === undefined || payload.run_id === runId) {
          queue.push({ type: event, data: payload } as StreamEvent);
          touch();
        }
      }
      return payload;
    };
    channel
      .join()
      .receive("error", (resp) =>
        queue.fail(new NornsError(`Could not join agent:${agentId}: ${JSON.stringify(resp)}`)),
      )
      .receive("timeout", () =>
        queue.fail(new NornsTimeoutError(`Joining agent:${agentId} timed out`)),
      );

    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.connect();
    touch();

    try {
      for await (const event of queue) {
        yield event;
        if (TERMINAL_EVENTS.has(event.type)) return;
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      queue.close();
      socket.disconnect();
    }
  }

  async #request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number>; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = new URL(this.url + path);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const res = await this.#fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    const text = await res.text();
    const json = text === "" ? undefined : safeParse(text);
    if (!res.ok) {
      if (res.status === 404) throw new NotFoundError(`${method} ${path}`, json ?? text);
      throw new NornsApiError(res.status, json ?? text);
    }
    return json as T;
  }
}

// --- Helpers ---

export function resolveUrl(url: string | undefined): string {
  const value = url ?? process.env.NORNS_URL;
  if (!value) throw new NornsError("Norns URL missing: pass `url` or set NORNS_URL");
  return value.replace(/\/+$/, "");
}

export function resolveApiKey(apiKey: string | undefined): string {
  const value = apiKey ?? process.env.NORNS_API_KEY;
  if (!value) throw new NornsError("Norns API key missing: pass `apiKey` or set NORNS_API_KEY");
  return value;
}

export function wsBase(url: string): string {
  return url.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Parsers: wire snake_case → camelCase ---

type Raw = Record<string, unknown>;

function parseWaitingFor(data: unknown): WaitingFor | null {
  if (!data || typeof data !== "object") return null;
  const w = data as Raw;
  return {
    question: String(w.question ?? ""),
    toolCallId: String(w.tool_call_id ?? ""),
    askedAt: typeof w.asked_at === "string" ? w.asked_at : undefined,
  };
}

export function parseRun(r: Raw): Run {
  return {
    id: r.id as number,
    agentId: r.agent_id as number,
    conversationId: (r.conversation_id as number | null) ?? null,
    parentRunId: (r.parent_run_id as number | null) ?? null,
    gardId: (r.gard_id as number | null) ?? null,
    status: r.status as RunStatus,
    triggerType: (r.trigger_type as string) ?? "message",
    input: (r.input as Raw) ?? {},
    output: (r.output as string | null) ?? null,
    waitingFor: parseWaitingFor(r.waiting_for),
    failureMetadata: (r.failure_metadata as Raw) ?? {},
    inputTokens: (r.input_tokens as number) ?? 0,
    outputTokens: (r.output_tokens as number) ?? 0,
    cost: (r.cost as Run["cost"]) ?? null,
    insertedAt: r.inserted_at as string,
    updatedAt: (r.updated_at as string) ?? (r.inserted_at as string),
  };
}

export function parseEvent(e: Raw): RunEvent {
  return {
    id: e.id as number,
    sequence: e.sequence as number,
    eventType: e.event_type as string,
    payload: (e.payload as Raw) ?? {},
    source: (e.source as string) ?? "",
    insertedAt: e.inserted_at as string,
  };
}

export function parseAgent(a: Raw): AgentInfo {
  return {
    id: a.id as number,
    name: a.name as string,
    purpose: (a.purpose as string | null) ?? null,
    status: (a.status as string) ?? "active",
    model: (a.model as string) ?? "",
    systemPrompt: (a.system_prompt as string) ?? "",
    maxSteps: (a.max_steps as number) ?? 50,
    contextStrategy: (a.context_strategy as string) ?? "sliding_window",
    contextWindow: (a.context_window as number) ?? 20,
    archivedAt: (a.archived_at as string | null) ?? null,
    insertedAt: a.inserted_at as string,
    updatedAt: (a.updated_at as string) ?? (a.inserted_at as string),
  };
}

export function parseConversation(c: Raw): Conversation {
  return {
    id: c.id as number,
    agentId: c.agent_id as number,
    key: c.key as string,
    summary: (c.summary as string | null) ?? null,
    messageCount: (c.message_count as number) ?? 0,
    tokenEstimate: (c.token_estimate as number) ?? 0,
    insertedAt: c.inserted_at as string,
    updatedAt: (c.updated_at as string) ?? (c.inserted_at as string),
  };
}
