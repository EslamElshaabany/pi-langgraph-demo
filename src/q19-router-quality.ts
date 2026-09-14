// Spike: does the REAL router (a raw LLM call, forced tool call, validated against
// the live registry) pick sensibly on the locked demo scenario? See task description
// for the six questions this answers. Everything runs on Anthropic claude-haiku-4-5 —
// agents AND the router — cross-provider diversity is explicitly out of scope here.
import { ModelRuntime, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Reused verbatim from FINDINGS.md's Q3 helper (spike 1).
async function newSession(tools: string[]) {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  return (await createAgentSession({ model, tools, modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd() })).session;
}

const TASK =
  "Implement mergeIntervals(intervals: [number,number][]): [number,number][] that merges " +
  "all overlapping intervals and returns sorted, merged output. Include basic tests.";

// The real, live registry the demo would route across.
const registry = [
  { id: "coder", description: "Implements the requested code change or feature" },
  { id: "reviewer", description: "Reviews code already written; flags bugs, gaps, or unclear logic — does not write code" },
  { id: "auditor", description: "Final correctness check before completion; confirms all flagged issues are resolved and the task is ready to ship" },
];

// DESIGN NOTE (flagged in FINDINGS): the registry above has no node that means
// "stop". To actually test whether the router recognizes completion (Q3/Q4 ask
// for this explicitly), we add one router-only sentinel candidate. It is never
// passed to newSession() and is not a real agent — routing to it just ends the
// loop. Validation still checks against this exact candidate set, so a
// hallucinated id outside {coder, reviewer, auditor, end} is still a misfire.
const routerCandidates = [...registry, { id: "end", description: "Nothing left to do — a prior step already confirmed the task is complete and ready to ship. Pick this only then, never before." }];
const validIds = new Set(routerCandidates.map((c) => c.id));

type HistoryEntry = { role: string; summary: string };
type Decision = { run: string; step: number; historyGiven: string; rawDecision: string; decision: string; reason: string; valid: boolean; fallbackFired: boolean; latencyMs: number };

const allDecisions: Decision[] = [];

function historyText(history: HistoryEntry[]): string {
  if (history.length === 0) return "(empty — no turns have run yet)";
  return history.map((h, i) => `Turn ${i + 1} — ${h.role}: ${h.summary}`).join("\n");
}

async function callRouter(routerRuntime: ModelRuntime, routerModel: Model<"anthropic-messages">, history: HistoryEntry[]) {
  const tool = {
    name: "select_agent",
    description: "Pick which agent should run next, or 'end' if the task is already complete.",
    parameters: Type.Object({
      agentId: Type.Union(routerCandidates.map((c) => Type.Literal(c.id))),
      reason: Type.String({ description: "One sentence: why this choice, now." }),
    }),
  };
  const registryText = routerCandidates.map((c) => `- ${c.id}: "${c.description}"`).join("\n");
  const systemPrompt =
    `You are a router in a multi-agent coding system. Available next steps:\n${registryText}\n\n` +
    `Call select_agent exactly once, choosing the single best next step given the task and what has happened so far.`;
  const userText = `TASK:\n${TASK}\n\nHISTORY SO FAR:\n${historyText(history)}`;

  const t0 = Date.now();
  const msg = await routerRuntime.complete(
    routerModel,
    { systemPrompt, messages: [{ role: "user", content: userText, timestamp: Date.now() }], tools: [tool] },
    { toolChoice: { type: "tool", name: "select_agent" } },
  );
  const latencyMs = Date.now() - t0;

  const call = msg.content.find((c) => c.type === "toolCall" && c.name === "select_agent") as { arguments: Record<string, any> } | undefined;
  if (!call) return { agentId: "coder", rawAgentId: "(no tool call returned)", reason: "(model did not call select_agent)", valid: false, latencyMs };
  const raw = String(call.arguments.agentId);
  const reason = String(call.arguments.reason ?? "(no reason given)");
  const valid = validIds.has(raw);
  return { agentId: valid ? raw : "coder", rawAgentId: raw, reason, valid, latencyMs };
}

function record(run: string, step: number, history: HistoryEntry[], r: Awaited<ReturnType<typeof callRouter>>) {
  allDecisions.push({
    run, step, historyGiven: historyText(history),
    rawDecision: r.rawAgentId, decision: r.agentId, reason: r.reason,
    valid: r.valid, fallbackFired: !r.valid, latencyMs: r.latencyMs,
  });
  console.log(`[${run}#${step}] decision=${r.rawAgentId}${r.valid ? "" : ` -> CLAMPED to ${r.agentId} (fallback fired)`} valid=${r.valid} latency=${r.latencyMs}ms reason="${r.reason}"`);
}

async function runAgent(agentId: string, history: HistoryEntry[], filePath: string): Promise<string> {
  const captureText = (session: Awaited<ReturnType<typeof newSession>>) => {
    let text = "";
    session.subscribe((e: any) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") text += e.assistantMessageEvent.delta; });
    return () => text;
  };
  const context = `${TASK}\n\nPrior steps:\n${historyText(history)}\n\n`;

  if (agentId === "coder") {
    const session = await newSession(["read", "write"]);
    const getText = captureText(session);
    await session.prompt(`${context}Write (or revise) the implementation to exactly the path ${filePath}. Keep it concise. End your reply with one sentence summarizing what you wrote or changed.`);
    let fileLen = 0;
    try { fileLen = (await Bun.file(filePath).text()).length; } catch {}
    return `wrote ${filePath} (${fileLen} chars). ${getText().trim() || "(no text reply)"}`;
  }
  if (agentId === "reviewer") {
    const session = await newSession(["read"]);
    const getText = captureText(session);
    await session.prompt(`${context}Read ${filePath} and review it. Either flag concrete bugs/gaps/unclear logic, or state plainly that no issues were found.`);
    return `review: ${getText().trim() || "(no text reply)"}`;
  }
  if (agentId === "auditor") {
    // Scope note: auditor reports a plausible completion signal in text only — no bash/tests.
    const session = await newSession(["read"]);
    const getText = captureText(session);
    await session.prompt(`${context}You are the final auditor. Based on the history above only (do not run tests), state plainly whether the task is complete and ready to ship, or what is still missing.`);
    return `audit: ${getText().trim() || "(no text reply)"}`;
  }
  throw new Error(`unknown agentId: ${agentId}`);
}

async function runFullRun(runId: string, routerRuntime: ModelRuntime, routerModel: Model<"anthropic-messages">, maxSteps = 8) {
  console.log(`\n=== FULL RUN ${runId} ===`);
  const history: HistoryEntry[] = [];
  const filePath = `generated/mergeIntervals-${runId}.ts`;
  for (let step = 1; step <= maxSteps; step++) {
    const r = await callRouter(routerRuntime, routerModel, history);
    record(runId, step, history, r);
    if (r.agentId === "end") { console.log(`[${runId}] routed to END after ${step} router call(s)`); break; }
    const summary = await runAgent(r.agentId, history, filePath);
    console.log(`[${runId}#${step}] ${r.agentId} produced: ${summary}`);
    history.push({ role: r.agentId, summary });
    if (step === maxSteps) console.log(`[${runId}] hit the ${maxSteps}-call safety cap without routing to END`);
  }
  return history;
}

// ---- main ----
const routerRuntime = await ModelRuntime.create();
const routerModel = routerRuntime.getModel("anthropic", "claude-haiku-4-5") as Model<"anthropic-messages">;

console.log("=== Q1: TURN 1, EMPTY HISTORY, x5 ===");
for (let i = 1; i <= 5; i++) {
  const r = await callRouter(routerRuntime, routerModel, []);
  record("q1", i, [], r);
}

console.log("\n=== Q2/Q3: 3 FULL REAL RUNS (router decides every step, real agent sessions) ===");
for (let i = 1; i <= 3; i++) {
  await runFullRun(`full-${i}`, routerRuntime, routerModel);
}

console.log("\n=== Q4: hand-constructed 'no bug found' edge case ===");
const edgeHistory: HistoryEntry[] = [
  { role: "coder", summary: "wrote generated/mergeIntervals-edge.ts (612 chars). Implemented mergeIntervals by sorting on start and merging overlaps; added 3 basic test cases." },
  { role: "reviewer", summary: "review: No issues found, implementation looks correct." },
];
const edgeResult = await callRouter(routerRuntime, routerModel, edgeHistory);
record("edge", 1, edgeHistory, edgeResult);

console.log("\n=== FULL DECISION TABLE ===");
for (const d of allDecisions) {
  console.log(JSON.stringify(d));
}

await Bun.write("generated/q19-decisions.json", JSON.stringify(allDecisions, null, 2));
console.log(`\nWrote ${allDecisions.length} decisions to generated/q19-decisions.json`);
