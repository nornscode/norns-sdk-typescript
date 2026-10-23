import type { ToolDefinition } from "./tool.js";

/** @deprecated Norns never read it; a conversation starts from a `conversationKey` on the message. */
export type AgentMode = "task" | "conversation";
export type CheckpointPolicy = "every_step" | "on_tool_call" | "manual";
export type ContextStrategy = "sliding_window" | "none";
export type OnFailure = "stop" | "retry_last_step";
export type SubagentConversation = "per_launch" | "per_parent";

/** Fold older history into a summary once a response reports `compactAt` input tokens. */
export interface ContextPolicy {
  compactAt: number;
  /** Messages kept verbatim after the fold. */
  keep: number;
}

/** What this agent may do with `launch_agent` and `list_agents`. */
export interface SubagentPolicy {
  mode?: "open" | "allowlist" | "disabled";
  allowedAgents?: string[];
  allowListAgents?: boolean;
  maxDepth?: number;
}

export interface AgentOptions {
  name: string;
  /** Shown to other agents by `list_agents`. */
  purpose?: string;
  /**
   * The model name as the provider knows it, e.g. `"claude-sonnet-5"`,
   * `"gpt-4o"`. Prefix it (`"openai/gpt-4o"`) to pin the provider.
   */
  model?: string;
  systemPrompt?: string;
  /** What this worker serves for the agent (see `allowedTools` for what it is offered). */
  tools?: ToolDefinition[];
  /** @deprecated Ignored. Norns never read it; send a message with a `conversationKey` instead. */
  mode?: AgentMode;
  checkpointPolicy?: CheckpointPolicy;
  contextStrategy?: ContextStrategy;
  contextWindow?: number;
  maxSteps?: number;
  onFailure?: OnFailure;
  /** Pair with `contextStrategy: "none"`; the summarisation is served by this worker. */
  contextPolicy?: ContextPolicy;
  /**
   * The ceiling on one response, not on the history. Unset leaves it to the
   * worker (8192). Raise it for an agent whose turns are long.
   */
  maxTokens?: number;
  /**
   * Names from `tools` this agent is offered. Unset offers every tool
   * registered in the tenant, other agents' included. Built-ins (`ask_human`,
   * `wait`, `launch_agent`, `list_agents`) are never filtered.
   */
  allowedTools?: string[];
  subagents?: SubagentPolicy;
  /** When launched by another agent: a fresh conversation per launch, or one per parent. */
  subagentConversation?: SubagentConversation;
}

/** A complete agent definition: `defineAgent()`'s result. */
export interface AgentDefinition {
  readonly name: string;
  readonly purpose: string | undefined;
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly checkpointPolicy: CheckpointPolicy;
  readonly contextStrategy: ContextStrategy;
  readonly contextWindow: number;
  readonly maxSteps: number;
  readonly onFailure: OnFailure;
  readonly contextPolicy: ContextPolicy | undefined;
  readonly maxTokens: number | undefined;
  readonly allowedTools: readonly string[] | undefined;
  readonly subagents: SubagentPolicy | undefined;
  readonly subagentConversation: SubagentConversation | undefined;
}

export const DEFAULT_MODEL = "claude-sonnet-5";

const SUBAGENT_CONVERSATIONS: readonly string[] = ["per_launch", "per_parent"];

/**
 * Define an agent. Defaults are filled in and the combination is checked
 * here, so a mistake fails where it was written rather than on the server.
 */
export function defineAgent(options: AgentOptions): AgentDefinition {
  const name = options.name?.trim();
  if (!name) throw new Error("defineAgent(): name is required");

  const tools = options.tools ?? [];
  const known = new Set(tools.map((t) => t.name));
  if (known.size !== tools.length) {
    throw new Error(`Agent '${name}': tool names must be unique`);
  }

  if (options.allowedTools) {
    const unknown = options.allowedTools.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `Agent '${name}': allowedTools names ${JSON.stringify(unknown)} are not in its tools ` +
          `(${JSON.stringify([...known].sort())}); built-ins are always available and need no entry`,
      );
    }
  }

  if (
    options.subagentConversation !== undefined &&
    !SUBAGENT_CONVERSATIONS.includes(options.subagentConversation)
  ) {
    throw new Error(
      `Agent '${name}': subagentConversation must be one of ${SUBAGENT_CONVERSATIONS.join(", ")}`,
    );
  }

  if (
    options.maxTokens !== undefined &&
    !(Number.isInteger(options.maxTokens) && options.maxTokens > 0)
  ) {
    throw new Error(`Agent '${name}': maxTokens must be a positive integer`);
  }

  return Object.freeze({
    name,
    purpose: options.purpose,
    model: options.model ?? DEFAULT_MODEL,
    systemPrompt: options.systemPrompt ?? "",
    tools: Object.freeze([...tools]),
    checkpointPolicy: options.checkpointPolicy ?? "on_tool_call",
    contextStrategy: options.contextStrategy ?? "sliding_window",
    contextWindow: options.contextWindow ?? 20,
    maxSteps: options.maxSteps ?? 50,
    onFailure: options.onFailure ?? "retry_last_step",
    contextPolicy: options.contextPolicy,
    maxTokens: options.maxTokens,
    allowedTools: options.allowedTools ? Object.freeze([...options.allowedTools]) : undefined,
    subagents: options.subagents,
    subagentConversation: options.subagentConversation,
  });
}

/**
 * The REST body that creates or updates the agent. Policies go only when
 * set: the update replaces `model_config` whole, so dropping one from the
 * definition drops it on the server too.
 */
export function agentBody(agent: AgentDefinition): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = {
    checkpoint_policy: agent.checkpointPolicy,
    context_strategy: agent.contextStrategy,
    context_window: agent.contextWindow,
    on_failure: agent.onFailure,
    context_policy: agent.contextPolicy
      ? { compact_at: agent.contextPolicy.compactAt, keep: agent.contextPolicy.keep }
      : null,
    max_tokens: agent.maxTokens ?? null,
  };
  if (agent.allowedTools) {
    modelConfig.tools = { mode: "allowlist", allowed_tools: [...agent.allowedTools] };
  }
  if (agent.subagents) {
    const s = agent.subagents;
    const policy: Record<string, unknown> = {};
    if (s.mode !== undefined) policy.mode = s.mode;
    if (s.allowedAgents !== undefined) policy.allowed_agents = [...s.allowedAgents];
    if (s.allowListAgents !== undefined) policy.allow_list_agents = s.allowListAgents;
    if (s.maxDepth !== undefined) policy.max_depth = s.maxDepth;
    modelConfig.subagents = policy;
  }
  if (agent.subagentConversation) {
    modelConfig.subagent_conversation = agent.subagentConversation;
  }

  const body: Record<string, unknown> = {
    name: agent.name,
    system_prompt: agent.systemPrompt,
    status: "idle",
    model: agent.model,
    max_steps: agent.maxSteps,
    model_config: modelConfig,
  };
  if (agent.purpose !== undefined) body.purpose = agent.purpose;
  return body;
}

/**
 * One agent or several, as a list. Names must be unique: the second would
 * overwrite the first on the server.
 */
export function agentList(agents: AgentDefinition | AgentDefinition[]): AgentDefinition[] {
  const items = Array.isArray(agents) ? [...agents] : [agents];
  if (items.length === 0) throw new Error("A worker needs at least one agent");
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const a of items) {
    if (seen.has(a.name)) dupes.add(a.name);
    seen.add(a.name);
  }
  if (dupes.size > 0) {
    throw new Error(
      `Agent names must be unique on one worker: ${JSON.stringify([...dupes].sort())}`,
    );
  }
  return items;
}

/**
 * Every agent's tools, one per name. A tool task names only the tool, so
 * two different tools under one name cannot both be served.
 */
export function toolsByName(agents: AgentDefinition[]): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const owners = new Map<string, string>();
  for (const agent of agents) {
    for (const t of agent.tools) {
      const existing = tools.get(t.name);
      if (existing === undefined) {
        tools.set(t.name, t);
        owners.set(t.name, agent.name);
      } else if (existing !== t) {
        throw new Error(
          `Agents '${owners.get(t.name)}' and '${agent.name}' have different tools named ` +
            `'${t.name}'; tools are dispatched by name, so share one definition or rename one`,
        );
      }
    }
  }
  return tools;
}
