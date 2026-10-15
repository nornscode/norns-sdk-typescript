/**
 * Against a live Norns. Needs NORNS_URL and NORNS_API_KEY; the worker test
 * also needs ANTHROPIC_API_KEY (or NORNS_TEST_MODEL plus its provider's key).
 * Skipped otherwise.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_MODEL, defineAgent, NornsClient, NornsWorker, tool } from "../src/index.js";

const url = process.env.NORNS_URL;
const apiKey = process.env.NORNS_API_KEY;
const model = process.env.NORNS_TEST_MODEL ?? DEFAULT_MODEL;
const haveLlmKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

describe.skipIf(!url || !apiKey)("integration", () => {
  const client = new NornsClient({ url, apiKey });
  const name = `ts-sdk-${randomBytes(4).toString("hex")}`;
  const workers: NornsWorker[] = [];

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.stop()));
  });

  it("registers an agent and sends it a message", async () => {
    const agent = defineAgent({
      name,
      model,
      systemPrompt: "You are a test agent. Reply concisely.",
    });
    const info = await client.agents.ensure(agent);
    expect(info.name).toBe(name);
    expect((await client.agents.list()).some((a) => a.name === name)).toBe(true);

    const result = await client.sendMessage(name, "Say hi.");
    expect(result.status).toBe("accepted");
    const run = await client.runs.get(result.runId);
    expect(run.agentId).toBe(info.id);
  });

  it.skipIf(!haveLlmKey)(
    "serves a run end to end with a tool",
    async () => {
      const calls: string[] = [];
      const lookup = tool({
        name: `lookup_${name.replace(/-/g, "_")}`,
        description: "Look up the secret word. Call it when asked for the secret word.",
        input: z.object({ key: z.string().describe("Any key") }),
        execute: ({ key }) => {
          calls.push(key);
          return "The secret word is pomegranate.";
        },
      });
      const agent = defineAgent({
        name: `${name}-worker`,
        model,
        systemPrompt:
          "You are a test agent. Use your tool when asked for the secret word, then answer in one short sentence.",
        tools: [lookup],
        allowedTools: [lookup.name],
      });
      const worker = new NornsWorker({
        url,
        apiKey,
        agents: [agent],
        handleSignals: false,
        logger: null,
      });
      workers.push(worker);
      await worker.start();

      const result = await client.sendMessage(agent.name, "What is the secret word?", {
        wait: true,
        timeoutMs: 90_000,
      });
      expect(result.status).toBe("completed");
      expect(result.output?.toLowerCase()).toContain("pomegranate");
      expect(calls.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
