// Q7: router returns an agent id NOT in the registry/pathMap. What happens?
// Also: does addConditionalEdges support a default/fallback destination in
// the pathMap itself, or does the router have to guard against bad values
// before ever writing them to state?
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

const State = Annotation.Root({
  selectedAgent: Annotation<string>,
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

const registry = [{ id: "coder" }, { id: "reviewer" }, { id: "auditor" }];

// `any` escape hatch for loop-built registration - see q10's comment for why.
function buildBase(): any {
  let g: any = new StateGraph(State);
  for (const agent of registry) g = g.addNode(agent.id, async () => ({ log: [`entered:${agent.id}`] }));
  g = g.addNode("router", async () => ({ selectedAgent: "not-a-real-agent-id", log: ["entered:router"] }));
  g = g.addEdge(START, "router");
  return g;
}

console.log("=== attempt 1: pathMap has NO entry for the bad id, no default ===");
{
  let g: any = buildBase();
  g = g.addConditionalEdges("router", (state: typeof State.State) => state.selectedAgent, Object.fromEntries(registry.map((a) => [a.id, a.id])));
  for (const agent of registry) g = g.addEdge(agent.id, END);
  const compiled = g.compile();
  try {
    const result = await compiled.invoke({ selectedAgent: "", log: [] });
    console.log("no throw, result:", JSON.stringify(result));
  } catch (e) {
    console.log("THREW:", String(e));
  }
}

console.log("=== attempt 2: pathMap includes a literal fallback entry mapping the exact bad string (not a wildcard) ===");
{
  let g: any = buildBase();
  g = g.addNode("fallback", async () => ({ log: ["entered:fallback"] }));
  g = g.addConditionalEdges("router", (state: typeof State.State) => state.selectedAgent, {
    ...Object.fromEntries(registry.map((a) => [a.id, a.id])),
    "not-a-real-agent-id": "fallback", // only works because we happened to know this exact string in advance
  });
  for (const agent of registry) g = g.addEdge(agent.id, END);
  g = g.addEdge("fallback", END);
  const compiled = g.compile();
  const result = await compiled.invoke({ selectedAgent: "", log: [] });
  console.log("result:", JSON.stringify(result));
}

console.log("=== attempt 3: router guards itself instead - clamps unknown ids to 'fallback' BEFORE writing state ===");
{
  let g: any = new StateGraph(State);
  for (const agent of registry) g = g.addNode(agent.id, async () => ({ log: [`entered:${agent.id}`] }));
  g = g.addNode("fallback", async () => ({ log: ["entered:fallback"] }));
  g = g.addNode("router", async () => {
    const raw = "some-other-bad-id"; // a DIFFERENT unanticipated bad value than attempt 2's
    const valid = registry.some((a) => a.id === raw) ? raw : "fallback";
    return { selectedAgent: valid, log: [`entered:router (raw=${raw}, clamped=${valid})`] };
  });
  g = g.addEdge(START, "router");
  g = g.addConditionalEdges("router", (state: typeof State.State) => state.selectedAgent, {
    ...Object.fromEntries(registry.map((a) => [a.id, a.id])),
    fallback: "fallback",
  });
  for (const agent of registry) g = g.addEdge(agent.id, END);
  g = g.addEdge("fallback", END);
  const compiled = g.compile();
  const result = await compiled.invoke({ selectedAgent: "", log: [] });
  console.log("result:", JSON.stringify(result));
}
