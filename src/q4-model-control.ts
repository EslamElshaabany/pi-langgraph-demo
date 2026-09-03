// Q4: can each Pi session use a different model? Can a session's model be
// changed at runtime, or only at construction?
// Note: only ANTHROPIC_API_KEY is usable in this sandbox (Gemini blocked by
// proxy SSE issue, OpenCode Zen blocked by network egress allowlist - see
// FINDINGS.md). So "different provider" is demonstrated as "different model
// id from the same provider" at construction, plus a runtime model switch.
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// Two sessions, two different models, constructed independently.
const sessionA = (await createAgentSession({
  model: modelRuntime.getModel("anthropic", "claude-haiku-4-5"),
  tools: [],
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
})).session;

const sessionB = (await createAgentSession({
  model: modelRuntime.getModel("anthropic", "claude-sonnet-5"),
  tools: [],
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
})).session;

console.log("sessionA model (construction):", sessionA.model.id);
console.log("sessionB model (construction):", sessionB.model.id);

// Runtime model switch on sessionA.
console.log("sessionA model before setModel:", sessionA.model.id);
await sessionA.setModel(modelRuntime.getModel("anthropic", "claude-opus-4-5"));
console.log("sessionA model after setModel:", sessionA.model.id);

let reply = "";
sessionA.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") reply += e.assistantMessageEvent.delta;
});
await sessionA.prompt("Reply with exactly the word: SWITCHED");
console.log("sessionA reply after runtime switch:", JSON.stringify(reply));
console.log("sessionA model actually used for that call:", sessionA.model.id);
