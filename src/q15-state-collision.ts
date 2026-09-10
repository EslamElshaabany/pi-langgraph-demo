// Q3: concurrent writes to the SAME top-level key with no reducer defined -
// what actually happens (error / last-write-wins / silent merge)? And does a
// namespaced-key + merge-reducer approach avoid the problem?
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";

console.log("=== attempt 1: shared key, NO reducer, 3 concurrent branches all write to it ===");
{
  const State = Annotation.Root({
    tasks: Annotation<{ agentId: string }[]>,
    sharedResult: Annotation<string>, // default channel (LastValue-style), no reducer
  });
  let graph: any = new StateGraph(State);
  graph = graph.addNode("worker", async (state: { agentId: string }) => ({ sharedResult: state.agentId }));
  graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("worker", t)));
  graph = graph.addEdge("worker", END);
  const compiled = graph.compile();
  try {
    const result = await compiled.invoke({ tasks: [{ agentId: "coder" }, { agentId: "reviewer" }, { agentId: "auditor" }], sharedResult: "" });
    console.log("no throw, result:", JSON.stringify(result));
  } catch (e) {
    console.log("THREW:", String(e));
  }
}

console.log("=== attempt 2: namespaced key via a merge reducer, same 3 concurrent branches ===");
{
  const State = Annotation.Root({
    tasks: Annotation<{ agentId: string }[]>,
    results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  });
  let graph: any = new StateGraph(State);
  graph = graph.addNode("worker", async (state: { agentId: string }) => ({ results: { [state.agentId]: `output-from-${state.agentId}` } }));
  graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("worker", t)));
  graph = graph.addEdge("worker", END);
  const compiled = graph.compile();
  const result = await compiled.invoke({ tasks: [{ agentId: "coder" }, { agentId: "reviewer" }, { agentId: "auditor" }], results: {} });
  console.log("result:", JSON.stringify(result, null, 1));
  console.log("all 3 keys present, no data lost:", Object.keys(result.results).length === 3);
}
