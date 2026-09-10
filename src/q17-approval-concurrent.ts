// Q5: bind the deny-gate extension (.pi/extensions/gate.ts, spike 2) inside
// TWO concurrently-running nodes. One denies, one allows - if there's any
// cross-talk between the two pending confirm() calls, the wrong marker file
// will appear (denier's file created, or allower's file missing).
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  tasks: Annotation<{ agentId: string; decision: boolean }[]>,
  results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
});

async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  const { session } = await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd() });
  return session;
}

function noopUi(overrides: Partial<ExtensionUIContext>): ExtensionUIContext {
  return {
    select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {},
    onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
    setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {}, setWidget: () => {}, setFooter: () => {},
    ...overrides,
  } as ExtensionUIContext;
}

function uiWithConfirm(decision: boolean, log: (msg: string) => void): ExtensionUIContext {
  return noopUi({
    confirm: async (title, message) => {
      log(`confirm() called: decision=${decision} title=${title} message=${message}`);
      return decision;
    },
  });
}

let graph: any = new StateGraph(State);
graph = graph.addNode("gated", async (state: { agentId: string; decision: boolean }) => {
  const session = await newSession(["bash"]);
  const logs: string[] = [];
  await session.bindExtensions({ uiContext: uiWithConfirm(state.decision, (m) => logs.push(m)) });
  const markerFile = `generated/q17-${state.agentId}-marker.txt`;
  await session.prompt(`Run bash: touch ${markerFile}`);
  return { results: { [state.agentId]: JSON.stringify({ decision: state.decision, confirmLog: logs }) } };
});
graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("gated", t)));
graph = graph.addEdge("gated", END);
const compiled = graph.compile();

for (const id of ["denier", "allower"]) { try { await (await import("node:fs/promises")).rm(`generated/q17-${id}-marker.txt`); } catch {} }

const result = await compiled.invoke({
  tasks: [
    { agentId: "denier", decision: false },
    { agentId: "allower", decision: true },
  ],
  results: {},
});

console.log("per-instance confirm logs:", JSON.stringify(result.results, null, 1));
console.log("--- marker files ---");
console.log("denier marker exists (should be false):", await Bun.file("generated/q17-denier-marker.txt").exists());
console.log("allower marker exists (should be true):", await Bun.file("generated/q17-allower-marker.txt").exists());
