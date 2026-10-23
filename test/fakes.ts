/** Test doubles: a Phoenix-speaking WebSocket, a Norns REST API, and helpers. */
import { MockLanguageModelV3 } from "ai/test";
import { expect } from "vitest";

/** A Phoenix v2 frame: [join_ref, ref, topic, event, payload]. */
export type Frame = [string | null, string | null, string, string, Record<string, unknown>];

type Reply = { status: "ok" | "error"; response: Record<string, unknown> };

/**
 * Stands in for the global WebSocket under phoenix.js. Opens on the next
 * tick, records every frame sent, answers joins, heartbeats, leaves and
 * pushes with ok (or whatever `joinReply` says), and lets a test push
 * server events in.
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static joinReply: (payload: Record<string, unknown>, ws: FakeWebSocket) => Reply | null = () => ({
    status: "ok",
    response: {},
  });

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.joinReply = () => ({ status: "ok", response: {} });
  }

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no FakeWebSocket has been opened");
    return ws;
  }

  readonly url: string;
  readyState = 0;
  binaryType = "";
  timeout = 0;
  closed = false;
  sent: Frame[] = [];
  onopen: ((ev: unknown) => void) | undefined;
  onmessage: ((ev: { data: string }) => void) | undefined;
  onclose: ((ev: unknown) => void) | undefined;
  onerror: ((ev: unknown) => void) | undefined;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(raw: string): void {
    if (this.closed) throw new Error("socket closed");
    const frame = JSON.parse(raw) as Frame;
    this.sent.push(frame);
    const [joinRef, ref, topic, event, payload] = frame;
    switch (event) {
      case "heartbeat":
      case "phx_leave":
      case "drain":
      case "tool_result":
      case "send_message":
        this.reply(joinRef, ref, topic, { status: "ok", response: {} });
        break;
      case "phx_join": {
        const reply = FakeWebSocket.joinReply(payload, this);
        if (reply) this.reply(joinRef, ref, topic, reply);
        break;
      }
      default:
        break; // register_port and the like: the test replies by hand
    }
  }

  reply(joinRef: string | null, ref: string | null, topic: string, payload: Reply): void {
    queueMicrotask(() => this.deliver([joinRef, ref, topic, "phx_reply", payload]));
  }

  /** Reply to the most recent frame with this event name. */
  replyTo(event: string, payload: Reply): void {
    const frame = [...this.sent].reverse().find((f) => f[3] === event);
    if (!frame) throw new Error(`no ${event} frame was sent`);
    this.reply(frame[0], frame[1], frame[2], payload);
  }

  /** A server-initiated event on a joined topic. */
  push(event: string, payload: Record<string, unknown>, topic = "worker:lobby"): void {
    this.deliver([this.joinRef(topic), null, topic, event, payload]);
  }

  deliver(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  joinRef(topic: string): string | null {
    const join = [...this.sent].reverse().find((f) => f[3] === "phx_join" && f[2] === topic);
    return join?.[0] ?? null;
  }

  /** The client closed it. */
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() =>
      this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true }),
    );
  }

  /** The connection dropped out from under the client. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "", wasClean: false });
  }

  events(): string[] {
    return this.sent.map((f) => f[3]);
  }

  results(): Record<string, unknown>[] {
    return this.sent.filter((f) => f[3] === "tool_result").map((f) => f[4]);
  }

  joinPayload(): Record<string, unknown> {
    const join = this.sent.find((f) => f[3] === "phx_join");
    if (!join) throw new Error("no join was sent");
    return join[4];
  }
}

export function toolTask(
  taskId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { task_id: taskId, tool_name: toolName, input, ...extra };
}

export async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect.fail("condition not met in time");
}

export async function nextResult(ws: FakeWebSocket, after = 0): Promise<Record<string, unknown>> {
  await waitFor(() => ws.results().length > after);
  return ws.results()[after] as Record<string, unknown>;
}

/** A stand-in for the Norns REST API, enough for the worker and client. */
export function fakeNornsApi(seed: Record<string, unknown>[] = []) {
  const agents = [...seed];
  const runs = new Map<number, Record<string, unknown>>();
  const requests: { method: string; path: string; query: string; body: unknown }[] = [];
  let nextId = agents.length + 1;
  let nextRun = 100;

  const api = {
    agents,
    runs,
    requests,
    /** Scripted responses for a path: each call pops one. */
    scripted: new Map<string, Array<{ status: number; body: unknown }>>(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const path = url.pathname;
      requests.push({ method, path, query: url.search, body });

      const scripted = api.scripted.get(`${method} ${path}`)?.shift();
      if (scripted) return json(scripted.status, scripted.body);

      if (method === "GET" && path === "/api/v1/agents") return json(200, { data: agents });
      if (method === "POST" && path === "/api/v1/agents") {
        const created = {
          id: nextId++,
          status: "idle",
          inserted_at: "2026-10-15T00:00:00Z",
          ...body,
        };
        agents.push(created);
        return json(201, { data: created });
      }
      let m = path.match(/^\/api\/v1\/agents\/(\d+)$/);
      if (m) {
        const agent = agents.find((a) => a.id === Number(m?.[1]));
        if (!agent) return json(404, { error: "not found" });
        if (method === "PUT") Object.assign(agent, body);
        return json(200, { data: agent });
      }
      m = path.match(/^\/api\/v1\/agents\/(\d+)\/messages$/);
      if (m && method === "POST") {
        const id = nextRun++;
        runs.set(id, {
          id,
          agent_id: Number(m[1]),
          status: "running",
          output: null,
          trigger_type: "message",
          input: { user_message: body.content },
          inserted_at: "2026-10-15T00:00:00Z",
        });
        return json(202, { status: "accepted", run_id: id });
      }
      m = path.match(/^\/api\/v1\/runs\/(\d+)$/);
      if (m) {
        const run = runs.get(Number(m[1]));
        return run ? json(200, { data: run }) : json(404, { error: "not found" });
      }
      m = path.match(/^\/api\/v1\/runs\/(\d+)\/reply$/);
      if (m && method === "POST") return json(202, { status: "accepted", run_id: Number(m[1]) });
      m = path.match(/^\/api\/v1\/runs\/(\d+)\/events$/);
      if (m) return json(200, { data: [] });
      if (path === "/api/v1/runs") return json(200, { data: [...runs.values()] });
      return json(404, { error: "not found" });
    }) as typeof fetch,
  };
  return api;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A model that answers with text, or with tool calls. */
export function mockModel(
  reply:
    | { text: string }
    | {
        toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        text?: string;
      },
  options: {
    modelId?: string;
    usage?: Partial<{
      total: number;
      noCache: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
    }>;
  } = {},
): MockLanguageModelV3 {
  const u = options.usage ?? {};
  const content =
    "toolCalls" in reply
      ? [
          ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
          ...reply.toolCalls.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: JSON.stringify(tc.input),
          })),
        ]
      : [{ type: "text" as const, text: reply.text }];
  return new MockLanguageModelV3({
    modelId: options.modelId ?? "mock-model",
    doGenerate: async () => ({
      content,
      finishReason: {
        unified: "toolCalls" in reply ? ("tool-calls" as const) : ("stop" as const),
        raw: "end_turn",
      },
      usage: {
        inputTokens: {
          total: u.total ?? 10,
          noCache: u.noCache,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
        },
        outputTokens: { total: u.output ?? 5, text: u.output ?? 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}
