# Findings 4: Concurrent Fan-Out — Session Isolation Under Dynamic Dispatch

Tests whether ADR-009's proposed widening — a router returning
`{agentId, task}[]` dispatched as N concurrent node invocations in one
super-step — is actually safe under Bun, not just assumed safe. Same repo,
same deps (`@langchain/langgraph@1.4.13`), same `newSession()` helper
(`FINDINGS.md` Q3), same deny-gate extension (`FINDINGS-2.md`,
`.pi/extensions/gate.ts`, still project-trusted from spike 2).

The fan-out primitive used throughout: `Send`, exported directly from
`@langchain/langgraph` (`new Send(nodeName, args)` from a conditional edge,
returning an array dispatches N parallel tasks into the target node for one
super-step — this is the library's own documented mechanism for exactly
this pattern, not something improvised for this spike).

| # | Question | Verdict |
|---|---|---|
| 1 | Fan-out mechanics — genuine concurrency, not serial-disguised-as-one-step | **PASS** |
| 2 | Session isolation — N concurrent `newSession()` calls, no cross-contamination | **PASS** |
| 3 | State-write collision — shared key vs. namespaced key | **PASS** (namespaced works; shared key fails loud, not silent) |
| 4 | Same agentId, concurrent instances | **PASS** |
| 5 | Approval gate under concurrency, no cross-talk | **PASS** |
| 6 | Wave completion / merge timing, including a throwing branch | **PASS with a serious gotcha** — see below |

---

## Q1 — fan-out mechanics

**Verdict: PASS**

`src/q13-fanout-mechanics.ts` — a router at `START` returns `Send[]` for 3
targets in one conditional edge; each invocation sleeps 300ms and logs its
own start/end timestamp:
```ts
graph = graph.addConditionalEdges(START, (state) => state.tasks.map((t) => new Send("worker", t)));
```
Output:
```
coder: start=1789022676377 end=1789022676679
reviewer: start=1789022676378 end=1789022676681
auditor: start=1789022676378 end=1789022676683
total wall time: 342ms (serial would be ~900ms, concurrent ~300ms)
```
All 3 starts within 1ms of each other; total wall time 342ms, not ~900ms.
This is proof by timing overlap, not "it didn't error" — a serial
implementation disguised as one step would take 3x as long and this test
would show it immediately.

---

## Q2 — session isolation

**Verdict: PASS**

`src/q14-session-isolation.ts` — 3 concurrent invocations, each calling
`newSession()` independently and writing a real file containing a unique
marker (`${agentId}-${Date.now()}-${random}`):
```
coder: file=generated/q14-coder.txt expected=coder-1789022693816-fasaqi actual=coder-1789022693816-fasaqi match=true
reviewer: file=generated/q14-reviewer.txt expected=reviewer-1789022693820-gy0rzw actual=reviewer-1789022693820-gy0rzw match=true
auditor: file=generated/q14-auditor.txt expected=auditor-1789022693820-tyy6d1 actual=auditor-1789022693820-tyy6d1 match=true
```
All 3 markers read back from disk after the run, matching exactly what
each session claimed to write, with no marker landing in the wrong file.
`newSession()`'s `ModelRuntime.create()` + `createAgentSession()` per call
produces genuinely independent objects under concurrent invocation — no
shared closures leaking state between branches.

---

## Q3 — state-write collision

**Verdict: PASS — and the failure mode for the naive approach is loud, not silent**

`src/q15-state-collision.ts`, attempt 1 — 3 concurrent branches writing to
the same un-reduced top-level key:
```ts
sharedResult: Annotation<string>, // no reducer - default LastValue channel
// ...
return { sharedResult: state.agentId }; // all 3 branches do this
```
Output:
```
THREW: InvalidUpdateError: Invalid update for channel "sharedResult" with values ["coder","reviewer","auditor"]: LastValue can only receive one value per step.
Troubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/INVALID_CONCURRENT_GRAPH_UPDATE/
```
Not last-write-wins, not a silent merge — a named, synchronous
`InvalidUpdateError` naming the exact channel and the exact conflicting
values, with a documentation link. This is a good failure mode: it's
impossible to ship ADR-009 with an undetected shared-key collision, because
LangGraph refuses to run rather than guess.

Attempt 2 — namespaced key via an explicit merge reducer:
```ts
results: Annotation<Record<string, string>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
// each branch: return { results: { [state.agentId]: `output-from-${state.agentId}` } };
```
Output:
```
"results": { "coder": "output-from-coder", "reviewer": "output-from-reviewer", "auditor": "output-from-auditor" }
all 3 keys present, no data lost: true
```
Clean, all 3 entries present. This is the pattern ADR-009 should mandate
for any state key that multiple fanned-out branches write to.

---

## Q4 — same agentId, concurrent instances

**Verdict: PASS**

`src/q16-same-agent-concurrent.ts` — two `Send("reviewer", ...)` dispatched
in the same wave, distinguished only by an `instanceId`, each writing its
own file:
```
instance A: instance-A
instance B: instance-B
```
No shared temp paths, no session-id collision, no file lock contention.
Two concurrent instances of the identical node/agentId behave exactly like
two unrelated nodes — `newSession()` doesn't cache or key anything by node
name, so there's nothing to collide.

---

## Q5 — approval gate under concurrency

**Verdict: PASS, no cross-talk**

`src/q17-approval-concurrent.ts` — two concurrent nodes both bind the
deny-gate mechanism from spike 2, one set to deny, one to allow, each with
its own marker file — chosen deliberately so cross-talk would be visible
(wrong file created, or expected file missing):
```
denier: confirm() called: decision=false title=Approve bash? message={"command":"touch generated/q17-denier-marker.txt"}
allower: confirm() called: decision=true title=Approve bash? message={"command":"touch generated/q17-allower-marker.txt"}

denier marker exists (should be false): false
allower marker exists (should be true): true
```
Each `confirm()` call received exactly its own instance's tool-call
message (denier's confirm never saw the allower's bash command or vice
versa), and each decision applied only to its own session. Two pending
approvals at once behaved as two fully independent gates — as expected,
since `bindExtensions()` is a per-`AgentSession` call and each concurrent
branch constructs its own session via `newSession()` (Q2's isolation
guarantee is what makes this one clean). Per the task's scope, this only
observes concurrent independent gates — no queuing/serialization of
approvals was built, none was needed to answer this question.

---

## Q6 — wave completion / merge timing

**Verdict: PASS on the happy path; a real gotcha on the failure path**

`src/q18-wave-completion.ts`, part A — 3 branches with staggered delays
(50ms / 300ms / 600ms):
```
invoke() resolved after 635ms (slowest branch was 600ms)
all results present: {"fast":"done at +50ms","medium":"done at +300ms","slow":"done at +600ms"}
```
Confirms `invoke()` waits for the *slowest* branch, not the fastest —
635ms ≈ 600ms + overhead, not close to 50ms.

Part B — 3 branches, one (`auditor`) throws after 100ms; the others
(`coder`, `reviewer`) succeed after 300ms:
```
invoke() THREW (whole wave failed): Error: intentional failure in auditor
coder's sentinel file exists despite the overall wave failing: true
--- checking .stream() for any partial state before the error ---
stream events: [ "STREAM THREW: Error: intentional failure in auditor" ]
```
**What this actually means, precisely:**
- `invoke()` rejects as soon as the *first* branch throws (~100ms here) —
  it does **not** wait for the other 300ms branches to finish before
  propagating the error. This is fail-fast, `Promise.all`-style behavior,
  not "wait for every branch, then report."
- The caller gets **no partial result at all** — the thrown error is the
  entire outcome; `result.results` never reaches the caller, even though
  two of the three branches would have succeeded 200ms later.
- `.stream()` behaves the same way: the only event that ever arrives is
  the thrown error. No `updates` event for the branches that completed
  before the throw was reported (in this exact timing; `coder`'s own
  write hadn't returned to the graph yet when the stream aborted).
- **The gotcha**: `coder`'s side effect (writing `generated/q18-coder-sentinel.txt`)
  **still happens** in the background and lands on disk, ~200ms *after*
  `invoke()` has already rejected and control has returned to the caller.
  Neither Bun nor LangGraph cancels an in-flight sibling branch when
  another branch in the same wave throws — there is no cooperative
  cancellation here, the sibling's promise just keeps running to
  completion, unobserved.

**Why this matters for ADR-009 specifically:** every branch in a fan-out
wave is a real Pi session that can write files, run bash, or call an LLM.
If any one branch throws, the graph reports total wave failure with zero
partial state — but sibling branches that were mid-flight do not stop,
and whatever side effects they were about to commit (a file write, a bash
command) still land, invisibly, after the caller has already moved on
believing the wave failed cleanly. A caller that retries the whole wave on
failure, assuming nothing landed, can get duplicate writes/duplicate bash
commands from the branches that actually completed. This needs an explicit
decision in ADR-009 (partial results back to the router, and/or
cancellation of in-flight siblings on first failure, and/or idempotent
per-branch side effects) — it isn't handled for you.

---

## What this confirms

- `Send`-based fan-out genuinely runs N node invocations concurrently in
  one super-step under Bun, not serially.
- Each concurrent invocation's `newSession()` call is fully isolated — no
  shared state, no cross-contamination, proven via real files read back
  from disk.
- Concurrent writes to an un-reduced shared state key fail loudly and
  specifically (`InvalidUpdateError`, not silent corruption); a namespaced
  key with a merge reducer is the correct, working pattern.
- Two concurrent instances of the *same* agentId are just two independent
  instances — nothing in `newSession()` or the Pi SDK keys anything by
  node/agent name that would cause collision.
- The `bindExtensions()` approval gate from spike 2 composes cleanly with
  concurrency — two simultaneous pending confirms stay fully independent.
- `invoke()` waits for the slowest successful branch on the happy path.

## What it broke

- Nothing broke in the sense of an unexpected crash or data corruption —
  every failure mode observed was either the intended, correct behavior
  (Q3's `InvalidUpdateError`) or a real but *reportable* gap (Q6).
- Q6 is the one place behavior genuinely surprised: a single branch
  throwing produces **zero partial results** and **no cancellation of
  siblings**, which together mean visible failure + invisible completed
  side effects can coexist after one `invoke()` call.

## Real gotchas hit along the way

- `Object.fromEntries(...)`-based pathMaps, `any`-typed loop registration,
  the `ExtensionUIContext` cast needing a `Partial<ExtensionUIContext>`
  spread to satisfy TS's overlap check — all carried over unchanged from
  spikes 2/3, still apply here, not re-litigated.
- The Q6 fail-fast-without-cancellation behavior was not something any
  spike so far had reason to surface; it only shows up once you combine
  concurrency with a throwing branch, which is exactly what this spike was
  for.

---

## What this changes for ADR-009

**Resolved:**
- The core mechanism — router → `Send[]` → N concurrent node invocations →
  merged state — works under Bun with real Pi sessions inside it. ADR-009
  is mechanically sound; nothing here blocks moving it toward Accepted.
- State design is settled: every field a fanned-out branch writes to must
  use a namespaced key with an explicit merge reducer (`Record<string, T>`
  + `{...a, ...b}` shape, or equivalent). A bare shared key is not a
  silent risk — LangGraph refuses to run and names the problem — but ADR-009
  should specify this pattern up front rather than let implementers
  discover the `InvalidUpdateError` themselves.
- Same-agentId concurrency needs no special handling; instance
  distinction (if needed) belongs in the `Send` args, not in any
  session/agent-identity mechanism.
- The approval gate (from spike 2) is safe to use inside fanned-out
  branches without modification.

**Still open:**
- **Partial-failure semantics.** ADR-009 needs to explicitly decide what
  happens when one of N branches fails: does the whole wave's `invoke()`
  reject (current default, with zero partial data returned to the
  router)? Should the router instead see a partial result and decide what
  to do with the failed branch? This spike didn't test a `try/catch`
  wrapper *inside* the worker node (catching its own errors and returning
  a `{results: {[agentId]: {error: ...}}}` update instead of throwing) —
  that's an available and probably better mitigation, but it's an
  implementation decision ADR-009 hasn't made yet, not something this
  spike can resolve on its own.
- **Sibling cancellation on failure.** Confirmed that a thrown branch does
  not cancel in-flight siblings, and their side effects still land after
  the caller has moved on. ADR-009 needs to decide whether this is
  acceptable (side effects are idempotent/safe to duplicate on retry) or
  whether some cancellation/idempotency mechanism needs to be designed —
  this spike surfaces the gap but intentionally does not build a fix
  (that's real harness work, out of scope here).
- **Approval-gate queuing under real concurrency at scale.** This spike
  confirmed 2 concurrent gates don't cross-talk; it did not test what a
  real outer approval UI/queue does when N is larger and approvals need
  to be shown to a human one at a time versus in parallel — noted in the
  original task as an explicitly separate, later decision.
