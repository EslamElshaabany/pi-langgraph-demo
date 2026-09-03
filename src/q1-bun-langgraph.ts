// Q1: does @langchain/langgraph import and run under `bun run`?
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

const State = Annotation.Root({
  text: Annotation<string>,
});

const graph = new StateGraph(State)
  .addNode("a", async (state) => ({ text: state.text + " -> a" }))
  .addNode("b", async (state) => ({ text: state.text + " -> b" }))
  .addEdge(START, "a")
  .addEdge("a", "b")
  .addEdge("b", END)
  .compile();

const result = await graph.invoke({ text: "start" });
console.log("RESULT:", JSON.stringify(result));
