// Q5: can you restrict which tools a session exposes to its model (read-only)?
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");

const { session } = await createAgentSession({
  model,
  tools: ["read", "grep", "find", "ls"], // no write, no bash
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});

let text = "";
const toolCalls: string[] = [];
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text += event.assistantMessageEvent.delta;
  if (event.type === "tool_execution_start") toolCalls.push(event.toolName ?? JSON.stringify(event).slice(0, 100));
});

await session.prompt(
  "Write a file at generated/should-not-exist.txt containing the word hello. " +
  "Use whatever tool you need to accomplish this."
);

console.log("tool calls attempted:", JSON.stringify(toolCalls));
console.log("assistant text:", JSON.stringify(text));
console.log("did generated/should-not-exist.txt get created?:", await Bun.file("generated/should-not-exist.txt").exists());
