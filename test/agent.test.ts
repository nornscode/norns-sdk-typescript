import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentBody, agentList, toolsByName } from "../src/agent.js";
import { defineAgent, tool } from "../src/index.js";

const search = tool({
  name: "search",
  description: "Search.",
  input: z.object({ q: z.string() }),
  execute: () => "",
});

describe("defineAgent()", () => {
  it("fills in defaults", () => {
    const agent = defineAgent({ name: "bot" });
    expect(agent.model).toBe("claude-sonnet-5");
    expect(agent.onFailure).toBe("retry_last_step");
    expect(agent.maxSteps).toBe(50);
    expect(agent.tools).toEqual([]);
    expect(agent.allowedTools).toBeUndefined();
    expect(agent.subagents).toBeUndefined();
    expect(agent.maxTokens).toBeUndefined();
  });

  it("rejects allowedTools the agent does not have", () => {
    expect(() =>
      defineAgent({ name: "bot", tools: [search], allowedTools: ["search", "nope"] }),
    ).toThrow(/allowedTools names \["nope"\]/);
  });

  it("rejects a bad subagentConversation or maxTokens", () => {
    expect(() => defineAgent({ name: "bot", subagentConversation: "sometimes" as never })).toThrow(
      /subagentConversation/,
    );
    expect(() => defineAgent({ name: "bot", maxTokens: 0 })).toThrow(/maxTokens/);
  });

  it("builds the REST body in wire form", () => {
    const agent = defineAgent({
      name: "lead",
      purpose: "Leads.",
      model: "openai/gpt-4o",
      systemPrompt: "You lead.",
      tools: [search],
      allowedTools: ["search"],
      contextPolicy: { compactAt: 100_000, keep: 10 },
      maxTokens: 16_000,
      subagents: { mode: "allowlist", allowedAgents: ["explore"], maxDepth: 1 },
      subagentConversation: "per_parent",
    });
    expect(agentBody(agent)).toEqual({
      name: "lead",
      purpose: "Leads.",
      system_prompt: "You lead.",
      status: "idle",
      model: "openai/gpt-4o",
      max_steps: 50,
      model_config: {
        checkpoint_policy: "on_tool_call",
        context_strategy: "sliding_window",
        context_window: 20,
        on_failure: "retry_last_step",
        context_policy: { compact_at: 100_000, keep: 10 },
        max_tokens: 16_000,
        tools: { mode: "allowlist", allowed_tools: ["search"] },
        subagents: { mode: "allowlist", allowed_agents: ["explore"], max_depth: 1 },
        subagent_conversation: "per_parent",
      },
    });
  });

  it("leaves unset policies out of the body", () => {
    const body = agentBody(defineAgent({ name: "bot" })) as {
      model_config: Record<string, unknown>;
    };
    expect(body.model_config).not.toHaveProperty("tools");
    expect(body.model_config).not.toHaveProperty("subagents");
    expect(body.model_config.max_tokens).toBeNull();
    expect(body).not.toHaveProperty("purpose");
  });
});

describe("several agents on one worker", () => {
  it("rejects duplicate names", () => {
    expect(() => agentList([defineAgent({ name: "a" }), defineAgent({ name: "a" })])).toThrow(
      /unique/,
    );
    expect(() => agentList([])).toThrow(/at least one/);
  });

  it("unions tools and shares one definition under a name", () => {
    const tools = toolsByName([
      defineAgent({ name: "a", tools: [search] }),
      defineAgent({ name: "b", tools: [search] }),
    ]);
    expect([...tools.keys()]).toEqual(["search"]);
  });

  it("rejects two different tools under one name", () => {
    const other = tool({ name: "search", description: "Other.", execute: () => "" });
    expect(() =>
      toolsByName([
        defineAgent({ name: "a", tools: [search] }),
        defineAgent({ name: "b", tools: [other] }),
      ]),
    ).toThrow(/different tools named 'search'/);
  });
});
