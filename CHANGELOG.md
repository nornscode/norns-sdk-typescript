# Changelog

All notable changes to `norns-sdk` are documented in this file.

## [0.3.0] - 2026-10-22

### Added
- A worker holding a scoped key (`nrnw_...`, issued for one gard's worker)
  skips the agent registration on `start()`, since the key cannot reach the
  REST API; the definitions are registered with a tenant key instead.
  `isScopedKey()` is exported.
- `KeyRevokedError`: `worker.stopped` rejects with it when Norns revokes the
  key the worker joined on.

## [0.2.0] - 2026-10-16

### Added
- The worker joins with `features: ["message_cache"]` and keeps the message
  list Norns last sent it per run, so Norns can send later steps as
  `messages_delta` (the change) instead of the whole history. A delta on a
  base the worker no longer holds is answered with `message_cache_miss` and
  Norns resends in full. Older Norns ignores the feature and sends the full
  list as before.

## [0.1.0] - 2026-10-15

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
