/**
 * The provider-neutral wire format Norns speaks, and its translation to and
 * from the AI SDK. Also the prose the worker writes for the model: Norns
 * never does ("Content is opaque"), so composing the system prompt,
 * rendering kinded messages, eliding old tool results, and choosing the
 * run's final output all happen here.
 */
import {
  tool as aiTool,
  type FinishReason,
  type JSONSchema7,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";

// --- Wire types ---

export interface NeutralToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface NeutralMessage {
  role: "user" | "assistant" | "tool" | "system";
  content?: unknown;
  tool_calls?: NeutralToolCall[];
  tool_call_id?: string;
  name?: string;
  is_error?: boolean;
  /** Set on messages Norns resolved itself; the worker renders them. */
  kind?: string;
  data?: Record<string, unknown>;
}

export interface NeutralTool {
  name: string;
  description?: string;
  parameters?: JSONSchema7;
  input_schema?: JSONSchema7;
}

export interface LlmTask {
  task_id: string;
  purpose?: "compact";
  model?: string;
  system_prompt?: string | null;
  summary?: string | null;
  date?: string | null;
  messages?: NeutralMessage[];
  /** In place of `messages` once this worker holds the run's history (see HistoryCache). */
  messages_delta?: { base_count: number; drop: number; append: NeutralMessage[] };
  tools?: NeutralTool[];
  context_policy?: unknown;
  max_tokens?: number | null;
  agent_id?: number;
  run_id?: number;
  step?: number;
}

export interface ToolTask {
  task_id: string;
  tool_name: string;
  input?: Record<string, unknown>;
  agent_id?: number;
  run_id?: number;
  idempotency_key?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type NeutralFinishReason = "stop" | "tool_call" | "length" | "error";

export type LlmResult =
  | {
      status: "ok";
      content: string;
      finish_reason: NeutralFinishReason;
      usage: Usage;
      tool_calls?: NeutralToolCall[];
      model?: string;
      final_output?: string;
    }
  | { status: "error"; error: string };

export type ToolResult =
  | { status: "ok"; result: string; duplicate?: true }
  | { status: "error"; error: string };

// --- Prompt composition ---

/**
 * The prompt the model sees: the def's prompt verbatim, then the
 * conversation summary and the date the orchestrator put in the envelope.
 */
export function composeSystemPrompt(task: LlmTask): string {
  let prompt = task.system_prompt ?? "";
  if (typeof task.summary === "string" && task.summary !== "") {
    prompt += `\n\nSummary of earlier conversation: ${task.summary}`;
  }
  if (task.date) prompt += `\n\nCurrent date: ${task.date}.`;
  return prompt;
}

/** The def's prompt (so the summary is written in the agent's voice) plus the earlier summary. */
export function composeCompactionPrompt(task: LlmTask): string {
  let prompt = task.system_prompt ?? "";
  if (typeof task.summary === "string" && task.summary !== "") {
    prompt += `\n\nSummary of earlier conversation: ${task.summary}`;
  }
  return prompt;
}

export const COMPACTION_INSTRUCTION =
  "Write a summary of the conversation so far for your own future reference. " +
  "You will continue the same task with only this summary and the most recent " +
  "messages, so keep every fact you would need: the task and its constraints, " +
  "decisions made and why, files and identifiers touched, what was tried and " +
  "failed, what remains to be done, and anything the user asked for that is not " +
  "finished. Fold in the earlier summary if there is one. Write prose or terse " +
  "notes, no preamble, no commentary about summarising.";

/** The folded history, rendered, then the instruction. */
export function compactionMessages(task: LlmTask): NeutralMessage[] {
  return [
    ...renderMessages(task.messages ?? []),
    { role: "user", content: COMPACTION_INSTRUCTION },
  ];
}

// --- Kinded messages ---

/** Render a message Norns resolved itself to plain content. Others pass through. */
export function renderMessage(msg: NeutralMessage): NeutralMessage {
  if (!msg.kind) return msg;
  const { kind, data, ...rest } = msg;
  return { ...rest, content: renderKind(kind, data ?? {}, msg.content) };
}

export function renderMessages(messages: NeutralMessage[]): NeutralMessage[] {
  return messages.map(renderMessage);
}

function renderKind(kind: string, data: Record<string, unknown>, content: unknown): string {
  switch (kind) {
    case "inherited_context":
      return `[Inherited context from parent agent]\n${encode(content)}`;
    case "timer_completed":
      return "Timer completed.";
    case "tool_denied":
      return `Tool '${data.tool_name}' is not in this agent's allowed tools.`;
    case "subagent_denied":
      if (data.reason === "disabled") return "This agent is not permitted to launch sub-agents.";
      if (data.reason === "max_depth") {
        return (
          `Sub-agent nesting limit reached (max depth ${data.max_depth}). ` +
          "Do the work in this agent instead of delegating further."
        );
      }
      return `Agent '${data.agent_name}' is not in this agent's allowed sub-agents.`;
    case "subagent_list_denied":
      return "Listing agents is not permitted for this agent.";
    case "subagent_not_found":
      return `Agent '${data.agent_name}' not found`;
    case "subagent_self":
      return "Cannot launch self as a sub-agent";
    case "subagent_missing":
      return `Sub-agent run ${data.run_id} no longer exists, so its result cannot be recovered.`;
    case "subagent_busy":
      return (
        `Agent '${data.agent_name}' is still working on an earlier task for this ` +
        "conversation. Wait for its result before giving it another."
      );
    case "subagent_launch_failed":
      return `Failed to launch agent '${data.agent_name}': ${data.reason}`;
    case "subagent_completed":
      return JSON.stringify({ run_id: data.run_id, status: "completed", output: content ?? "" });
    case "subagent_failed":
      return JSON.stringify({ run_id: data.run_id, status: "failed", error: content ?? "" });
    case "list_agents":
      return JSON.stringify(data.agents ?? []);
    default:
      return content === undefined || content === null || content === ""
        ? encode(data)
        : encode(content);
  }
}

function encode(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

// --- Context cost ---

/** Chars kept of a tool result once it has aged out of the last two messages. */
export const TOOL_RESULT_CAP = 200;

/** Rendered messages, elided unless Norns manages the context itself. */
export function messagesForTask(task: LlmTask): NeutralMessage[] {
  const rendered = renderMessages(task.messages ?? []);
  return task.context_policy ? rendered : elideOldToolResults(rendered);
}

/** Cap tool results older than the last two messages. */
export function elideOldToolResults(messages: NeutralMessage[]): NeutralMessage[] {
  if (messages.length <= 4) return messages;
  const old = messages.slice(0, -2);
  const recent = messages.slice(-2);
  return [
    ...old.map((msg) =>
      msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_RESULT_CAP
        ? { ...msg, content: `${msg.content.slice(0, TOOL_RESULT_CAP)}...(truncated)` }
        : msg,
    ),
    ...recent,
  ];
}

/** One response's ceiling when the agent does not set one. */
export const DEFAULT_MAX_TOKENS = 8192;

export function maxTokens(task: LlmTask): number {
  const v = task.max_tokens;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_TOKENS;
}

/**
 * The run's output when the model stops. A turn can say something
 * substantive alongside a tool call and then end with an empty "stop" turn;
 * fall back to the last non-empty assistant text rather than losing it.
 */
export function finalOutput(messages: NeutralMessage[], content: unknown): string {
  const text = typeof content === "string" ? content : "";
  if (text.trim() !== "") return text;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "") {
      return m.content;
    }
  }
  return text;
}

// --- Neutral → AI SDK ---

const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/**
 * The system prompt as the call's instructions, with a cache breakpoint:
 * a run's prompt is the same on every step. Providers that do not take the
 * hint ignore it.
 */
export function toInstructions(system: string): SystemModelMessage | undefined {
  if (system === "") return undefined;
  return { role: "system", content: system, providerOptions: CACHE_CONTROL };
}

/**
 * The model messages for a call. Consecutive tool results are folded into
 * one tool message, as providers expect them.
 *
 * The newest message carries a cache breakpoint: a run's history only
 * grows between steps, so this call's tail is the next call's prefix and is
 * read back at the cached rate.
 */
export function toModelMessages(messages: NeutralMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    const converted = toModelMessage(msg);
    const last = out[out.length - 1];
    if (converted.role === "tool" && last?.role === "tool") {
      last.content = [...last.content, ...converted.content];
    } else {
      out.push(converted);
    }
  }

  const last = out[out.length - 1];
  if (last) last.providerOptions = CACHE_CONTROL;
  return out;
}

function toModelMessage(msg: NeutralMessage): ModelMessage {
  switch (msg.role) {
    case "system":
      return { role: "system", content: encode(msg.content ?? "") };
    case "assistant": {
      const text = typeof msg.content === "string" ? msg.content : encode(msg.content ?? "");
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) return { role: "assistant", content: text };
      return {
        role: "assistant",
        content: [
          ...(text !== "" ? [{ type: "text" as const, text }] : []),
          ...calls.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: parseArguments(tc.arguments),
          })),
        ],
      };
    }
    case "tool": {
      const value = encode(msg.content ?? "");
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id ?? "",
            toolName: msg.name ?? "",
            output: msg.is_error ? { type: "error-text", value } : { type: "text", value },
          },
        ],
      };
    }
    default:
      // An opaque block this worker holds no key for, or structured content:
      // send it encoded rather than fail the call.
      return { role: "user", content: encode(msg.content ?? "") };
  }
}

function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

/** The tools the model is offered. None has an `execute`: the worker runs them on dispatch. */
export function toToolSet(tools: NeutralTool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      description: t.description ?? "",
      inputSchema: jsonSchema(t.parameters ?? t.input_schema ?? { type: "object", properties: {} }),
    });
  }
  return set;
}

// --- AI SDK → Neutral ---

/** The slice of a `generateText` result this translation reads. */
export interface GenerateLike {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  response: { modelId: string };
}

export function fromGenerateResult(result: GenerateLike): Extract<LlmResult, { status: "ok" }> {
  const out: Extract<LlmResult, { status: "ok" }> = {
    status: "ok",
    content: result.text ?? "",
    finish_reason: neutralFinishReason(result.finishReason, result.toolCalls.length > 0),
    usage: neutralUsage(result.usage),
  };
  // The model that served the call, so Norns can price it from the event.
  if (result.response?.modelId) out.model = result.response.modelId;
  if (result.toolCalls.length > 0) {
    out.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      arguments: tc.input ?? {},
    }));
  }
  return out;
}

function neutralFinishReason(reason: FinishReason, hasToolCalls: boolean): NeutralFinishReason {
  if (hasToolCalls) return "tool_call";
  switch (reason) {
    case "tool-calls":
      return "tool_call";
    case "length":
      return "length";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

/**
 * Norns counts cache reads and writes inside `input_tokens` and wants to know
 * how many of each, since providers price them differently.
 */
function neutralUsage(usage: LanguageModelUsage | undefined): Usage {
  const details = usage?.inputTokenDetails;
  const read = details?.cacheReadTokens ?? 0;
  const write = details?.cacheWriteTokens ?? 0;
  const total = usage?.inputTokens ?? 0;
  const noCache = details?.noCacheTokens;
  const input = noCache !== undefined ? Math.max(total, noCache + read + write) : total;

  const out: Usage = { input_tokens: input, output_tokens: usage?.outputTokens ?? 0 };
  if (read > 0) out.cache_read_tokens = read;
  if (write > 0) out.cache_write_tokens = write;
  return out;
}
