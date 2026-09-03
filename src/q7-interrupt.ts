// Q7: does LangGraph's interrupt() work on a node containing a Pi session?
// Can the graph pause mid-run and resume?
import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  piOutput: Annotation<string>,
  approved: Annotation<string>,
});

async function piNode(state: typeof State.State) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  const { session } = await createAgentSession({ model, tools: [], modelRuntime, sessionManager: SessionManager.inMemory() });
  let reply = "";
  session.subscribe((e) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") reply += e.assistantMessageEvent.delta; });
  await session.prompt("Reply with exactly the word: DRAFTED");
  console.log("  [piNode] Pi session finished, about to call interrupt()");
  const decision = interrupt({ question: "approve this?", piOutput: reply });
  console.log("  [piNode] resumed past interrupt() with:", decision);
  return { piOutput: reply, approved: decision as string };
}

const checkpointer = new MemorySaver();
const graph = new StateGraph(State)
  .addNode("piNode", piNode)
  .addEdge(START, "piNode")
  .addEdge("piNode", END)
  .compile({ checkpointer });

const config = { configurable: { thread_id: "t1" } };

console.log("--- first invoke (should pause at interrupt) ---");
const first = await graph.invoke({ piOutput: "", approved: "" }, config);
console.log("first result:", JSON.stringify(first));

console.log("--- resuming with Command({ resume: 'yes' }) ---");
const second = await graph.invoke(new Command({ resume: "yes" }), config);
console.log("second result:", JSON.stringify(second));
