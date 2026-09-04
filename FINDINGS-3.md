# Findings 3: Dynamic agent selection via addConditionalEdges

Tests whether a registry-driven, runtime-routed LangGraph node behaves the
same as the hardcoded static graphs used in every prior spike. Same repo,
same deps (`@langchain/langgraph@1.4.13`), same `newSession()` pattern from
`FINDINGS.md` Q3, same approval gate from `FINDINGS-2.md`.

---

## Q1 — node registration from a list, not hardcoded calls

**Verdict: WORKS AT RUNTIME, WITH A REAL TYPESCRIPT CAVEAT**

Runtime evidence (`src/q10-dynamic-routing.ts`):
```ts
const registry = [{ id: "coder" }, { id: "reviewer" }, { id: "auditor" }];
let graph: any = new StateGraph(State);
for (const agent of registry) {
  graph = graph.addNode(agent.id, async (_state) => ({ log: [`entered:${agent.id}`] }));
}
```
Runs identically to hand-written `addNode` calls (see Q3/Q4 output below) —
`addNode()` is a plain mutating-then-returning method call at runtime, a
loop over it is not meaningfully different from writing it out three times.
ADR-006's "new agent = config entry" claim holds at the *runtime* level:
adding a 4th registry entry requires no other code changes to registration.

**The caveat, found while making this typecheck cleanly:** `addNode()`
returns a *new* `StateGraph<...>` generic instantiation each call, not
`this` (confirmed in
`node_modules/@langchain/langgraph/dist/graph/state.d.ts`). The library's
own idiom is one long fluent chain
(`new StateGraph(State).addNode(...).addNode(...)...`), which lets
TypeScript's inference accumulate the node-name union type as it goes. The
moment registration is split across separate statements — a `for` loop with
`graph = graph.addNode(...)` reassignment, **or** `registry.reduce(...)`
(both tried) — TypeScript has to compare two independently-derived
instantiations of that same deeply-generic type and gives up with:
```
error TS2719: Type 'StateGraph<...>' is not assignable to type 'StateGraph<...>'.
Two different types with this name exist, but they are unrelated.
```
This happens even though the reassignment is exactly what the return type
asks for — it's a real TypeScript limitation with this library's generic
shape, not a mistake in the code. It has zero runtime effect (proven by the
identical output before and after the fix below), but it means a
registry-driven graph-builder function, as ADR-006 presumably wants, cannot
be written with full static node-name checking using this version of
`@langchain/langgraph`. **The practical fix**, used in every script in this
spike: type the loop-built graph as `any` during registration, and let type
safety resume naturally at `compile()`/`invoke()`. Worth flagging to
whoever implements ADR-006's registry loader — it'll hit this immediately
and should know it's a known library limitation, not their bug.

---

## Q2 — a router node that decides at runtime

**Verdict: WORKS**

```ts
graph.addNode("router", async (state) => ({ selectedAgent: state.forceDecision, log: ["entered:router"] }));
```
Nothing notable — a router node is just a node. `forceDecision` is a
test-only field standing in for real selection logic, exactly as scoped
(no real router intelligence was built).

---

## Q3 — addConditionalEdges: does routing actually skip the other nodes

**Verdict: WORKS**

```ts
graph.addEdge(START, "router");
graph.addConditionalEdges("router", (state) => state.selectedAgent,
  Object.fromEntries(registry.map(a => [a.id, a.id])));
for (const agent of registry) graph.addEdge(agent.id, END);
```
Output (each node appends its own name to `log` on entry):
```
decision=coder -> log=["entered:router","entered:coder"]
```
Only `router` and the one selected node appear in the log — `reviewer` and
`auditor` never ran. Proven by omission, not by an "it didn't error"
assumption: the log is a positive record of what *did* execute, and the
unselected nodes are provably absent from it.

---

## Q4 — same compiled graph, three different decisions, no recompile

**Verdict: WORKS**

```ts
const compiled = graph.compile();
for (const decision of ["coder", "reviewer", "auditor"]) {
  const result = await compiled.invoke({ selectedAgent: "", log: [], forceDecision: decision });
  console.log(`decision=${decision} -> log=${JSON.stringify(result.log)}`);
}
```
Output:
```
decision=coder -> log=["entered:router","entered:coder"]
decision=reviewer -> log=["entered:router","entered:reviewer"]
decision=auditor -> log=["entered:router","entered:auditor"]
```
One `compile()` call, three `invoke()` calls, three different routes, each
correct. The graph is a static structure of *possible* paths decided once;
which path gets walked is a per-invoke runtime decision. No rebuild
required, exactly as ADR-008 assumes.

---

## Q5 — the actual seam, now dynamic

**Verdict: WORKS, identically to the static case**

Evidence (`src/q11-dynamic-seam-and-gate.ts`) — three registry entries, each
with a real `newSession()` (from `FINDINGS.md`'s helper) inside `run()`:
```ts
{
  id: "coder",
  async run(_state) {
    const session = await newSession(["write"]);
    await session.prompt("Write a file at exactly generated/q11-coder-output.txt containing the single line: dynamic seam works");
    return { output: "coder:wrote generated/q11-coder-output.txt" };
  },
},
```
Routed to via `forceDecision: "coder"` (not hardcoded as node 0 in the
edge graph - reached only through `addConditionalEdges`). Output:
```
result: {"selectedAgent":"coder","forceDecision":"coder","output":"coder:wrote generated/q11-coder-output.txt"}
real file content: dynamic seam works
```
Same proof standard as the original Q3: the file's actual content, read
back from disk after the graph run, not just "the node returned without
throwing." Same result routing to `"reviewer"` in the same run
(`result: {...,"output":"reviewer:REVIEWED"}`). No difference in behavior,
timing, or state visibility between a session inside a statically-wired
node and one reached via `addConditionalEdges`.

---

## Q6 — does the approval gate still work inside a dynamically-selected node

**Verdict: WORKS, composes cleanly**

The `"auditor"` registry entry (reached only on `forceDecision: "auditor"`,
i.e. never node 0, never hardcoded into a static edge) binds the same
deny-gate pattern as `FINDINGS-2.md`:
```ts
async run(_state) {
  const session = await newSession(["bash"]);
  await session.bindExtensions({ uiContext: denyUi() }); // confirm: async () => false
  await session.prompt(`Run bash: touch generated/q11-auditor-marker.txt`);
  return { output: "auditor:attempted bash under deny gate" };
},
```
Output:
```
result: {"selectedAgent":"auditor","forceDecision":"auditor","output":"auditor:attempted bash under deny gate"}
marker file exists after DENY inside dynamic node (should be false): false
```
The `.pi/extensions/gate.ts` file from spike 2 (still project-trusted via
the same `~/.pi/agent/settings.json` override) auto-loads into this
session exactly as before; `bindExtensions()` is a per-session call, so it
doesn't care whether the session was constructed inside a node that's
always run or one that's conditionally reached — it's just a method call
on an `AgentSession` object that exists at the time it's called, same as
any other node. Two independently-proven mechanisms compose with zero
friction.

---

## Q7 — fallback path when the router returns an unknown agent id

**Verdict: WORKS AS "THROWS", NOT AS "FALLS BACK" — no built-in default exists**

This is the one with real architectural consequences. Three things tested
in `src/q12-fallback.ts`:

**Attempt 1 — pathMap has no entry for the bad id, no default:**
```ts
graph.addConditionalEdges("router", (state) => state.selectedAgent,
  Object.fromEntries(registry.map(a => [a.id, a.id]))); // router returns "not-a-real-agent-id"
```
Output:
```
THREW: Error: Branch condition returned unknown or null destination
```
Hard, synchronous throw out of `invoke()` — not a hang, not a silent
no-op, not a skip to `END`. Confirmed via the actual thrown `Error`.

**Attempt 2 — pathMap includes a literal entry for the exact bad string:**
```ts
graph.addConditionalEdges("router", (state) => state.selectedAgent, {
  ...Object.fromEntries(registry.map(a => [a.id, a.id])),
  "not-a-real-agent-id": "fallback",
});
```
Output:
```
result: {"selectedAgent":"not-a-real-agent-id","log":["entered:router","entered:fallback"]}
```
This "worked" only because the bad value was known in advance and added as
its own exact-match dictionary key — **it is not a general fallback
mechanism.** Confirmed at the type level, not just empirically: reading
`node_modules/@langchain/langgraph/dist/graph/graph.d.ts` directly:
```ts
interface BranchOptions<IO, N extends string, ...> {
  source: N;
  path: RunnableLike$1<IO, BranchPathReturnValue, CallOptions>;
  pathMap?: Record<string, N | typeof END> | (N | typeof END)[];
}
```
`pathMap` is a plain `Record<string, ...>` (or array) — exact string keys
only. There is no `default`, no wildcard, no catch-all slot anywhere in the
type. A second unknown value that wasn't anticipated (tested as
`"some-other-bad-id"` in attempt 3, below) hits the exact same throw as
attempt 1.

**Attempt 3 — the router validates its own output before writing state:**
```ts
graph.addNode("router", async () => {
  const raw = "some-other-bad-id";
  const valid = registry.some(a => a.id === raw) ? raw : "fallback";
  return { selectedAgent: valid, log: [`entered:router (raw=${raw}, clamped=${valid})`] };
});
```
Output:
```
result: {"selectedAgent":"fallback","log":["entered:router (raw=some-other-bad-id, clamped=fallback)","entered:fallback"]}
```
This is the only approach that generalizes to *any* bad value, known or
not, because it never lets an unrecognized id reach `addConditionalEdges`
in the first place.

**Notes — the architectural consequence for ADR-008:** LangGraph's
conditional-edge mapping has no fallback/default destination concept.
"Route to a default node when the pick is invalid" is not something
`addConditionalEdges` can express in general — it can only be faked for
specific, pre-known bad values by adding them as literal dictionary
entries, which doesn't cover anything actually unanticipated (a typo'd
agent id, a hallucinated one, a registry entry that got removed after the
router was written against it). **The fallback has to live in the router
node's own logic** — validate `selectedAgent` against the live registry
before returning it from the router, clamp to a known-good fallback id
there, and only ever hand `addConditionalEdges` values that are guaranteed
to have a matching pathMap entry. If ADR-008 currently assumes LangGraph
provides this safety net structurally, it doesn't — it has to be written
into the router.

---

## Summary

| # | Question | Verdict |
|---|---|---|
| 1 | Registry-driven node registration | WORKS AT RUNTIME; breaks TS's static node-name checking (`TS2719`) unless the loop-built graph is typed `any` until `compile()` |
| 2 | Router node with runtime decision | WORKS |
| 3 | addConditionalEdges actually routes (proven by omission) | WORKS |
| 4 | Same compiled graph, 3 decisions, no recompile | WORKS |
| 5 | Real Pi session inside a dynamically-chosen node | WORKS, identical to static case |
| 6 | Approval gate inside a dynamically-chosen node | WORKS, composes cleanly with dynamic routing |
| 7 | Fallback for an invalid router decision | THROWS by default; no built-in default/wildcard path exists at the type level; fallback must be implemented in the router node itself |

Nothing about dynamic selection behaves differently from the static case
in timing, state visibility, or session mechanics at runtime — Q5 and Q6
are exact repeats of `FINDINGS.md` Q3 and `FINDINGS-2.md`'s gate test, just
reached through `addConditionalEdges` instead of a hardcoded edge, with
identical results. Two real findings for whoever implements ADR-006/
ADR-008: (1) LangGraph will not save you from a bad router decision — the
fallback has to be defensive code in the router itself, `addConditionalEdges`
has no default/wildcard path; (2) building the node registry from a runtime
loop, which is the whole premise of ADR-006, breaks this library's static
TypeScript node-name checking and needs an explicit `any` escape hatch
during registration — runtime behavior is unaffected, but don't expect the
compiler to catch a typo'd agent id for you.
