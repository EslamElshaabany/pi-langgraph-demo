// Q1: does a conditional edge returning Send[] actually run the target node
// N times CONCURRENTLY in one super-step, or serially disguised as one step?
// Proof: each invocation sleeps 300ms and logs start/end timestamps. If serial,
// total wall time ~= N*300ms. If concurrent, total wall time ~= 300ms regardless of N.
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";

const State = Annotation.Root({
  tasks: Annotation<{ agentId: string; task: string }[]>,
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

let graph: any = new StateGraph(State);
graph = graph.addNode("worker", async (state: { agentId: string; task: string }) => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  const end = Date.now();
  return { log: [`${state.agentId}: start=${start} end=${end}`] };
});
graph = graph.addConditionalEdges(START, (state: typeof State.State) =>
  state.tasks.map((t) => new Send("worker", t)),
);
graph = graph.addEdge("worker", END);
const compiled = graph.compile();

const wallStart = Date.now();
const result = await compiled.invoke({
  tasks: [
    { agentId: "coder", task: "x" },
    { agentId: "reviewer", task: "y" },
    { agentId: "auditor", task: "z" },
  ],
  log: [],
});
const wallEnd = Date.now();

console.log("per-invocation log:");
for (const line of result.log) console.log("  " + line);
console.log(`total wall time: ${wallEnd - wallStart}ms (serial would be ~900ms, concurrent ~300ms)`);
