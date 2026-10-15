/**
 * A worker that serves one agent with two tools.
 *
 *     NORNS_URL=http://localhost:4000 NORNS_API_KEY=nrn_... ANTHROPIC_API_KEY=sk-ant-... \
 *       npx tsx examples/support-bot.ts
 */
import { defineAgent, NornsWorker, tool } from "norns-sdk";
import { z } from "zod";

const orders = new Map([
  ["A-1001", { status: "shipped", eta: "Friday" }],
  ["A-1002", { status: "processing", eta: "next week" }],
]);

const lookupOrder = tool({
  name: "lookup_order",
  description: "Look up an order by its id, e.g. A-1001.",
  input: z.object({ orderId: z.string().describe("The order id") }),
  execute: ({ orderId }) => orders.get(orderId) ?? `No order ${orderId}`,
});

const sendEmail = tool({
  name: "send_email",
  description: "Email the customer.",
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  sideEffect: true,
  execute: async ({ to, subject }, ctx) => {
    // ctx.idempotencyKey is the same on every dispatch of this call; hand it
    // to a provider that dedupes and the email goes out once even if this
    // worker dies mid-call.
    console.log(`(pretend) emailing ${to}: ${subject} [${ctx.idempotencyKey}]`);
    return `Email sent to ${to}`;
  },
});

const supportBot = defineAgent({
  name: "support-bot",
  model: "claude-sonnet-5",
  systemPrompt:
    "You are a customer support agent. Look orders up before answering, and ask for anything you are missing.",
  tools: [lookupOrder, sendEmail],
  mode: "conversation",
});

const worker = new NornsWorker({ agents: [supportBot] });
await worker.start();
console.log("support-bot is serving; Ctrl-C drains and exits");
