// Q6: does the graph only proceed past the fan-out wave once EVERY branch has
// completed (not just the fastest)? And does one branch throwing fail the
// whole wave, or surface as a partial result?
import { StateGraph, Annotation, Send, START, END } from "@langchain/langgraph";

console.log("=== part A: all branches succeed, staggered completion times ===");
{
  const State = Annotation.Root({
    tasks: Annotation<{ agentId: string; delayMs: number }[]>,
    results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  });
  let graph: any = new StateGraph(State);
  graph = graph.addNode("worker", async (state: { agentId: string; delayMs: number }) => {
    await new Promise((r) => setTimeout(r, state.delayMs));
    return { results: { [state.agentId]: `done at +${state.delayMs}ms` } };
  });
  graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("worker", t)));
  graph = graph.addEdge("worker", END);
  const compiled = graph.compile();

  const start = Date.now();
  const result = await compiled.invoke({
    tasks: [{ agentId: "fast", delayMs: 50 }, { agentId: "medium", delayMs: 300 }, { agentId: "slow", delayMs: 600 }],
    results: {},
  });
  const elapsed = Date.now() - start;
  console.log(`invoke() resolved after ${elapsed}ms (slowest branch was 600ms - if invoke() didn't wait for it, elapsed would be much less)`);
  console.log("all results present:", JSON.stringify(result.results));
}

console.log("=== part B: one branch throws - does the whole wave fail, or is there a partial result? ===");
{
  const State = Annotation.Root({
    tasks: Annotation<{ agentId: string; shouldThrow: boolean }[]>,
    results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  });
  let graph: any = new StateGraph(State);
  graph = graph.addNode("worker", async (state: { agentId: string; shouldThrow: boolean }) => {
    if (state.shouldThrow) {
      await new Promise((r) => setTimeout(r, 100)); // throws mid-wave, not instantly
      throw new Error(`intentional failure in ${state.agentId}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // outlives the throwing branch
    if (state.agentId === "coder") await Bun.write("generated/q18-coder-sentinel.txt", "coder finished despite wave failure");
    return { results: { [state.agentId]: "succeeded" } };
  });
  graph = graph.addConditionalEdges(START, (state: typeof State.State) => state.tasks.map((t) => new Send("worker", t)));
  graph = graph.addEdge("worker", END);
  const compiled = graph.compile();

  // Sentinel: does the slower, non-throwing sibling's side effect still land on
  // disk after the wave has already failed, or is it truly gone? auditor throws
  // at 100ms; coder (300ms) writes a real file right before returning.
  try { await (await import("node:fs/promises")).rm("generated/q18-coder-sentinel.txt"); } catch {}
  try {
    const result = await compiled.invoke({
      tasks: [{ agentId: "coder", shouldThrow: false }, { agentId: "reviewer", shouldThrow: false }, { agentId: "auditor", shouldThrow: true }],
      results: {},
    });
    console.log("no throw - PARTIAL RESULT returned:", JSON.stringify(result));
  } catch (e) {
    console.log("invoke() THREW (whole wave failed):", String(e));
  }
  // Give coder's already-in-flight 300ms timer a moment to land, since invoke()
  // rejected at ~100ms (when auditor threw) - well before coder's 300ms finishes.
  await new Promise((r) => setTimeout(r, 400));
  console.log("coder's sentinel file exists despite the overall wave failing:", await Bun.file("generated/q18-coder-sentinel.txt").exists());

  // Check via graph.stream() too - does a partial result surface as an intermediate
  // event even though invoke() throws, or is everything lost?
  console.log("--- checking .stream() for any partial state before the error ---");
  const events: string[] = [];
  try {
    for await (const chunk of await compiled.stream(
      { tasks: [{ agentId: "coder", shouldThrow: false }, { agentId: "auditor", shouldThrow: true }], results: {} },
      { streamMode: "updates" },
    )) {
      events.push(JSON.stringify(chunk));
    }
  } catch (e) {
    events.push(`STREAM THREW: ${String(e)}`);
  }
  console.log("stream events:", JSON.stringify(events, null, 1));
}
