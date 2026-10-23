import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NornsApiError,
  NornsClient,
  NornsTimeoutError,
  NotFoundError,
  StreamClosedError,
  type StreamEvent,
} from "../src/index.js";
import { FakeWebSocket, fakeNornsApi, waitFor } from "./fakes.js";

const bot = {
  id: 7,
  name: "support-bot",
  model: "claude-sonnet-5",
  inserted_at: "2026-10-15T00:00:00Z",
};

function makeClient(api = fakeNornsApi([bot])) {
  const client = new NornsClient({
    url: "http://norns.test/",
    apiKey: "nrn_test",
    fetch: api.fetch,
    transport: FakeWebSocket,
    socketOptions: {
      heartbeatIntervalMs: 60_000,
      reconnectAfterMs: () => 10,
      rejoinAfterMs: () => 10,
    },
  });
  return { client, api };
}

describe("NornsClient configuration", () => {
  it("falls back to the environment and strips a trailing slash", () => {
    process.env.NORNS_URL = "http://env.test/";
    process.env.NORNS_API_KEY = "nrn_env";
    try {
      expect(new NornsClient().url).toBe("http://env.test");
    } finally {
      delete process.env.NORNS_URL;
      delete process.env.NORNS_API_KEY;
    }
  });

  it("refuses to start without a URL or key", () => {
    const url = process.env.NORNS_URL;
    const key = process.env.NORNS_API_KEY;
    delete process.env.NORNS_URL;
    delete process.env.NORNS_API_KEY;
    try {
      expect(() => new NornsClient({ apiKey: "k" })).toThrow(/NORNS_URL/);
      expect(() => new NornsClient({ url: "http://x" })).toThrow(/NORNS_API_KEY/);
    } finally {
      if (url !== undefined) process.env.NORNS_URL = url;
      if (key !== undefined) process.env.NORNS_API_KEY = key;
    }
  });
});

describe("agents", () => {
  it("lists and resolves by name or id", async () => {
    const { client } = makeClient();
    expect((await client.agents.list()).map((a) => a.name)).toEqual(["support-bot"]);
    expect((await client.agents.get("support-bot")).id).toBe(7);
    expect((await client.agents.get(7)).name).toBe("support-bot");
    await expect(client.agents.get("nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.agents.get(99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sends the bearer token", async () => {
    let auth: string | null = null;
    const client = new NornsClient({
      url: "http://x",
      apiKey: "nrn_secret",
      fetch: (async (_input: unknown, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization");
        return new Response('{"data":[]}', { status: 200 });
      }) as typeof fetch,
    });
    await client.agents.list();
    expect(auth).toBe("Bearer nrn_secret");
  });
});

describe("sendMessage", () => {
  it("posts the message and returns the run id at once", async () => {
    const { client, api } = makeClient();
    const result = await client.sendMessage("support-bot", "Hello", {
      conversationKey: "slack:U1",
    });
    expect(result).toEqual({
      runId: 100,
      status: "accepted",
      output: null,
      conversationKey: "slack:U1",
      isWaiting: false,
      waitingFor: null,
    });
    const post = api.requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/v1/agents/7/messages");
    expect(post?.body).toEqual({ content: "Hello", conversation_key: "slack:U1" });
  });

  it("with wait, polls until the run completes", async () => {
    const { client, api } = makeClient();
    const pending = client.sendMessage(7, "Hello", { wait: true, timeoutMs: 5000 });
    await waitFor(() => api.runs.size === 1);
    const run = api.runs.get(100) as Record<string, unknown>;
    setTimeout(() => Object.assign(run, { status: "completed", output: "Hi there" }), 50);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("Hi there");
  });

  it("with wait, stops when the agent parks on a question", async () => {
    const { client, api } = makeClient();
    const pending = client.sendMessage(7, "Book it", { wait: true });
    await waitFor(() => api.runs.size === 1);
    Object.assign(api.runs.get(100) as object, {
      status: "waiting",
      waiting_for: {
        question: "7pm or 8pm?",
        tool_call_id: "tc_1",
        asked_at: "2026-10-15T00:00:01Z",
      },
    });
    const result = await pending;
    expect(result.isWaiting).toBe(true);
    expect(result.waitingFor).toEqual({
      question: "7pm or 8pm?",
      toolCallId: "tc_1",
      askedAt: "2026-10-15T00:00:01Z",
    });

    await client.runs.reply(100, "7pm");
    expect(api.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v1/runs/100/reply",
      body: { answer: "7pm" },
    });
  });

  it("with wait, times out", async () => {
    const { client } = makeClient();
    await expect(
      client.sendMessage(7, "Hello", { wait: true, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(NornsTimeoutError);
  });
});

describe("runs", () => {
  it("parses a run into camelCase", async () => {
    const { client, api } = makeClient();
    api.runs.set(1, {
      id: 1,
      agent_id: 7,
      conversation_id: 3,
      parent_run_id: null,
      status: "completed",
      trigger_type: "message",
      input: { user_message: "hi" },
      output: "done",
      waiting_for: null,
      input_tokens: 12,
      output_tokens: 3,
      cost: { usd: "0.0012", unpriced: false },
      inserted_at: "a",
      updated_at: "b",
    });
    const run = await client.runs.get(1);
    expect(run).toMatchObject({
      id: 1,
      agentId: 7,
      conversationId: 3,
      status: "completed",
      output: "done",
      waitingFor: null,
      inputTokens: 12,
      cost: { usd: "0.0012", unpriced: false },
      insertedAt: "a",
      updatedAt: "b",
    });
  });

  it("filters the list by status and agent", async () => {
    const { client, api } = makeClient();
    api.runs.set(1, { id: 1, agent_id: 7, status: "waiting", inserted_at: "a" });
    api.runs.set(2, { id: 2, agent_id: 8, status: "waiting", inserted_at: "a" });
    api.runs.set(3, { id: 3, agent_id: 7, status: "completed", inserted_at: "a" });
    expect((await client.runs.list({ status: "waiting", agentId: 7 })).map((r) => r.id)).toEqual([
      1,
    ]);
    // The server does the filtering; the params go on the wire.
    expect(api.requests.at(-1)?.path).toBe("/api/v1/runs");
    expect(api.requests.at(-1)?.query).toBe("?limit=50&status=waiting&agent_id=7");

    await client.runs.list();
    expect(api.requests.at(-1)?.query).toBe("?limit=50");
  });

  it("surfaces API errors with their message", async () => {
    const { client, api } = makeClient();
    api.scripted.set("POST /api/v1/runs/5/reply", [
      { status: 409, body: { error: "run is not waiting for input" } },
    ]);
    const err = await client.runs.reply(5, "x").catch((e) => e);
    expect(err).toBeInstanceOf(NornsApiError);
    expect(err.status).toBe(409);
    expect(err.message).toContain("run is not waiting for input");
  });
});

describe("stream", () => {
  beforeEach(() => FakeWebSocket.reset());
  afterEach(() => FakeWebSocket.reset());

  it("joins the agent channel and yields this run's events until it completes", async () => {
    const { client } = makeClient();
    const seen: StreamEvent[] = [];
    const done = (async () => {
      for await (const event of client.stream("support-bot", "Research this")) seen.push(event);
    })();

    await waitFor(
      () =>
        FakeWebSocket.instances.length === 1 && FakeWebSocket.last.events().includes("phx_join"),
    );
    const ws = FakeWebSocket.last;
    expect(ws.url).toContain("/socket/websocket?token=nrn_test&vsn=2.0.0");
    expect(ws.sent[0]?.[2]).toBe("agent:7");
    expect(ws.sent[0]?.[4]).toEqual({ run_id: 100 });

    ws.push("agent_started", { run_id: 100, agent_id: 7 }, "agent:7");
    ws.push("tool_call", { run_id: 999, agent_id: 7, name: "other" }, "agent:7");
    ws.push("completed", { run_id: 100, agent_id: 7, output: "Found it" }, "agent:7");
    await done;

    expect(seen.map((e) => e.type)).toEqual(["agent_started", "completed"]);
    expect(seen[1]?.data).toMatchObject({ output: "Found it" });
    expect(ws.closed).toBe(true);
  });

  it("fails when the socket closes before the run finishes", async () => {
    const { client } = makeClient();
    const iterate = (async () => {
      for await (const _ of client.stream(7, "x")) {
        // nothing
      }
    })();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    FakeWebSocket.last.drop();
    await expect(iterate).rejects.toBeInstanceOf(StreamClosedError);
  });

  it("stops on an idle timeout", async () => {
    const { client } = makeClient();
    const iterate = (async () => {
      for await (const _ of client.stream(7, "x", { idleTimeoutMs: 30 })) {
        // nothing
      }
    })();
    await expect(iterate).rejects.toBeInstanceOf(NornsTimeoutError);
  });

  it("watches an existing run", async () => {
    const { client, api } = makeClient();
    api.runs.set(42, { id: 42, agent_id: 7, status: "running", inserted_at: "a" });
    const seen: string[] = [];
    const done = (async () => {
      for await (const event of client.runs.watch(42)) seen.push(event.type);
    })();
    await waitFor(
      () =>
        FakeWebSocket.instances.length === 1 && FakeWebSocket.last.events().includes("phx_join"),
    );
    FakeWebSocket.last.push("error", { run_id: 42, agent_id: 7, error: "boom" }, "agent:7");
    await done;
    expect(seen).toEqual(["error"]);
  });
});
