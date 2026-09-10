// Q4: fan out TWO invocations of the SAME agentId ("reviewer") at once.
// Does anything break - shared temp paths, session-id collisions, file lock
// contention - or do the two behave like fully independent instances?
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  tasks: Annotation<{ agentId: string; instanceId: string }[]>,
  results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
});

async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  const { session } = await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd() });
  return session;
}

let graph: any = new StateGraph(State);
graph = graph.addNode("reviewer", async (state: { agentId: string; instanceId: string }) => {
  const session = await newSession(["write"]);
  const filePath = `generated/q16-reviewer-${state.instanceId}.txt`;
  await session.prompt(`Write a file at exactly ${filePath} containing exactly the single line: instance-${state.instanceId}`);
  return { results: { [state.instanceId]: filePath } };
});
graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("reviewer", t)));
graph = graph.addEdge("reviewer", END);
const compiled = graph.compile();

for (const id of ["A", "B"]) { try { await (await import("node:fs/promises")).rm(`generated/q16-reviewer-${id}.txt`); } catch {} }

const result = await compiled.invoke({
  tasks: [
    { agentId: "reviewer", instanceId: "A" },
    { agentId: "reviewer", instanceId: "B" },
  ],
  results: {},
});

console.log("result:", JSON.stringify(result.results, null, 1));
console.log("--- file contents ---");
for (const id of ["A", "B"]) {
  console.log(`instance ${id}:`, (await Bun.file(`generated/q16-reviewer-${id}.txt`).text()).trim());
}
