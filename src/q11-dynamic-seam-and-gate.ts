// Q5: the actual seam, now dynamic - real Pi sessions inside registry-driven
// nodes, one chosen at runtime by the router.
// Q6: does the bindExtensions() approval gate (spike 2) still work when it's
// attached inside a node that was NOT hardcoded - it was reached via
// addConditionalEdges, decision "auditor" (registry index 2, not node 0).
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  selectedAgent: Annotation<string>,
  forceDecision: Annotation<string>,
  output: Annotation<string>,
});

async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  return (await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd() })).session;
}

function noopUi(overrides: Partial<ExtensionUIContext>): ExtensionUIContext {
  return {
    select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {},
    onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
    setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {}, setWidget: () => {}, setFooter: () => {},
    ...overrides,
  } as ExtensionUIContext;
}

const markerFile = "generated/q11-auditor-marker.txt";

const registry = [
  {
    id: "coder",
    async run(_state: typeof State.State) {
      const session = await newSession(["write"]);
      await session.prompt("Write a file at exactly generated/q11-coder-output.txt containing the single line: dynamic seam works");
      return { output: "coder:wrote generated/q11-coder-output.txt" };
    },
  },
  {
    id: "reviewer",
    async run(_state: typeof State.State) {
      const session = await newSession(["read"]);
      let text = "";
      session.subscribe((e) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") text += e.assistantMessageEvent.delta; });
      await session.prompt("Reply with exactly the word: REVIEWED");
      return { output: `reviewer:${text}` };
    },
  },
  {
    id: "auditor",
    // Q6: this session gets the approval gate (spike 2's .pi/extensions/gate.ts,
    // already project-trusted) bound to DENY, on a node reached only via routing.
    async run(_state: typeof State.State) {
      const session = await newSession(["bash"]);
      await session.bindExtensions({ uiContext: noopUi({ confirm: async () => false }) });
      await session.prompt(`Run bash: touch ${markerFile}`);
      return { output: "auditor:attempted bash under deny gate" };
    },
  },
];

// Same `any` escape hatch as q10 - see that file's comment. Registration is a plain
// runtime loop; type safety resumes at compile()/invoke() below.
let graph: any = new StateGraph(State);
for (const agent of registry) graph = graph.addNode(agent.id, agent.run);
graph = graph.addNode("router", async (state: typeof State.State) => ({ selectedAgent: state.forceDecision }));
graph = graph.addEdge(START, "router");
graph = graph.addConditionalEdges("router", (state: typeof State.State) => state.selectedAgent, Object.fromEntries(registry.map((a) => [a.id, a.id])));
for (const agent of registry) graph = graph.addEdge(agent.id, END);
const compiled = graph.compile();

console.log("=== Q5: dynamic seam, decision=coder ===");
try { await (await import("node:fs/promises")).rm("generated/q11-coder-output.txt"); } catch {}
const r1 = await compiled.invoke({ selectedAgent: "", forceDecision: "coder", output: "" });
console.log("result:", JSON.stringify(r1));
console.log("real file content:", await Bun.file("generated/q11-coder-output.txt").text());

console.log("=== Q5: dynamic seam, decision=reviewer ===");
const r2 = await compiled.invoke({ selectedAgent: "", forceDecision: "reviewer", output: "" });
console.log("result:", JSON.stringify(r2));

console.log("=== Q6: approval gate inside dynamically-routed node, decision=auditor ===");
try { await (await import("node:fs/promises")).rm(markerFile); } catch {}
const r3 = await compiled.invoke({ selectedAgent: "", forceDecision: "auditor", output: "" });
console.log("result:", JSON.stringify(r3));
console.log("marker file exists after DENY inside dynamic node (should be false):", await Bun.file(markerFile).exists());
