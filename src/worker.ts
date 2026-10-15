import { randomBytes } from "node:crypto";
import { generateText } from "ai";
import { type Channel, Socket, type SocketConnectOption } from "phoenix";
import { type AgentDefinition, agentList, toolsByName } from "./agent.js";
import {
  NornsClient,
  resolveApiKey,
  resolveUrl,
  sleep,
  type WebSocketConstructor,
  wsBase,
} from "./client.js";
import { CompletedCalls, completedCallsPath } from "./completed-calls.js";
import { errorMessage, GardDestroyedError, JoinError, NornsError } from "./errors.js";
import {
  compactionMessages,
  composeCompactionPrompt,
  composeSystemPrompt,
  finalOutput,
  fromGenerateResult,
  type LlmResult,
  type LlmTask,
  maxTokens,
  messagesForTask,
  type ToolResult,
  type ToolTask,
  toInstructions,
  toModelMessages,
  toToolSet,
} from "./format.js";
import { type Logger, resolveLogger } from "./logger.js";
import { type ModelResolver, type ModelsOption, toResolver } from "./models.js";
import {
  stringifyToolOutput,
  type ToolContext,
  type ToolDefinition,
  toolRegistration,
} from "./tool.js";

export type Capability = "llm" | "tools";

export interface NornsWorkerOptions {
  /** The agent, or agents, this worker serves. */
  agents: AgentDefinition | AgentDefinition[];
  /** The Norns base URL. Defaults to `NORNS_URL`. */
  url?: string;
  /** The tenant's bearer token. Defaults to `NORNS_API_KEY`. */
  apiKey?: string;
  /**
   * How a model name on an LLM task becomes a model to call: a function, a
   * provider (`anthropic`), or a registry from `createProviderRegistry()`.
   * By default the provider is inferred from the name and its `@ai-sdk/*`
   * package loaded; API keys come from the provider's own env var.
   */
  models?: ModelsOption;
  /** What this worker serves. Default both; `["tools"]` for a worker with no LLM access. */
  capabilities?: Capability[];
  /** A stable identity. Defaults to `NORNS_WORKER_ID`, else a random one. */
  workerId?: string;
  /** Claim a gard (defaults to `NORNS_GARD`); needs `claimToken`. */
  gard?: string | number;
  /** Defaults to `NORNS_GARD_CLAIM_TOKEN`. */
  claimToken?: string;
  /** How long `stop()` waits for in-flight tasks. Default 30 s, or `NORNS_SHUTDOWN_TIMEOUT` (seconds). */
  shutdownTimeoutMs?: number;
  /** Drain on SIGINT/SIGTERM. Default true. */
  handleSignals?: boolean;
  /** Where to log. `null` for silence. Default: the console. */
  logger?: Logger | null;
  /**
   * Where completed side-effecting calls are remembered across restarts.
   * Defaults to `NORNS_STATE_DIR`, else the system temp dir; `null` disables.
   */
  stateDir?: string | null;
  /** Replace the global `fetch` (used to register the agents). */
  fetch?: typeof globalThis.fetch;
  /** Replace the global `WebSocket`. */
  transport?: WebSocketConstructor;
  /** Extra options for the Phoenix socket. */
  socketOptions?: Partial<SocketConnectOption>;
}

export interface RegisterPortOptions {
  name?: string;
  url?: string;
  protocol?: string;
}

export interface RegisteredPort {
  id: number;
  internalPort: number;
  url: string | null;
}

type WorkerState = "idle" | "starting" | "running" | "draining" | "stopped";

interface InFlight {
  taskId: string;
  controller: AbortController;
  done: Promise<void>;
}

const TOPIC = "worker:lobby";

/**
 * Serves agents: connects to Norns, registers their tools, and handles the
 * LLM and tool tasks it is sent.
 *
 *     const worker = new NornsWorker({ agents: [supportBot] });
 *     await worker.start();   // resolves once joined; Ctrl-C drains and exits
 *
 * `start()` resolves when the worker has joined, so the rest of your program
 * can carry on; the open socket keeps the process alive. `stop()` drains:
 * Norns stops sending work, in-flight tasks finish and report, and the
 * worker leaves. `stopped` settles when that is done.
 */
export class NornsWorker {
  readonly url: string;
  readonly workerId: string;
  readonly gard: string | number | undefined;

  readonly #apiKey: string;
  readonly #agents: AgentDefinition[];
  readonly #tools: Map<string, ToolDefinition>;
  readonly #capabilities: Capability[];
  readonly #claimToken: string | undefined;
  readonly #shutdownTimeoutMs: number;
  readonly #handleSignals: boolean;
  readonly #logger: Logger;
  readonly #stateDir: string | null | undefined;
  readonly #transport: WebSocketConstructor | undefined;
  readonly #socketOptions: Partial<SocketConnectOption>;
  readonly #client: NornsClient;
  readonly #resolveModel: ModelResolver;
  readonly #inFlight = new Set<InFlight>();

  #state: WorkerState = "idle";
  #socket: Socket | undefined;
  #channel: Channel | undefined;
  #completed: CompletedCalls | undefined;
  #starting: Promise<void> | undefined;
  #signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
  readonly #stopped: Promise<void>;
  #settleStopped!: { resolve: () => void; reject: (err: unknown) => void };

  constructor(options: NornsWorkerOptions) {
    this.url = resolveUrl(options.url);
    this.#apiKey = resolveApiKey(options.apiKey);
    this.#agents = agentList(options.agents);
    this.#tools = toolsByName(this.#agents);
    this.#capabilities = options.capabilities ?? ["llm", "tools"];
    if (this.#capabilities.length === 0)
      throw new NornsError("A worker needs at least one capability");
    this.#logger = resolveLogger(options.logger);
    this.#stateDir = options.stateDir;
    this.#transport = options.transport;
    this.#socketOptions = options.socketOptions ?? {};
    this.#handleSignals = options.handleSignals ?? true;
    this.#resolveModel = toResolver(options.models);

    // A provisioner (volund) hands the worker its identity and gard through
    // the environment, so scaffolded workers need no code changes.
    this.workerId =
      options.workerId ??
      process.env.NORNS_WORKER_ID ??
      `ts-worker-${randomBytes(4).toString("hex")}`;
    this.gard = options.gard ?? process.env.NORNS_GARD;
    this.#claimToken = options.claimToken ?? process.env.NORNS_GARD_CLAIM_TOKEN;

    const envTimeout = Number(process.env.NORNS_SHUTDOWN_TIMEOUT);
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout * 1000 : 30_000);

    this.#client = new NornsClient({ url: this.url, apiKey: this.#apiKey, fetch: options.fetch });

    this.#stopped = new Promise<void>((resolve, reject) => {
      this.#settleStopped = { resolve, reject };
    });
    // Nobody has to await `stopped`; a rejection must not crash the process.
    this.#stopped.catch(() => {});
  }

  /** The agents this worker serves. */
  get agents(): readonly AgentDefinition[] {
    return this.#agents;
  }

  get state(): WorkerState {
    return this.#state;
  }

  /**
   * Settles once the worker has stopped: resolves after a drain, rejects
   * with `JoinError` or `GardDestroyedError` when it was forced off.
   */
  get stopped(): Promise<void> {
    return this.#stopped;
  }

  /**
   * Register the agents, connect, and join. Resolves once Norns has accepted
   * the worker; rejects with `JoinError` when it never will (bad claim
   * token, destroyed gard). A server that is down is retried until it is up.
   */
  start(): Promise<void> {
    if (this.#state !== "idle") throw new NornsError("start() may only be called once");
    this.#state = "starting";
    this.#starting = this.#start().then(
      () => {
        if (this.#state === "starting") this.#state = "running";
      },
      (err) => {
        this.#fail(err);
        throw err;
      },
    );
    return this.#starting;
  }

  async #start(): Promise<void> {
    for (const agent of this.#agents) {
      const info = await this.#client.agents.ensure(agent);
      this.#logger.info(`Registered agent '${agent.name}' (id=${info.id})`);
    }

    if (this.#capabilities.includes("llm")) {
      // A model nobody can serve fails here, with a message, not on the first task.
      for (const model of new Set(this.#agents.map((a) => a.model))) {
        await this.#resolveModel(model);
      }
    }

    // Keyed by worker id: Norns re-dispatches a lost call to whichever
    // worker comes back under that identity, and this is what it needs to
    // recognise it.
    this.#completed = new CompletedCalls(
      completedCallsPath(this.workerId, this.#stateDir),
      this.#logger,
    );

    await this.#connect();
    this.#installSignalHandlers();
  }

  #connect(): Promise<void> {
    const socket = new Socket(`${wsBase(this.url)}/worker`, {
      params: { token: this.#apiKey },
      logger: (kind, msg, data) => this.#logger.debug(`phoenix ${kind}: ${msg}`, data),
      ...(this.#transport
        ? { transport: this.#transport as SocketConnectOption["transport"] }
        : {}),
      ...this.#socketOptions,
    });
    this.#socket = socket;

    socket.onOpen(() => this.#logger.info(`Connected to ${this.url}`));
    socket.onError((err) => {
      if (this.#state === "starting" || this.#state === "running") {
        this.#logger.warn(`Connection error (${errorMessage(err)}); retrying`);
      }
    });
    socket.onClose(() => {
      if (this.#state === "running") {
        this.#logger.warn("Disconnected from Norns; reconnecting");
        // In-flight results cannot be delivered on the next connection: Norns
        // re-dispatches on disconnect, and idempotency skips completed side effects.
        this.#abortInFlight("socket closed");
      }
    });

    const channel = socket.channel(TOPIC, this.#joinParams());
    this.#channel = channel;
    channel.on("llm_task", (task: LlmTask) =>
      this.#spawn(task.task_id, (s) => this.#runLlm(task, s)),
    );
    channel.on("tool_task", (task: ToolTask) =>
      this.#spawn(task.task_id, (s) => this.#runTool(task, s)),
    );
    channel.on("gard_destroyed", () => {
      this.#logger.error("This worker's gard was destroyed; shutting down");
      this.#fail(new GardDestroyedError(this.gard));
    });
    channel.onError((reason) => {
      if (this.#state === "running")
        this.#logger.warn(`Channel error (${errorMessage(reason)}); rejoining`);
    });

    return new Promise<void>((resolve, reject) => {
      let joined = false;
      channel
        .join()
        .receive("ok", () => {
          if (joined) {
            this.#logger.info(`Worker ${this.workerId} rejoined`);
            return;
          }
          joined = true;
          this.#logger.info(
            this.gard !== undefined
              ? `Worker ${this.workerId} ready (gard ${this.gard})`
              : `Worker ${this.workerId} ready`,
          );
          resolve();
        })
        .receive("error", (resp: { reason?: string; code?: string } | undefined) => {
          const reason = resp?.reason ?? "join rejected";
          // On a quick reconnect the server may not have processed the old
          // connection's disconnect yet; the channel rejoins by itself.
          if (reason === "already_claimed") {
            this.#logger.warn("Gard claim rejected: already_claimed; retrying");
            return;
          }
          const err = new JoinError(reason, resp?.code);
          this.#fail(err);
          reject(err);
        })
        .receive("timeout", () => this.#logger.warn("Join timed out; retrying"));
      socket.connect();
    });
  }

  #joinParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {
      worker_id: this.workerId,
      tools: [...this.#tools.values()].map(toolRegistration),
      capabilities: this.#capabilities,
    };
    if (this.gard !== undefined) {
      params.gard = this.gard;
      params.claim_token = this.#claimToken ?? null;
    }
    return params;
  }

  /**
   * Drain and stop: tell Norns to send no more work, finish the tasks in
   * flight (up to the shutdown timeout), report them, leave. Tasks still
   * running at the deadline are dropped and Norns re-dispatches them.
   */
  async stop(): Promise<void> {
    if (this.#state === "idle") {
      this.#state = "stopped";
      this.#settleStopped.resolve();
      return;
    }
    if (this.#state === "starting") {
      try {
        await this.#starting;
      } catch {
        return;
      }
    }
    if (this.#state !== "running") return this.#stopped;
    this.#state = "draining";

    const channel = this.#channel;
    const socket = this.#socket;
    this.#logger.info(
      `Draining: ${this.#inFlight.size} in-flight task(s), up to ${this.#shutdownTimeoutMs / 1000}s`,
    );

    // Norns stops dispatching to us. In-flight tasks stay ours; new ones
    // queue for our replacement.
    if (channel) {
      await new Promise<void>((resolve) => {
        channel
          .push("drain", {}, 5000)
          .receive("ok", () => resolve())
          .receive("error", (resp) => {
            this.#logger.warn(
              `Could not send drain (${errorMessage(resp)}); Norns will re-dispatch on disconnect`,
            );
            resolve();
          })
          .receive("timeout", () => resolve());
      });
    }

    // Wait for what we hold, including anything that raced in before the
    // drain took effect, until the deadline.
    const deadline = Date.now() + this.#shutdownTimeoutMs;
    while (this.#inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.#inFlight].map((t) => t.done)),
        sleep(deadline - Date.now()),
      ]);
    }
    if (this.#inFlight.size > 0) {
      this.#logger.warn(
        `${this.#inFlight.size} task(s) still running at the deadline; dropping them, Norns will re-dispatch`,
      );
      this.#abortInFlight("shutdown deadline");
    } else {
      this.#logger.info("Drained; leaving");
    }

    if (channel) {
      await new Promise<void>((resolve) => {
        channel
          .leave(5000)
          .receive("ok", () => resolve())
          .receive("timeout", () => resolve());
      });
    }
    if (socket) await new Promise<void>((resolve) => socket.disconnect(() => resolve()));

    this.#teardown();
    this.#state = "stopped";
    this.#logger.info("Worker stopped.");
    this.#settleStopped.resolve();
  }

  /**
   * Expose a service port for the dashboard. Only in a gard: the gard is
   * inferred from the connection. Call it from a tool after starting a
   * service.
   */
  async registerPort(
    internalPort: number,
    options: RegisterPortOptions = {},
  ): Promise<RegisteredPort> {
    if (this.gard === undefined)
      throw new NornsError("registerPort requires the worker to be in a gard");
    const channel = this.#channel;
    if (channel?.state !== "joined") {
      throw new NornsError("registerPort requires a connected worker");
    }
    const payload: Record<string, unknown> = {
      internal_port: internalPort,
      name: options.name ?? "",
      protocol: options.protocol ?? "http",
    };
    if (options.url) payload.url = options.url;

    return new Promise((resolve, reject) => {
      channel
        .push("register_port", payload, 10_000)
        .receive("ok", (resp: { id: number; internal_port: number; url: string | null }) =>
          resolve({ id: resp.id, internalPort: resp.internal_port, url: resp.url ?? null }),
        )
        .receive("error", (resp) =>
          reject(new NornsError(`register_port rejected: ${errorMessage(resp?.reason ?? resp)}`)),
        )
        .receive("timeout", () => reject(new NornsError("register_port timed out")));
    });
  }

  // --- Tasks ---

  // Each task runs on its own: a slow tool or LLM call must not hold up the
  // others on this connection (parallel tool calls, other runs).
  #spawn(taskId: string, run: (signal: AbortSignal) => Promise<LlmResult | ToolResult>): void {
    const controller = new AbortController();
    const entry: InFlight = { taskId, controller, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        const result = await run(controller.signal);
        this.#deliver(taskId, result);
      } catch (err) {
        this.#logger.error(`Task ${taskId} failed unexpectedly: ${errorMessage(err)}`);
        this.#deliver(taskId, { status: "error", error: errorMessage(err) });
      } finally {
        this.#inFlight.delete(entry);
      }
    })();
    this.#inFlight.add(entry);
  }

  #deliver(taskId: string, result: LlmResult | ToolResult): void {
    const channel = this.#channel;
    if (channel?.state !== "joined") {
      this.#logger.warn(
        `Could not deliver result for task ${taskId} (not joined); Norns re-dispatches it on reconnect`,
      );
      return;
    }
    channel
      .push("tool_result", { ...result, task_id: taskId })
      .receive("error", (resp) =>
        this.#logger.warn(`Server rejected result for ${taskId}: ${errorMessage(resp)}`),
      );
  }

  async #runLlm(task: LlmTask, signal: AbortSignal): Promise<LlmResult> {
    const model = task.model ?? "?";
    const tools = task.tools ?? [];
    this.#logger.info(
      `LLM call → ${model} (${task.messages?.length ?? 0} messages, ${tools.length} tools)`,
    );
    const result = await this.#callModel(task, signal);
    this.#logger.info(
      `LLM done → ${result.status === "ok" ? result.finish_reason : `error: ${result.error}`}`,
    );
    return result;
  }

  async #callModel(task: LlmTask, signal: AbortSignal): Promise<LlmResult> {
    try {
      const model = await this.#resolveModel(
        task.model ?? this.#agents[0]?.model ?? "claude-sonnet-5",
      );

      if (task.purpose === "compact") {
        // Fold the history into a summary Norns carries forward without reading.
        const result = await generateText({
          model,
          instructions: toInstructions(composeCompactionPrompt(task)),
          messages: toModelMessages(compactionMessages(task)),
          maxOutputTokens: maxTokens(task),
          abortSignal: signal,
        });
        const out = fromGenerateResult(result);
        return {
          status: "ok",
          content: out.content,
          finish_reason: "stop",
          usage: out.usage,
          model: out.model,
        };
      }

      // Norns sends the def's prompt verbatim and never writes prose for the
      // model: the worker composes the prompt, renders kinded messages,
      // elides old tool results, and decides the final output.
      const neutral = messagesForTask(task);
      const toolSet = toToolSet(task.tools ?? []);
      const result = await generateText({
        model,
        instructions: toInstructions(composeSystemPrompt(task)),
        messages: toModelMessages(neutral),
        tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
        maxOutputTokens: maxTokens(task),
        abortSignal: signal,
      });
      const out = fromGenerateResult(result);
      out.final_output = finalOutput(neutral, out.content);
      return out;
    } catch (err) {
      this.#logger.error(`LLM error: ${errorMessage(err)}`);
      return { status: "error", error: errorMessage(err) };
    }
  }

  async #runTool(task: ToolTask, signal: AbortSignal): Promise<ToolResult> {
    const name = task.tool_name ?? "?";
    this.#logger.info(`Tool call → ${name}`);
    const result = await this.#executeTool(task, signal);
    const preview = (result.status === "ok" ? result.result : result.error).slice(0, 80);
    this.#logger.info(`Tool done → ${name}: ${result.status} ${preview}`);
    return result;
  }

  // A key on the task means Norns considers the call side-effecting and has
  // named it. It cannot know whether the effect landed, so if the result
  // never reached it, it asks again; this worker answers from what it kept
  // rather than doing the thing twice.
  async #executeTool(task: ToolTask, signal: AbortSignal): Promise<ToolResult> {
    const key = task.idempotency_key;
    const completed = this.#completed;
    if (key && completed?.has(key)) {
      this.#logger.info(`Tool ${task.tool_name}: already done (${key}), reusing the result`);
      return completed.get(key) as ToolResult;
    }

    const tool = this.#tools.get(task.tool_name);
    if (!tool) return { status: "error", error: `Unknown tool: ${task.tool_name}` };

    let input: unknown = task.input ?? {};
    if (tool.validate) {
      const checked = await tool.validate(input);
      if (!checked.success) {
        return {
          status: "error",
          error: `Invalid input for ${tool.name}: ${checked.error.message}`,
        };
      }
      input = checked.value;
    }

    const context: ToolContext = {
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      idempotencyKey: key,
      signal,
      worker: this,
    };

    try {
      const output = await tool.execute(input, context);
      const result: ToolResult = { status: "ok", result: stringifyToolOutput(output) };
      if (key) completed?.add(key, { ...result, duplicate: true });
      return result;
    } catch (err) {
      this.#logger.error(`Tool ${tool.name} failed: ${errorMessage(err)}`);
      // Failures are not remembered: a retry of something that did not happen should happen.
      return { status: "error", error: errorMessage(err) };
    }
  }

  // --- Lifecycle plumbing ---

  #abortInFlight(reason: string): void {
    for (const t of this.#inFlight) t.controller.abort(new NornsError(reason));
  }

  // Forced off: a fatal join, a destroyed gard. Nothing to drain.
  #fail(err: unknown): void {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#abortInFlight("worker stopped");
    this.#teardown();
    this.#socket?.disconnect();
    this.#settleStopped.reject(err);
  }

  #teardown(): void {
    if (this.#signalHandler) {
      process.off("SIGINT", this.#signalHandler);
      process.off("SIGTERM", this.#signalHandler);
      this.#signalHandler = undefined;
    }
  }

  #installSignalHandlers(): void {
    if (!this.#handleSignals) return;
    this.#signalHandler = (signal) => {
      if (this.#state !== "running") {
        this.#logger.warn(`Received ${signal} again: exiting now`);
        process.exit(130);
      }
      this.#logger.info(`Received ${signal}: shutting down`);
      void this.stop();
    };
    process.on("SIGINT", this.#signalHandler);
    process.on("SIGTERM", this.#signalHandler);
  }
}
