// Q8: when the graph checkpoints, is Pi's internal session history captured,
// or only the graph state?
import { StateGraph, Annotation, START, END, MemorySaver } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  piReply: Annotation<string>,
});

async function piNode(_state: typeof State.State) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  const { session } = await createAgentSession({ model, tools: [], modelRuntime, sessionManager: SessionManager.inMemory() });
  let reply = "";
  session.subscribe((e) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") reply += e.assistantMessageEvent.delta; });
  await session.prompt("Reply with exactly the word: CHECKPOINTED");
  // Only `reply` (a plain string) is returned to graph state. `session` itself
  // (with its full internal message history/event log) is never returned.
  return { piReply: reply };
}

const checkpointer = new MemorySaver();
const graph = new StateGraph(State)
  .addNode("piNode", piNode)
  .addEdge(START, "piNode")
  .addEdge("piNode", END)
  .compile({ checkpointer });

const config = { configurable: { thread_id: "t2" } };
await graph.invoke({ piReply: "" }, config);

const snapshot = await graph.getState(config);
console.log("graph.getState(config).values:", JSON.stringify(snapshot.values, null, 1));
console.log("---");
console.log("keys present in checkpointed state:", Object.keys(snapshot.values));
console.log("does checkpointed state contain any Pi session/message-history object?",
  JSON.stringify(snapshot.values).includes("agent_start") || JSON.stringify(snapshot.values).includes("assistantMessageEvent"));

// Inspect the raw checkpoint tuple directly from the checkpointer too.
const tuple = await checkpointer.getTuple(config);
console.log("---");
console.log("raw checkpoint.channel_values keys:", Object.keys(tuple?.checkpoint.channel_values ?? {}));
