# Changelog

All notable changes to `norns-sdk` are documented in this file.

## [0.1.0] - Unreleased

### Added
- `NornsWorker`: connects over Phoenix Channels (phoenix.js), registers agents
  and tools, serves `llm_task` and `tool_task`, reconnects and rejoins on its
  own. LLM calls go through the AI SDK, with the provider inferred from the
  model name or supplied via `models`. Gard claims, `registerPort()`, drain on
  SIGTERM/SIGINT or `stop()`, and on-disk idempotency memory for
  side-effecting calls.
- `tool()`: Zod-typed tools. The JSON Schema is derived from the schema,
  `execute` receives the parsed input, and invalid input is reported to the
  model as an error. Raw JSON Schema and `jsonSchema<T>()` work too.
- `defineAgent()`: a checked agent definition with every policy Norns
  supports (`allowedTools`, `subagents`, `subagentConversation`,
  `contextPolicy`, `maxTokens`).
- `NornsClient`: `sendMessage()` with `wait`, `stream()` and `runs.watch()`
  as async iterables of typed events, `runs`, `agents` and `conversations`
  resources, `runs.reply()` for parked runs. camelCase responses and typed
  errors.
