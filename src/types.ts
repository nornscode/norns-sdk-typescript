/** Where a run is: on the way, finished, or parked on a human. */
export type RunStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "error";

/** The question a run is parked on when its status is `"waiting"`. */
export interface WaitingFor {
  question: string;
  toolCallId: string;
  askedAt: string | undefined;
}

export interface Run {
  id: number;
  agentId: number;
  conversationId: number | null;
  parentRunId: number | null;
  gardId: number | null;
  status: RunStatus;
  triggerType: string;
  input: Record<string, unknown>;
  output: string | null;
  /** Present when `status` is `"waiting"`: answer it with `client.runs.reply()`. */
  waitingFor: WaitingFor | null;
  failureMetadata: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  /** Dollars as a decimal string, so nothing rounds them through a float. */
  cost: { usd: string; unpriced: boolean } | null;
  insertedAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: number;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  source: string;
  insertedAt: string;
}

/** An agent as the server describes it. */
export interface AgentInfo {
  id: number;
  name: string;
  purpose: string | null;
  status: string;
  model: string;
  systemPrompt: string;
  maxSteps: number;
  contextStrategy: string;
  contextWindow: number;
  archivedAt: string | null;
  insertedAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: number;
  agentId: number;
  key: string;
  summary: string | null;
  messageCount: number;
  tokenEstimate: number;
  insertedAt: string;
  updatedAt: string;
}

/** What `sendMessage()` returns. */
export interface MessageResult {
  runId: number;
  /** `"accepted"` when not waiting; otherwise the run's status when the wait ended. */
  status: "accepted" | RunStatus;
  output: string | null;
  conversationKey: string | undefined;
  /** The agent is parked on a question and will not move until it is answered. */
  isWaiting: boolean;
  waitingFor: WaitingFor | null;
}

/** Every stream payload carries the run and agent it belongs to. */
interface Tagged {
  run_id: number;
  agent_id: number;
}

/**
 * An event from a run as it happens, keyed by `type`. The two terminal
 * events are `completed` and `error`. Unknown types pass through as
 * `{ type: string, data: object }` so a newer server never breaks a client.
 */
export type StreamEvent =
  | { type: "agent_started"; data: Tagged }
  | {
      type: "llm_response";
      data: Tagged & {
        step: number;
        finish_reason: string;
        content: string;
        tool_calls: Array<{ id: string; name: string; arguments: unknown }> | null;
      };
    }
  | { type: "tool_call"; data: Tagged & { name: string; arguments: unknown } }
  | {
      type: "tool_result";
      data: Tagged & {
        tool_call_id: string;
        name: string;
        content: string;
        [key: string]: unknown;
      };
    }
  | { type: "waiting_for_user"; data: Tagged & { tool_call_id: string; question: string } }
  | { type: "waiting_timer"; data: Tagged & { seconds: number; reason: string | null } }
  | { type: "context_compacted"; data: Tagged & { step: number; dropped: number; kept: number } }
  | { type: "completed"; data: Tagged & { output: string } }
  | { type: "error"; data: Tagged & { error: string } }
  | { type: string; data: Tagged & Record<string, unknown> };

export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["completed", "error"]);
