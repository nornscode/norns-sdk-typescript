import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_REMEMBERED_RESULTS } from "../src/completed-calls.js";
import {
  type AgentDefinition,
  defineAgent,
  GardDestroyedError,
  JoinError,
  NornsWorker,
  type NornsWorkerOptions,
  type ToolContext,
  tool,
} from "../src/index.js";
import { FakeWebSocket, fakeNornsApi, mockModel, nextResult, toolTask, waitFor } from "./fakes.js";

const echo = tool({
  name: "echo",
  description: "Echo the input.",
  input: z.object({ text: z.string() }),
  execute: ({ text }) => `echo: ${text}`,
});

function makeWorker(
  agents: AgentDefinition | AgentDefinition[],
  extra: Partial<NornsWorkerOptions> = {},
  api = fakeNornsApi(),
) {
  const worker = new NornsWorker({
    url: "http://norns.test",
    apiKey: "nrn_test",
    agents,
    fetch: api.fetch,
    transport: FakeWebSocket,
    handleSignals: false,
    logger: null,
    stateDir: null,
    models: () => mockModel({ text: "ok" }),
    socketOptions: {
      heartbeatIntervalMs: 60_000,
      reconnectAfterMs: () => 10,
      rejoinAfterMs: () => 10,
    },
    ...extra,
  });
  return { worker, api };
}

beforeEach(() => FakeWebSocket.reset());
afterEach(() => FakeWebSocket.reset());

describe("joining", () => {
  it("registers the agent over REST, then joins with its tools", async () => {
    const agent = defineAgent({ name: "bot", systemPrompt: "Hi.", tools: [echo] });
    const { worker, api } = makeWorker(agent, { workerId: "w1" });
    await worker.start();

    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/agents",
      "POST /api/v1/agents",
    ]);
    expect(api.agents[0]).toMatchObject({
      name: "bot",
      system_prompt: "Hi.",
      model: "claude-sonnet-5",
    });

    const ws = FakeWebSocket.last;
    expect(ws.url).toBe("ws://norns.test/worker/websocket?token=nrn_test&vsn=2.0.0");
    expect(ws.sent[0]?.[2]).toBe("worker:lobby");
    expect(ws.joinPayload()).toEqual({
      worker_id: "w1",
      capabilities: ["llm", "tools"],
      features: ["message_cache"],
      tools: [
        {
          name: "echo",
          description: "Echo the input.",
          input_schema: echo.inputSchema,
          side_effect: false,
        },
      ],
    });
    expect(worker.state).toBe("running");
    await worker.stop();
  });

  it("updates an agent that already exists", async () => {
    const api = fakeNornsApi([{ id: 3, name: "bot", model: "old" }]);
    const { worker } = makeWorker(defineAgent({ name: "bot" }), {}, api);
    await worker.start();
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/agents",
      "PUT /api/v1/agents/3",
    ]);
    expect(api.agents[0]?.model).toBe("claude-sonnet-5");
    await worker.stop();
  });

  it("claims a gard when given one", async () => {
    const { worker } = makeWorker(defineAgent({ name: "bot" }), { gard: 3, claimToken: "tok_x" });
    await worker.start();
    expect(FakeWebSocket.last.joinPayload()).toMatchObject({ gard: 3, claim_token: "tok_x" });
    await worker.stop();
  });

  it("serves the union of several agents' tools, and a tools-only capability", async () => {
    const other = tool({ name: "other", description: "O.", execute: () => "" });
    const { worker } = makeWorker(
      [defineAgent({ name: "a", tools: [echo] }), defineAgent({ name: "b", tools: [echo, other] })],
      { capabilities: ["tools"] },
    );
    await worker.start();
    const payload = FakeWebSocket.last.joinPayload() as {
      tools: { name: string }[];
      capabilities: string[];
    };
    expect(payload.tools.map((t) => t.name)).toEqual(["echo", "other"]);
    expect(payload.capabilities).toEqual(["tools"]);
    await worker.stop();
  });

  it("rejects start() on a fatal join error", async () => {
    FakeWebSocket.joinReply = () => ({
      status: "error",
      response: { reason: "invalid_token", code: "gard_claim_failed" },
    });
    const { worker } = makeWorker(defineAgent({ name: "bot" }), { gard: 1, claimToken: "bad" });
    const err = await worker.start().catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.reason).toBe("invalid_token");
    expect(worker.state).toBe("stopped");
    await expect(worker.stopped).rejects.toBe(err);
  });

  it("retries an already_claimed gard until the claim goes through", async () => {
    let attempts = 0;
    FakeWebSocket.joinReply = () =>
      ++attempts < 3
        ? { status: "error", response: { reason: "already_claimed", code: "gard_claim_failed" } }
        : { status: "ok", response: {} };
    const { worker } = makeWorker(defineAgent({ name: "bot" }), { gard: 1, claimToken: "tok" });
    await worker.start();
    expect(attempts).toBe(3);
    await worker.stop();
  });

  it("fails fast on a model nobody can serve", async () => {
    const { worker } = makeWorker(defineAgent({ name: "bot", model: "nope-1" }), {
      models: (id) => {
        throw new Error(`no provider for ${id}`);
      },
    });
    await expect(worker.start()).rejects.toThrow(/no provider for nope-1/);
  });
});

describe("tool tasks", () => {
  it("runs the tool with validated input and reports the result", async () => {
    let ctx: ToolContext | undefined;
    const spy = tool({
      name: "spy",
      description: "S.",
      input: z.object({ n: z.number() }),
      execute: (input, context) => {
        ctx = context;
        return { doubled: input.n * 2 };
      },
    });
    const { worker } = makeWorker(defineAgent({ name: "bot", tools: [spy] }));
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("tool_task", toolTask("t1", "spy", { n: 21 }, { run_id: 9, agent_id: 4 }));
    expect(await nextResult(ws)).toEqual({ task_id: "t1", status: "ok", result: '{"doubled":42}' });
    expect(ctx).toMatchObject({
      taskId: "t1",
      runId: 9,
      agentId: 4,
      idempotencyKey: undefined,
      worker,
    });
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
    await worker.stop();
  });

  it("reports an unknown tool, invalid input, and a thrown error", async () => {
    const boom = tool({
      name: "boom",
      description: "B.",
      execute: () => {
        throw new Error("network went away");
      },
    });
    const { worker } = makeWorker(defineAgent({ name: "bot", tools: [echo, boom] }));
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("tool_task", toolTask("t1", "missing"));
    expect(await nextResult(ws, 0)).toEqual({
      task_id: "t1",
      status: "error",
      error: "Unknown tool: missing",
    });

    ws.push("tool_task", toolTask("t2", "echo", { text: 5 }));
    const invalid = await nextResult(ws, 1);
    expect(invalid.status).toBe("error");
    expect(invalid.error).toMatch(/^Invalid input for echo:/);

    ws.push("tool_task", toolTask("t3", "boom"));
    expect(await nextResult(ws, 2)).toEqual({
      task_id: "t3",
      status: "error",
      error: "network went away",
    });
    await worker.stop();
  });

  it("runs tasks concurrently", async () => {
    const gate: { release?: () => void } = {};
    const slow = tool({
      name: "slow",
      description: "S.",
      execute: () =>
        new Promise<string>((resolve) => {
          gate.release = () => resolve("slow done");
        }),
    });
    const { worker } = makeWorker(defineAgent({ name: "bot", tools: [slow, echo] }));
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("tool_task", toolTask("t1", "slow"));
    ws.push("tool_task", toolTask("t2", "echo", { text: "fast" }));
    expect(await nextResult(ws)).toMatchObject({ task_id: "t2", result: "echo: fast" });
    gate.release?.();
    expect(await nextResult(ws, 1)).toMatchObject({ task_id: "t1", result: "slow done" });
    await worker.stop();
  });
});

describe("LLM tasks", () => {
  const task = {
    task_id: "l1",
    model: "claude-sonnet-5",
    system_prompt: "Be brief.",
    summary: null,
    date: "2026-10-15",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "echo", description: "E.", parameters: echo.inputSchema }],
    max_tokens: 123,
  };

  it("calls the model with the composed prompt and reports a neutral result", async () => {
    const model = mockModel(
      { text: "Hello!" },
      {
        modelId: "claude-sonnet-5-20260101",
        usage: { total: 40, noCache: 10, cacheRead: 30, output: 3 },
      },
    );
    const { worker } = makeWorker(defineAgent({ name: "bot", tools: [echo] }), {
      models: () => model,
    });
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("llm_task", task);
    expect(await nextResult(ws)).toEqual({
      task_id: "l1",
      status: "ok",
      content: "Hello!",
      finish_reason: "stop",
      usage: { input_tokens: 40, output_tokens: 3, cache_read_tokens: 30 },
      model: "claude-sonnet-5-20260101",
      final_output: "Hello!",
    });

    const call = model.doGenerateCalls[0];
    expect(call?.maxOutputTokens).toBe(123);
    expect(call?.prompt[0]).toMatchObject({
      role: "system",
      content: "Be brief.\n\nCurrent date: 2026-10-15.",
    });
    expect(call?.prompt[1]).toMatchObject({ role: "user" });
    expect(call?.tools?.map((t) => t.name)).toEqual(["echo"]);
    await worker.stop();
  });

  it("reports tool calls with parsed arguments", async () => {
    const model = mockModel({
      toolCalls: [{ id: "c1", name: "echo", input: { text: "x" } }],
      text: "Calling.",
    });
    const { worker } = makeWorker(defineAgent({ name: "bot", tools: [echo] }), {
      models: () => model,
    });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("llm_task", task);
    expect(await nextResult(ws)).toMatchObject({
      status: "ok",
      finish_reason: "tool_call",
      content: "Calling.",
      tool_calls: [{ id: "c1", name: "echo", arguments: { text: "x" } }],
      final_output: "Calling.",
    });
    await worker.stop();
  });

  it("serves a compaction task as a summary", async () => {
    const model = mockModel({ text: "We discussed X." });
    const { worker } = makeWorker(defineAgent({ name: "bot" }), { models: () => model });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("llm_task", { ...task, purpose: "compact", tools: [] });
    const result = await nextResult(ws);
    expect(result).toMatchObject({
      status: "ok",
      content: "We discussed X.",
      finish_reason: "stop",
    });
    expect(result).not.toHaveProperty("final_output");
    const prompt = model.doGenerateCalls[0]?.prompt;
    expect(prompt?.[0]).toMatchObject({ role: "system", content: "Be brief." });
    expect(prompt?.at(-1)).toMatchObject({ role: "user" });
    await worker.stop();
  });

  it("reports a provider failure as an error result", async () => {
    const { worker } = makeWorker(defineAgent({ name: "bot" }), {
      models: () => mockModel({ text: "" }),
    });
    await worker.start();
    const ws = FakeWebSocket.last;
    // A model the resolver does not know about: the failure is the task's, not the worker's.
    const failing = makeWorker(defineAgent({ name: "bot2" }), {
      models: (id) => {
        if (id === "claude-sonnet-5") return mockModel({ text: "" });
        throw new Error(`cannot serve ${id}`);
      },
    });
    await worker.stop();
    await failing.worker.start();
    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws);
    ws2.push("llm_task", { ...task, model: "gpt-9" });
    expect(await nextResult(ws2)).toEqual({
      task_id: "l1",
      status: "error",
      error: "cannot serve gpt-9",
    });
    await failing.worker.stop();
  });
});

describe("idempotency", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "norns-sdk-test-"));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  function charging() {
    const charges: number[] = [];
    const charge = tool({
      name: "charge_card",
      description: "Take money.",
      sideEffect: true,
      input: z.object({ amount: z.number() }),
      execute: ({ amount }) => {
        charges.push(amount);
        return `charged ${amount}`;
      },
    });
    return { charges, agent: defineAgent({ name: "t", tools: [charge] }) };
  }

  it("the same key twice charges once", async () => {
    const { charges, agent } = charging();
    const { worker } = makeWorker(agent, { stateDir });
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("tool_task", toolTask("t1", "charge_card", { amount: 10 }, { idempotency_key: "k1" }));
    const first = await nextResult(ws, 0);
    // The result never reached Norns, so it asks again. Same call, same key.
    ws.push("tool_task", toolTask("t2", "charge_card", { amount: 10 }, { idempotency_key: "k1" }));
    const second = await nextResult(ws, 1);

    expect(first).toEqual({ task_id: "t1", status: "ok", result: "charged 10" });
    expect(second).toEqual({ task_id: "t2", status: "ok", result: "charged 10", duplicate: true });
    expect(charges).toEqual([10]);
    await worker.stop();
  });

  it("without a key, nothing is remembered", async () => {
    const { charges, agent } = charging();
    const { worker } = makeWorker(agent, { stateDir });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("tool_task", toolTask("t1", "charge_card", { amount: 10 }));
    await nextResult(ws, 0);
    ws.push("tool_task", toolTask("t2", "charge_card", { amount: 10 }));
    expect(await nextResult(ws, 1)).not.toHaveProperty("duplicate");
    expect(charges).toEqual([10, 10]);
    await worker.stop();
  });

  it("a failure is not remembered", async () => {
    let attempts = 0;
    const flaky = tool({
      name: "flaky",
      description: "Fail once.",
      sideEffect: true,
      execute: () => {
        if (++attempts === 1) throw new Error("network went away");
        return "ok";
      },
    });
    const { worker } = makeWorker(defineAgent({ name: "t", tools: [flaky] }), { stateDir });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("tool_task", toolTask("t1", "flaky", {}, { idempotency_key: "k1" }));
    expect((await nextResult(ws, 0)).status).toBe("error");
    ws.push("tool_task", toolTask("t2", "flaky", {}, { idempotency_key: "k1" }));
    const second = await nextResult(ws, 1);
    expect(second.status).toBe("ok");
    expect(second).not.toHaveProperty("duplicate");
    expect(attempts).toBe(2);
    await worker.stop();
  });

  it("the memory is bounded", async () => {
    const { agent } = charging();
    const { worker } = makeWorker(agent, { stateDir });
    await worker.start();
    const ws = FakeWebSocket.last;
    const n = MAX_REMEMBERED_RESULTS + 10;
    for (let i = 0; i < n; i++) {
      ws.push(
        "tool_task",
        toolTask(`t${i}`, "charge_card", { amount: 1 }, { idempotency_key: `k${i}` }),
      );
    }
    await waitFor(() => ws.results().length === n, 10_000);
    // The oldest key has been forgotten: a dispatch under it runs again.
    ws.push(
      "tool_task",
      toolTask("again", "charge_card", { amount: 1 }, { idempotency_key: "k0" }),
    );
    expect(await nextResult(ws, n)).not.toHaveProperty("duplicate");
    ws.push(
      "tool_task",
      toolTask("again2", "charge_card", { amount: 1 }, { idempotency_key: `k${n - 1}` }),
    );
    expect(await nextResult(ws, n + 1)).toHaveProperty("duplicate", true);
    await worker.stop();
  }, 20_000);

  it("the memory outlives the worker", async () => {
    const { charges, agent } = charging();
    const first = makeWorker(agent, { stateDir, workerId: "w-same" });
    await first.worker.start();
    FakeWebSocket.last.push(
      "tool_task",
      toolTask("t1", "charge_card", { amount: 10 }, { idempotency_key: "k1" }),
    );
    await nextResult(FakeWebSocket.last);
    await first.worker.stop();

    const second = makeWorker(agent, { stateDir, workerId: "w-same" });
    await second.worker.start();
    FakeWebSocket.last.push(
      "tool_task",
      toolTask("t2", "charge_card", { amount: 10 }, { idempotency_key: "k1" }),
    );
    expect(await nextResult(FakeWebSocket.last)).toMatchObject({
      result: "charged 10",
      duplicate: true,
    });
    expect(charges).toEqual([10]);
    await second.worker.stop();
  });
});

describe("shutdown", () => {
  function slowTool() {
    const state: { started?: () => void; release?: () => void; aborted?: boolean } = {};
    const started = new Promise<void>((r) => {
      state.started = r;
    });
    const slow = tool({
      name: "slow",
      description: "Wait until released.",
      execute: (_input, ctx) =>
        new Promise<string>((resolve) => {
          state.started?.();
          ctx.signal.addEventListener("abort", () => {
            state.aborted = true;
          });
          state.release = () => resolve("finished");
        }),
    });
    return { slow, started, state };
  }

  it("drains in-flight work, then leaves", async () => {
    const { slow, started, state } = slowTool();
    const { worker } = makeWorker(defineAgent({ name: "t", tools: [slow] }), {
      shutdownTimeoutMs: 5000,
    });
    await worker.start();
    const ws = FakeWebSocket.last;

    ws.push("tool_task", toolTask("t1", "slow"));
    await started;
    const stopping = worker.stop();
    await waitFor(() => ws.events().includes("drain"));
    expect(worker.state).toBe("draining");
    expect(ws.events()).not.toContain("phx_leave");
    expect(ws.results()).toHaveLength(0);

    state.release?.();
    await stopping;
    expect(ws.results()[0]).toMatchObject({ task_id: "t1", status: "ok", result: "finished" });
    const events = ws.events();
    expect(events.indexOf("drain")).toBeLessThan(events.indexOf("tool_result"));
    expect(events.indexOf("tool_result")).toBeLessThan(events.indexOf("phx_leave"));
    expect(ws.closed).toBe(true);
    expect(worker.state).toBe("stopped");
    await expect(worker.stopped).resolves.toBeUndefined();
  });

  it("a task arriving during the drain is still served", async () => {
    const { slow, started, state } = slowTool();
    const { worker } = makeWorker(defineAgent({ name: "t", tools: [slow, echo] }), {
      shutdownTimeoutMs: 5000,
    });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("tool_task", toolTask("t1", "slow"));
    await started;
    const stopping = worker.stop();
    await waitFor(() => ws.events().includes("drain"));
    ws.push("tool_task", toolTask("t2", "echo", { text: "late" }));
    state.release?.();
    await stopping;
    expect(
      ws
        .results()
        .map((r) => r.task_id)
        .sort(),
    ).toEqual(["t1", "t2"]);
  });

  it("drops what is still running at the deadline", async () => {
    const { slow, started, state } = slowTool();
    const { worker } = makeWorker(defineAgent({ name: "t", tools: [slow] }), {
      shutdownTimeoutMs: 50,
    });
    await worker.start();
    const ws = FakeWebSocket.last;
    ws.push("tool_task", toolTask("t1", "slow"));
    await started;
    await worker.stop();
    expect(state.aborted).toBe(true);
    expect(ws.results()).toHaveLength(0);
    expect(ws.events()).toContain("phx_leave");
  });

  it("stop() before start() is a no-op, and stop() twice is fine", async () => {
    const { worker } = makeWorker(defineAgent({ name: "t" }));
    await worker.stop();
    expect(worker.state).toBe("stopped");
    await worker.stop();
    expect(() => worker.start()).toThrow(/only be called once/);
  });
});

describe("connection loss", () => {
  it("reconnects and rejoins with the same registration; in-flight work is abandoned", async () => {
    const { slow, started, state } = (() => {
      const s: { started?: () => void; release?: () => void; aborted?: boolean } = {};
      const started = new Promise<void>((r) => {
        s.started = r;
      });
      const slow = tool({
        name: "slow",
        description: "S.",
        execute: (_i, ctx) =>
          new Promise<string>((resolve) => {
            s.started?.();
            ctx.signal.addEventListener("abort", () => {
              s.aborted = true;
            });
            s.release = () => resolve("x");
          }),
      });
      return { slow, started, state: s };
    })();
    const { worker } = makeWorker(defineAgent({ name: "t", tools: [slow] }), { workerId: "w1" });
    await worker.start();
    const first = FakeWebSocket.last;
    first.push("tool_task", toolTask("t1", "slow"));
    await started;

    first.drop();
    await waitFor(
      () =>
        FakeWebSocket.instances.length === 2 && FakeWebSocket.last.events().includes("phx_join"),
    );
    expect(state.aborted).toBe(true);
    expect(FakeWebSocket.last.joinPayload()).toEqual(first.joinPayload());
    await waitFor(() => worker.state === "running");

    state.release?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(first.results()).toHaveLength(0);
    await worker.stop();
  });

  it("stops with GardDestroyedError when the gard is destroyed", async () => {
    const { worker } = makeWorker(defineAgent({ name: "t" }), { gard: 5, claimToken: "tok" });
    await worker.start();
    FakeWebSocket.last.push("gard_destroyed", {});
    await expect(worker.stopped).rejects.toBeInstanceOf(GardDestroyedError);
    expect(worker.state).toBe("stopped");
  });
});

describe("registerPort", () => {
  it("needs a gard", async () => {
    const { worker } = makeWorker(defineAgent({ name: "t" }));
    await worker.start();
    await expect(worker.registerPort(3000)).rejects.toThrow(/gard/);
    await worker.stop();
  });

  it("pushes register_port and maps the reply", async () => {
    const { worker } = makeWorker(defineAgent({ name: "t" }), { gard: 5, claimToken: "tok" });
    await worker.start();
    const ws = FakeWebSocket.last;
    const pending = worker.registerPort(3000, { name: "react", url: "http://localhost:3000" });
    await waitFor(() => ws.events().includes("register_port"));
    expect(ws.sent.at(-1)?.[4]).toEqual({
      internal_port: 3000,
      name: "react",
      protocol: "http",
      url: "http://localhost:3000",
    });
    ws.replyTo("register_port", {
      status: "ok",
      response: { id: 1, internal_port: 3000, url: "http://localhost:3000" },
    });
    expect(await pending).toEqual({ id: 1, internalPort: 3000, url: "http://localhost:3000" });

    const rejected = worker.registerPort(22);
    await waitFor(() => ws.events().filter((e) => e === "register_port").length === 2);
    ws.replyTo("register_port", { status: "error", response: { reason: "scheme not allowed" } });
    await expect(rejected).rejects.toThrow(/scheme not allowed/);
    await worker.stop();
  });
});
