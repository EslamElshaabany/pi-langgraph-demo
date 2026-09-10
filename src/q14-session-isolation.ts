// Q2: N concurrent invocations each call newSession() independently. Confirm
// genuinely separate sessions - no shared closures/state - by having each
// write a real file with a unique marker (agentId + timestamp), then reading
// all N back from disk after the run to confirm no cross-contamination.
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  tasks: Annotation<{ agentId: string }[]>,
  written: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  return (await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd() })).session;
}

let graph: any = new StateGraph(State);
graph = graph.addNode("worker", async (state: { agentId: string }) => {
  const session = await newSession(["write"]);
  const marker = `${state.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = `generated/q14-${state.agentId}.txt`;
  await session.prompt(`Write a file at exactly ${filePath} containing exactly this single line and nothing else: ${marker}`);
  return { written: [`${state.agentId}:${filePath}:${marker}`] };
});
graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("worker", t)));
graph = graph.addEdge("worker", END);
const compiled = graph.compile();

for (const agentId of ["coder", "reviewer", "auditor"]) {
  try { await (await import("node:fs/promises")).rm(`generated/q14-${agentId}.txt`); } catch {}
}

const result = await compiled.invoke({
  tasks: [{ agentId: "coder" }, { agentId: "reviewer" }, { agentId: "auditor" }],
  written: [],
});

console.log("expected markers:", JSON.stringify(result.written, null, 1));
console.log("--- actual file contents read back from disk ---");
for (const entry of result.written) {
  const [agentId, filePath, expectedMarker] = entry.split(":");
  const actual = (await Bun.file(filePath).text()).trim();
  console.log(`${agentId}: file=${filePath} expected=${expectedMarker} actual=${actual} match=${actual === expectedMarker}`);
}
