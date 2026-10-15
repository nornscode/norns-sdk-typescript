import { describe, expect, it } from "vitest";
import {
  COMPACTION_INSTRUCTION,
  compactionMessages,
  composeCompactionPrompt,
  composeSystemPrompt,
  elideOldToolResults,
  finalOutput,
  fromGenerateResult,
  maxTokens,
  messagesForTask,
  renderMessage,
  TOOL_RESULT_CAP,
  toInstructions,
  toModelMessages,
  toToolSet,
} from "../src/format.js";

describe("system prompt", () => {
  it("is the def's prompt, then the summary and date from the envelope", () => {
    expect(
      composeSystemPrompt({
        task_id: "t",
        system_prompt: "Be brief.",
        summary: "We met.",
        date: "2026-10-15",
      }),
    ).toBe("Be brief.\n\nSummary of earlier conversation: We met.\n\nCurrent date: 2026-10-15.");
    expect(composeSystemPrompt({ task_id: "t", system_prompt: "P", summary: "", date: null })).toBe(
      "P",
    );
  });

  it("the compaction prompt leaves the date out", () => {
    expect(
      composeCompactionPrompt({ task_id: "t", system_prompt: "P", summary: "S", date: "d" }),
    ).toBe("P\n\nSummary of earlier conversation: S");
  });
});

describe("kinded messages", () => {
  it("renders each kind to plain content and drops the kind", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "timer_completed" }, "Timer completed."],
      [
        { kind: "tool_denied", data: { tool_name: "rm" } },
        "Tool 'rm' is not in this agent's allowed tools.",
      ],
      [
        { kind: "subagent_denied", data: { reason: "disabled" } },
        "This agent is not permitted to launch sub-agents.",
      ],
      [
        { kind: "subagent_denied", data: { reason: "max_depth", max_depth: 2 } },
        "Sub-agent nesting limit reached (max depth 2). Do the work in this agent instead of delegating further.",
      ],
      [
        { kind: "subagent_denied", data: { agent_name: "x" } },
        "Agent 'x' is not in this agent's allowed sub-agents.",
      ],
      [
        { kind: "subagent_completed", data: { run_id: 7 }, content: "done" },
        '{"run_id":7,"status":"completed","output":"done"}',
      ],
      [
        { kind: "subagent_failed", data: { run_id: 7 }, content: "boom" },
        '{"run_id":7,"status":"failed","error":"boom"}',
      ],
      [{ kind: "list_agents", data: { agents: [{ name: "a" }] } }, '[{"name":"a"}]'],
      [
        { kind: "inherited_context", content: { k: 1 } },
        '[Inherited context from parent agent]\n{"k":1}',
      ],
      [{ kind: "something_new", data: { a: 1 } }, '{"a":1}'],
      [{ kind: "something_new", data: { a: 1 }, content: "text" }, "text"],
    ];
    for (const [msg, expected] of cases) {
      const out = renderMessage({ role: "user", ...msg } as never);
      expect(out.content).toBe(expected);
      expect(out).not.toHaveProperty("kind");
      expect(out).not.toHaveProperty("data");
    }
  });

  it("passes plain messages through untouched", () => {
    const msg = { role: "user" as const, content: "hi" };
    expect(renderMessage(msg)).toBe(msg);
  });
});

describe("context cost", () => {
  const long = "x".repeat(TOOL_RESULT_CAP + 50);
  const history = [
    { role: "user" as const, content: "go" },
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [{ id: "1", name: "t", arguments: {} }],
    },
    { role: "tool" as const, tool_call_id: "1", name: "t", content: long },
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [{ id: "2", name: "t", arguments: {} }],
    },
    { role: "tool" as const, tool_call_id: "2", name: "t", content: long },
    { role: "assistant" as const, content: "ok" },
  ];

  it("caps tool results older than the last two messages", () => {
    const out = elideOldToolResults(history);
    expect(out[2]?.content).toBe(`${"x".repeat(TOOL_RESULT_CAP)}...(truncated)`);
    expect(out[4]?.content).toBe(long);
  });

  it("leaves short histories alone", () => {
    const short = history.slice(0, 4);
    expect(elideOldToolResults(short)).toBe(short);
  });

  it("skips elision when Norns manages the context", () => {
    const task = { task_id: "t", messages: history, context_policy: { compact_at: 1, keep: 2 } };
    expect(messagesForTask(task)[2]?.content).toBe(long);
    expect(messagesForTask({ task_id: "t", messages: history })[2]?.content).not.toBe(long);
  });

  it("uses the agent's max_tokens or the default", () => {
    expect(maxTokens({ task_id: "t", max_tokens: 100 })).toBe(100);
    expect(maxTokens({ task_id: "t", max_tokens: null })).toBe(8192);
    expect(maxTokens({ task_id: "t" })).toBe(8192);
  });
});

describe("final output", () => {
  it("keeps the last substantive assistant text when the final turn is empty", () => {
    const messages = [
      { role: "assistant" as const, content: "I'll check." },
      { role: "tool" as const, content: "r" },
      { role: "assistant" as const, content: "   " },
    ];
    expect(finalOutput(messages, "")).toBe("I'll check.");
    expect(finalOutput(messages, "Done.")).toBe("Done.");
    expect(finalOutput([], "")).toBe("");
  });
});

describe("compaction", () => {
  it("renders the folded history and appends the instruction", () => {
    const out = compactionMessages({
      task_id: "t",
      messages: [{ role: "user", kind: "timer_completed" }],
    });
    expect(out).toEqual([
      { role: "user", content: "Timer completed." },
      { role: "user", content: COMPACTION_INSTRUCTION },
    ]);
  });
});

describe("neutral → model messages", () => {
  it("gives the system prompt a cache breakpoint", () => {
    expect(toInstructions("Be brief.")).toEqual({
      role: "system",
      content: "Be brief.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(toInstructions("")).toBeUndefined();
  });

  it("folds consecutive tool results together and marks the newest message", () => {
    const out = toModelMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "sure",
        tool_calls: [
          { id: "a", name: "t", arguments: '{"x":1}' },
          { id: "b", name: "u", arguments: { y: 2 } },
        ],
      },
      { role: "tool", tool_call_id: "a", name: "t", content: "ra" },
      { role: "tool", tool_call_id: "b", name: "u", content: "rb", is_error: true },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "go" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "sure" },
        { type: "tool-call", toolCallId: "a", toolName: "t", input: { x: 1 } },
        { type: "tool-call", toolCallId: "b", toolName: "u", input: { y: 2 } },
      ],
    });
    expect(out[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "t",
          output: { type: "text", value: "ra" },
        },
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "u",
          output: { type: "error-text", value: "rb" },
        },
      ],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("encodes structured user content rather than failing", () => {
    expect(toModelMessages([{ role: "user", content: { opaque: true } }])).toEqual([
      { role: "user", content: '{"opaque":true}', providerOptions: expect.anything() },
    ]);
  });

  it("offers tools by name with their parameters and no execute", () => {
    const set = toToolSet([
      {
        name: "search",
        description: "S",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(Object.keys(set)).toEqual(["search"]);
    expect(set.search).toMatchObject({ description: "S" });
    expect(set.search).not.toHaveProperty("execute");
  });
});

describe("model result → neutral", () => {
  const usage = {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 },
    outputTokens: 7,
    outputTokenDetails: { textTokens: 7, reasoningTokens: undefined },
    totalTokens: 1057,
  };

  it("counts cache reads and writes inside input_tokens and reports each", () => {
    const out = fromGenerateResult({
      text: "hi",
      toolCalls: [],
      finishReason: "stop",
      usage,
      response: { modelId: "m-1" },
    });
    expect(out).toEqual({
      status: "ok",
      content: "hi",
      finish_reason: "stop",
      usage: {
        input_tokens: 1050,
        output_tokens: 7,
        cache_read_tokens: 900,
        cache_write_tokens: 50,
      },
      model: "m-1",
    });
  });

  it("trusts a total that already includes the cache", () => {
    const out = fromGenerateResult({
      text: "",
      toolCalls: [],
      finishReason: "stop",
      usage: { ...usage, inputTokens: 1050 },
      response: { modelId: "" },
    });
    expect(out.usage.input_tokens).toBe(1050);
    expect(out).not.toHaveProperty("model");
  });

  it("maps tool calls and finish reasons", () => {
    const out = fromGenerateResult({
      text: "",
      toolCalls: [{ toolCallId: "c1", toolName: "search", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage,
      response: { modelId: "m" },
    });
    expect(out.finish_reason).toBe("tool_call");
    expect(out.tool_calls).toEqual([{ id: "c1", name: "search", arguments: { q: "x" } }]);
    expect(
      fromGenerateResult({
        text: "",
        toolCalls: [],
        finishReason: "length",
        usage,
        response: { modelId: "m" },
      }).finish_reason,
    ).toBe("length");
    expect(
      fromGenerateResult({
        text: "",
        toolCalls: [],
        finishReason: "content-filter",
        usage,
        response: { modelId: "m" },
      }).finish_reason,
    ).toBe("stop");
  });
});
