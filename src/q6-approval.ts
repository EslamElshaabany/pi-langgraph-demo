// Q6: does Pi prompt for its own tool approvals? Can that be intercepted?
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");

// Part 1: does a bash+write session block waiting for any approval/stdin?
const { session } = await createAgentSession({
  model,
  tools: ["bash", "write"],
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});

const toolCalls: string[] = [];
session.subscribe((event) => {
  if (event.type === "tool_execution_start") toolCalls.push(event.toolName ?? "?");
});

const start = Date.now();
await session.prompt('Run the bash command: echo "no approval needed"');
console.log("elapsed ms (no stdin attached to this process at all):", Date.now() - start);
console.log("tool calls executed with zero approval prompt:", JSON.stringify(toolCalls));

// Part 2: does createAgentSession's public options expose a hook to intercept
// tool calls (the docs mention a `pi.on("tool_call", ...)` extension hook)?
// Checked node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:
// CreateAgentSessionOptions has: cwd, agentDir, modelRuntime, model, thinkingLevel,
// scopedModels, noTools, tools, excludeTools, customTools, resourceLoader,
// sessionManager, settingsManager, sessionStartEvent. NO `extensions` field.
console.log("---");
console.log("CreateAgentSessionOptions has no 'extensions' field (verified in .d.ts) -");
console.log("the tool_call interception hook exists (ExtensionRunner, InlineExtension,");
console.log("discoverAndLoadExtensions, createExtensionRuntime are all exported), but");
console.log("ExtensionRunner's constructor requires an ExtensionRuntime + ModelRegistry");
console.log("that createAgentSession builds internally and does not hand back or accept");
console.log("as an injectable option. There is no documented, supported way to pass an");
console.log("inline tool_call handler straight into createAgentSession().");
