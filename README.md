# norns-sdk

[![CI](https://github.com/nornscode/norns-sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/nornscode/norns-sdk-typescript/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/norns-sdk)](https://www.npmjs.com/package/norns-sdk)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

TypeScript SDK for [Norns](https://github.com/nornscode/norns), the durable agent runtime.

```bash
npm install norns-sdk zod @ai-sdk/anthropic
```

The SDK has two parts. `NornsWorker` connects to Norns, registers your agents, and serves their LLM and tool calls. `NornsClient` sends messages and reads results from application code: your web backend, Slack bot, CLI, whatever.

LLM calls go through the [AI SDK](https://ai-sdk.dev), so any `@ai-sdk/*` provider works; install the one your models need. Norns never sees your API keys. Your worker makes every external call.

## Worker

```ts
import { NornsWorker, defineAgent, tool } from "norns-sdk";
import { z } from "zod";

const searchDocs = tool({
  name: "search_docs",
  description: "Search product documentation.",
  input: z.object({ query: z.string() }),
  execute: async ({ query }) => db.vectorSearch(query),
});

const sendEmail = tool({
  name: "send_email",
  description: "Send an email to a customer.",
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  sideEffect: true,
  execute: async ({ to, subject, body }) => {
    await smtp.send({ to, subject, body });
    return `Email sent to ${to}`;
  },
});

const supportBot = defineAgent({
  name: "support-bot",
  model: "claude-sonnet-5",
  systemPrompt: "You are a customer support agent. Look up docs and help customers.",
  tools: [searchDocs, sendEmail],
  mode: "conversation",
});

const worker = new NornsWorker({ agents: [supportBot] });
await worker.start();
```

`start()` registers the agents over REST, connects over WebSocket, and resolves once Norns has accepted the worker. The open socket keeps the process alive, so the rest of your program can carry on. The URL and key come from `NORNS_URL` and `NORNS_API_KEY`, or pass `url` and `apiKey`. LLM keys come from the provider's own variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...).

### Models

An LLM task names a model, not a provider. By default the worker infers the provider from the name (`claude-*` is Anthropic, `gpt-*` is OpenAI, `gemini-*` is Google, `mistral-*` is Mistral) and loads its `@ai-sdk/*` package. Prefix the model (`"openai/gpt-4o"`) to pin one.

To take over, pass `models`: a provider, a registry from `createProviderRegistry()`, or a function from model name to model.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const worker = new NornsWorker({
  agents: [supportBot],
  models: createAnthropic({ baseURL: process.env.ANTHROPIC_PROXY }),
});
```

A worker with no LLM access at all can still serve tools: `capabilities: ["tools"]`.

### Gards

A [gard](https://github.com/nornscode/norns/blob/main/docs/gards.md) pins all of a run's tool dispatch to one worker: worker affinity for coding agents and other filesystem-bound work. Create one (`nornsctl gards create` prints the claim token once), then claim it:

```ts
const worker = new NornsWorker({ agents: [coder], gard: 3, claimToken: "tok_..." });
```

A worker in a gard serves only runs bound to that gard, and vice versa. Tools can expose service ports for the dashboard; the gard is inferred from the connection:

```ts
execute: async ({ port }, ctx) => {
  await startDevServer(port);
  await ctx.worker.registerPort(port, { name: "react", url: `http://localhost:${port}` });
  return "started";
}
```

A fatally rejected claim (bad token, destroyed gard) rejects `start()` with `JoinError` instead of reconnect-looping. If the gard is destroyed while the worker is connected, `worker.stopped` rejects with `GardDestroyedError`.

A worker inside a gard should hold a [scoped key](https://github.com/nornscode/norns/blob/main/docs/gards.md#scoped-worker-keys) (`nrnw_...`) rather than the tenant key: it can join the worker socket, claim its gard and serve tasks, and nothing else. With one, `start()` skips the agent registration, since the key cannot reach the REST API; register the definitions with a tenant key instead. Pass `capabilities: ["tools"]` for a worker with no LLM access, matching what the key allows. If the key is revoked while the worker is connected, `worker.stopped` rejects with `KeyRevokedError`.

```ts
const worker = new NornsWorker({ agents: [coder], gard: 3, claimToken: "tok_...", capabilities: ["tools"] });
```

### Shutdown

On SIGTERM or SIGINT the worker drains instead of dying mid-task: it tells Norns to stop sending it work, finishes the tasks it holds, reports their results, leaves the channel, and the process exits. Tasks still running after `shutdownTimeoutMs` (default 30 seconds, or `NORNS_SHUTDOWN_TIMEOUT` in seconds) are dropped and Norns re-dispatches them. A second signal exits at once.

```ts
const worker = new NornsWorker({ agents: [supportBot], shutdownTimeoutMs: 60_000 });
await worker.start();
await worker.stopped; // resolves after a drain
```

`worker.stop()` requests the same drain from code; pass `handleSignals: false` to wire signals yourself. New work that arrives while a worker drains queues until its replacement connects, so a worker restarted by a supervisor loses nothing.

## Client

```ts
import { NornsClient } from "norns-sdk";

const client = new NornsClient({ url: "http://localhost:4000", apiKey: process.env.NORNS_API_KEY });

// Fire and forget
const { runId } = await client.sendMessage("support-bot", "Where's my order?");

// Wait for completion
const result = await client.sendMessage("support-bot", "Where's my order?", { wait: true });
console.log(result.output);

// Multi-turn with a conversation key
await client.sendMessage("support-bot", "And the tracking number?", {
  conversationKey: "slack:U01ABC",
  wait: true,
});

// Inspect a run
const run = await client.runs.get(42);
const events = await client.runs.events(42);

// Stream events as they happen
for await (const event of client.stream("support-bot", "Research quantum computing")) {
  if (event.type === "tool_call") console.log("calling", event.data.name);
  if (event.type === "completed") console.log(event.data.output);
}
```

`event.type` narrows `event.data`, so the completed event's `output` is typed. `client.runs.watch(runId)` streams a run that is already going. Both end on `completed` or `error`, and throw `StreamClosedError` if the socket closes first.

Responses are camelCase (`run.agentId`, `run.waitingFor`). Errors are typed: `NornsApiError` carries the status and body, `NotFoundError` is the 404 case, `NornsTimeoutError` is a wait or stream that ran out of time.

## Human-in-the-loop

An agent can call the built-in `ask_human` tool to pause and ask a question. The run parks with status `"waiting"` until someone answers, and survives a restart while parked.

```ts
const result = await client.sendMessage("support-bot", "Book me a table", { wait: true });

if (result.isWaiting) {
  console.log(result.waitingFor?.question); // "7pm or 8pm?"
  await client.runs.reply(result.runId, "7pm");
}
```

`wait` returns as soon as the agent parks: it is waiting on you, so it will not progress on its own. Sending the agent another message answers the question too, which is usually what a chat or Slack client wants; `runs.reply()` targets one specific run. To find parked runs nobody holds a handle to, `client.runs.list({ status: "waiting" })`.

## Tools

`tool()` takes a [Zod](https://zod.dev) schema for `input`. The JSON Schema the model sees is derived from it, `execute` receives the parsed, typed object, and a call that fails validation is reported back to the model as an error rather than reaching your code.

```ts
const lookupCustomer = tool({
  name: "lookup_customer",
  description: "Look up a customer by email.",
  input: z.object({ email: z.string().email().describe("The customer's email") }),
  execute: async ({ email }) => {
    const customer = await db.customers.findByEmail(email);
    return `Found: ${customer.name} (${customer.plan})`;
  },
});
```

Return a string, or anything JSON-serialisable. Raw JSON Schema works too (`input: { type: "object", ... }`), and `jsonSchema<T>()` from the SDK gives it a type. A tool with no `input` takes nothing.

`execute` gets a second argument with the call's context: `runId`, `agentId`, `taskId`, the `worker`, an `idempotencyKey`, and a `signal` that aborts when the worker gives up on the call (the socket dropped, or a drain hit its deadline). A long tool should pass the signal on.

### Side effects happen once

Mark side-effecting tools so a call that is dispatched twice only happens once:

```ts
const chargeCard = tool({
  name: "charge_card",
  description: "Charge a credit card.",
  input: z.object({ customerId: z.string(), amount: z.number() }),
  sideEffect: true,
  execute: async ({ customerId, amount }, ctx) => {
    const charge = await stripe.charges.create(
      { customer: customerId, amount: Math.round(amount * 100) },
      { idempotencyKey: ctx.idempotencyKey },
    );
    return `Charged $${amount}: ${charge.id}`;
  },
});
```

Norns names every side-effecting call with a key derived from the run, the step and the tool call id, and re-dispatches the call if the result never reached it. After a crash it has no way to know whether the charge went through. The worker does: it keeps the result against the key and answers the second dispatch from that, flagging it so the run's log records a `tool_duplicate` rather than what looks like a second charge. The memory is on disk (`NORNS_STATE_DIR`, or the system temp dir) and bounded, so it covers the orchestrator restarting and the worker restarting. For a worker that never comes back, pass the key on to a provider that dedupes, as above.

## Agent options

```ts
const agent = defineAgent({
  name: "my-agent",
  model: "claude-sonnet-5",
  systemPrompt: "You are helpful.",
  tools: [search, sendEmail],
  mode: "conversation",              // "task" or "conversation"
  checkpointPolicy: "on_tool_call",  // "every_step", "on_tool_call", "manual"
  contextWindow: 20,
  maxSteps: 50,
  onFailure: "retry_last_step",      // "stop" or "retry_last_step"
  maxTokens: 8192,                   // ceiling on one response
  allowedTools: ["search"],          // offer only these of its tools (default: every tool)
  subagents: { mode: "disabled" },   // launch_agent / list_agents policy (default: open)
});
```

`maxTokens` is the ceiling on a single response, not on the history. Leave it unset and the worker uses 8192; raise it for an agent whose turns are long, such as one writing a whole file in a single turn. A turn that reaches the ceiling comes back truncated: the run completes, and the `llm_response` event carries `finish_reason: "length"` so a client can say so.

`defineAgent()` checks the combination where it is written: an `allowedTools` name the agent does not have, or a bad `subagentConversation`, throws before anything reaches the server.

### Several agents, one worker

`agents` takes a list. Every agent is created or updated, and the worker registers the union of their tools. A tool call is dispatched by name, so two *different* tools sharing a name throw before the worker connects; the same tool in several agents is fine.

```ts
const lead = defineAgent({
  name: "lead",
  tools: [readFile, writeFile],
  subagents: { mode: "allowlist", allowedAgents: ["explore"], maxDepth: 1 },
});
const explore = defineAgent({
  name: "explore",
  tools: [readFile],
  allowedTools: ["read_file"],
  subagents: { mode: "disabled" },
  subagentConversation: "per_launch",
});
const worker = new NornsWorker({ agents: [lead, explore] });
```

An agent's `tools` are what the worker serves, not what the agent is offered: Norns offers every tool registered in the tenant unless `allowedTools` narrows it, so set it on any agent that should see less. The built-ins (`ask_human`, `wait`, `launch_agent`, `list_agents`) are never filtered.

`subagents` governs the last two: `mode` is `"open"`, `"allowlist"` (with `allowedAgents`) or `"disabled"`; `allowListAgents` permits `list_agents`; `maxDepth` bounds nesting. `subagentConversation` applies when the agent is launched by another: `"per_launch"` starts a fresh conversation each time, `"per_parent"` keeps one per parent conversation.

## Examples

- [examples/support-bot.ts](examples/support-bot.ts): a worker with two tools
- [examples/client.ts](examples/client.ts): send, wait, answer a question, stream

Run one with `npx tsx examples/support-bot.ts` after `npm install`.

## Development

```bash
npm install
npm test            # unit tests; set NORNS_URL and NORNS_API_KEY to run the integration tests too
npm run typecheck
npm run lint
npm run build
```

## License

MIT
