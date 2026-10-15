/**
 * Talk to the agent that examples/support-bot.ts serves.
 *
 *     NORNS_URL=http://localhost:4000 NORNS_API_KEY=nrn_... npx tsx examples/client.ts
 */
import { createInterface } from "node:readline/promises";
import { NornsClient } from "norns-sdk";

const client = new NornsClient();
const conversationKey = `cli:${process.pid}`;

// Wait for the answer. The run parks if the agent needs something from us.
let result = await client.sendMessage("support-bot", "Where is my order?", {
  conversationKey,
  wait: true,
});

while (result.isWaiting) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Agent asks: ${result.waitingFor?.question}\n> `);
  rl.close();
  await client.runs.reply(result.runId, answer);
  result = await client.sendMessage("support-bot", answer, { conversationKey, wait: true });
}
console.log(`Run ${result.runId}: ${result.status}\n${result.output ?? ""}`);

// Or watch a run as it happens.
for await (const event of client.stream("support-bot", "What is order A-1002's ETA?", {
  conversationKey,
})) {
  switch (event.type) {
    case "tool_call":
      console.log(`→ ${event.data.name}(${JSON.stringify(event.data.arguments)})`);
      break;
    case "completed":
      console.log(event.data.output);
      break;
    case "error":
      console.error("run failed:", event.data.error);
      break;
  }
}
