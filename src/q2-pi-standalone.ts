// Q2: create a Pi session programmatically via the SDK (no `pi` CLI subprocess),
// send one prompt, get a result back, confirm in-process.
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");

const { session } = await createAgentSession({
  model,
  tools: [],
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});

let replyText = "";
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    replyText += event.assistantMessageEvent.delta;
  }
});

const result = await session.prompt("Reply with exactly the word: PONG");
console.log("PID (this process, no child pi binary spawned):", process.pid);
console.log("session.prompt() return value:", JSON.stringify(result));
console.log("assistant reply (via subscribe):", JSON.stringify(replyText));
