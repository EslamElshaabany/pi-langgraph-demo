// Q1-4: registry-driven node registration, a router node, addConditionalEdges,
// and re-invoking the SAME compiled graph with 3 different router decisions.
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

const State = Annotation.Root({
  selectedAgent: Annotation<string>,
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  forceDecision: Annotation<string>, // test-only: lets us drive the router per-invoke
});

const registry = [
  { id: "coder", role: "writes code" },
  { id: "reviewer", role: "reviews code" },
  { id: "auditor", role: "audits security" },
];

// Q1: register nodes FROM A LOOP over the registry, not hand-written calls.
// TypeScript note (real, reproducible - not a mistake in this code): addNode()
// returns a NEW StateGraph<...> generic instantiation each call, not `this`
// (confirmed in node_modules/@langchain/langgraph/dist/graph/state.d.ts). Splitting
// registration across separate statements - `graph = graph.addNode(...)` in a loop,
// or via `.reduce()` (also tried) - makes TypeScript compare two independently-derived
// instantiations of that same deeply-generic type and give up with "TS2719: Two
// different types with this name exist, but they are unrelated." This happens even
// though the reassignment is exactly what the return type asks for. The runtime
// behavior is unaffected either way (addNode is a plain mutating method under the
// hood); the only real fix found was to type the loop-built graph as `any` until
// registration is done, which is what this file does.
let graph: any = new StateGraph(State);
for (const agent of registry) {
  graph = graph.addNode(agent.id, async (_state: typeof State.State) => ({ log: [`entered:${agent.id}`] }));
}

// Q2: router node, hardcoded decision (real intelligence is out of scope).
graph = graph.addNode("router", async (state: typeof State.State) => {
  return { selectedAgent: state.forceDecision, log: [`entered:router`] };
});

graph = graph.addEdge(START, "router");
// Q3: addConditionalEdges - route based on state.selectedAgent to the matching registry node id.
graph = graph.addConditionalEdges(
  "router",
  (state: typeof State.State) => state.selectedAgent,
  Object.fromEntries(registry.map((a) => [a.id, a.id])),
);
for (const agent of registry) graph = graph.addEdge(agent.id, END);

const compiled = graph.compile();

// Q4: invoke the SAME compiled graph 3 times with 3 different decisions.
for (const decision of ["coder", "reviewer", "auditor"]) {
  const result = await compiled.invoke({ selectedAgent: "", log: [], forceDecision: decision });
  console.log(`decision=${decision} -> log=${JSON.stringify(result.log)} (only the router + chosen node should appear)`);
}
