// Q3: Pi session inside a LangGraph node. 2-node graph:
//   node A = Pi session that writes a small function to a file
//   node B = Pi session that reviews A's output, returns comments
// Nodes communicate ONLY through graph state - no shared references.
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const State = Annotation.Root({
  filePath: Annotation<string>,
  review: Annotation<string>,
});

async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  return (await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory() })).session;
}

// Node A: no knowledge of node B. Builds its own session, writes a file, returns a path.
async function nodeA(_state: typeof State.State) {
  const session = await newSession(["write"]);
  await session.prompt(
    "Write a JavaScript file at exactly the path generated/add.js containing a single " +
    "function `add(a, b)` that returns a + b. No comments, no extra text, just the file."
  );
  return { filePath: "generated/add.js" };
}

// Node B: only receives `state`. Builds an entirely separate session. Never touches nodeA's session.
async function nodeB(state: typeof State.State) {
  const session = await newSession(["read"]);
  let comments = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      comments += event.assistantMessageEvent.delta;
    }
  });
  await session.prompt(`Read the file at ${state.filePath} and give one sentence of review comments.`);
  return { review: comments };
}

const graph = new StateGraph(State)
  .addNode("A", nodeA)
  .addNode("B", nodeB)
  .addEdge(START, "A")
  .addEdge("A", "B")
  .addEdge("B", END)
  .compile();

const result = await graph.invoke({ filePath: "", review: "" });
console.log("FINAL STATE:", JSON.stringify(result, null, 1));
console.log("--- file node A wrote ---");
console.log(await Bun.file("generated/add.js").text());
