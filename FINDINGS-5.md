# Findings 5: Router selection quality on the real, locked demo scenario

Tests whether the ACTUAL router — a real LLM call with a forced structured
tool call, validated against the live registry — picks sensibly on the
locked demo scenario (`mergeIntervals`, 3 roles). Every prior spike used a
hardcoded `forceDecision` field standing in for a router
(`FINDINGS-3.md`); this spike builds and exercises the real thing for the
first time.

**Isolation, as scoped:** router, coder, reviewer, and auditor all run on
Anthropic `claude-haiku-4-5` — same provider, same model, everywhere in
this spike. Cross-provider diversity is a separate, deliberately untouched
question. Script: `src/q19-router-quality.ts` (~185 lines, on top of the
unmodified `newSession()` helper reused verbatim from `FINDINGS.md`).

**One real design decision worth flagging up front:** the registry the
task specifies has exactly 3 agents (coder, reviewer, auditor) — none of
them means "stop." But Q3/Q4 explicitly ask whether the router correctly
routes to END. A `select_agent` tool built strictly from the 3-agent
registry has no way to *express* "done." So the router's own candidate
enum in this script is the 3 real registry ids **plus one router-only
sentinel, `end`** ("nothing left to do — a prior step already confirmed
the task is complete"). `end` is never passed to `newSession()` — it isn't
a real agent, it's a termination signal, validated against the same
allow-list as everything else. This is a spike-script decision, not
something already load-bearing in the demo architecture — call it out if
implementing this for real, since ADR-008 will need an explicit answer for
"how does the router signal done" that isn't in the current registry
shape.

---

## Q1 — Turn 1, empty history, x5

**Verdict: GOOD**

5/5 picked `coder`. Reason strings, verbatim:

1. "Task requires implementing the mergeIntervals function and basic tests from scratch; coder should start the implementation."
2. "Task requires implementing the mergeIntervals function and basic tests from scratch."
3. "Initial task requires implementation of mergeIntervals function from scratch, so the coder should write the code first."
4. "Task requires implementing the mergeIntervals function with tests from scratch, so the coder should write the initial implementation."
5. "Starting fresh; the coder should implement the mergeIntervals function and basic tests first."

Every reason correctly identifies "nothing exists yet" as the deciding
fact, in different words each time (not a cached/templated answer) —
genuine reasoning over the empty-history state, not a fluke.

---

## Q2/Q3 — 3 full real runs, sequence judged as a whole

**Verdict: GOOD**

All 3 runs, entirely un-scripted after turn 1 (real Coder session writes
real code, real Reviewer session reads and reviews it, real Auditor
session reads the accumulated history and judges), independently
converged on the **identical, textbook-correct sequence**:

```
coder → reviewer → auditor → end
```

4 router calls per run, well under the 8-call safety cap — no run needed
it. Specific checks the task asked for:

- **Reviewer before coder produced anything?** No, in any run. Reviewer
  was only ever picked at step 2, after a real file with real content
  existed.
- **Auditor before reviewer got a chance to flag something?** No, in any
  run. Auditor was only ever picked at step 3, after a reviewer turn was
  in history.
- **Looped unproductively (same agent 3+ times, no new information)?** No.
  No agent ran more than once in any of the 3 runs — every step advanced
  the task.
- **Correctly recognized done and routed to END?** Yes, in all 3 runs,
  immediately after the auditor's turn, with reasons that correctly cited
  the auditor's specific confirmation (e.g. "The auditor confirmed in Turn
  3 that the task is complete, all tests pass...") rather than a generic
  "seems done."

The 3 coder sessions produced 3 independently-written, all-correct
implementations (1691, 1536, and 1242 chars; verified by reading
`generated/mergeIntervals-full-{1,2,3}.ts` — all sort-and-merge, all
correctly handle empty/single/overlapping/touching/unsorted cases with
their own test suites). The 3 reviewer sessions all found no issues
(genuinely, not by prompt-following alone — the code really has no bugs).
This is the least interesting-looking result but the most reassuring one:
a router good enough to be boring on the easy path is exactly what you
want, and Q4 below is what tests whether it also handles the case
designed to look tempting to loop on.

---

## Q4 — the "no bug found" edge case

**Verdict: GOOD**

Hand-constructed history (coder wrote code, reviewer said "No issues
found, implementation looks correct"), router called once:

> decision: `auditor`, reason: "Reviewer found no issues; auditor should
> perform final correctness check to confirm the implementation is
> complete and ready to ship."

Did not loop back to coder or reviewer. This is the case most likely to
tempt a router into "reviewer said nothing to fix, so... call reviewer
again to be sure?" or "no bugs means we're done, skip straight to end" —
it did neither; it took the one correct next step (auditor, not a repeat,
not a skip).

---

## Q5 — schema/enum reliability

**Verdict: GOOD — clean result, reported plainly**

Across all 18 router calls made in this spike (5 Q1 + 12 across the 3 full
runs + 1 edge case):

- **0 out of 18** returned an `agentId` outside the valid set
  (`coder`/`reviewer`/`auditor`/`end`). Zero misfires, zero fallback
  triggers.
- **0 out of 18** failed to call `select_agent` at all.

This is a real, not manufactured, clean result. The forcing mechanism
matters here and is worth being explicit about: `toolChoice` is set to
Anthropic's `{ type: "tool", name: "select_agent" }` (not the
provider-neutral `"auto"`/`"none"` that `pi-ai`'s generic
`ModelsSimpleStreamOptions` exposes — that neutral type has no forced-tool
value at all in this SDK version). With `{type:"tool",name:...}`, Anthropic
guarantees a `tool_use` block in the response; "the model didn't call the
tool" was never actually a possible failure mode for this run, and that's
worth knowing before trusting a clean 0/18 as evidence the *model* is
reliable — it's better read as evidence the *forcing mechanism* is
reliable. The fallback-clamp-to-`coder` code path (per `FINDINGS-3.md` Q7)
exists in the router and is exercised by unit-testable logic, but never
fired in this run because nothing invalid was ever returned.

---

## Q6 — latency

**Verdict: GOOD, fast enough not to be the pacing bottleneck**

Single router call (classification only, not agent work), across all 18
calls:

- min **852ms**, max **1232ms**, average **1031ms**
- Turn-1/empty-history calls specifically (Q1's 5 runs): 1232, 1051, 1112,
  1085, 1038ms

For comparison, a single coder turn (real file write, tool round-trip)
took several seconds each in this run (not separately instrumented here,
but visibly the dominant cost per full run — one router call is a small
fraction of one agent turn). On the same model, the router does not need
to be a separate cheaper/faster model to avoid dragging pacing — it is
already the fast part of each step. This isn't evidence that a cheaper
model wouldn't shave more time, just that latency budget pressure in the
demo will come from the agents' own work, not from routing overhead.

---

## Full decision table

All 18 router decisions made in this spike, run in order. `historyGiven`
is truncated here for table readability — the untruncated text (what the
router actually received) is in `generated/q19-decisions.json`, written by
the script on every run.

| Run | Step | History given (truncated) | Decision | Reason | Valid |
|---|---|---|---|---|---|
| q1 | 1 | (empty) | coder | "Task requires implementing the mergeIntervals function and basic tests from scratch; coder should start the implementation." | y |
| q1 | 2 | (empty) | coder | "Task requires implementing the mergeIntervals function and basic tests from scratch." | y |
| q1 | 3 | (empty) | coder | "Initial task requires implementation of mergeIntervals function from scratch, so the coder should write the code first." | y |
| q1 | 4 | (empty) | coder | "Task requires implementing the mergeIntervals function with tests from scratch, so the coder should write the initial implementation." | y |
| q1 | 5 | (empty) | coder | "Starting fresh; the coder should implement the mergeIntervals function and basic tests first." | y |
| full-1 | 1 | (empty) | coder | "Task requires implementing the mergeIntervals function and basic tests from scratch; coder should write the implementation." | y |
| full-1 | 2 | Turn 1 — coder: wrote generated/mergeIntervals-full-1.ts (1691 chars)... | reviewer | "Code has been written; now review it for correctness, edge cases, and code quality before final audit." | y |
| full-1 | 3 | + Turn 2 — reviewer: **Review: No issues found.**... | auditor | "Reviewer confirmed no issues found; auditor should perform final correctness check to confirm the task is complete and ready to ship." | y |
| full-1 | 4 | + Turn 3 — auditor: ✅ COMPLETE AND READY TO SHIP... | end | "The auditor has confirmed the task is complete and ready to ship with all requirements met and no remaining issues." | y |
| full-2 | 1 | (empty) | coder | "Task requires implementation of the mergeIntervals function with tests; the coder should write this code from scratch." | y |
| full-2 | 2 | Turn 1 — coder: wrote generated/mergeIntervals-full-2.ts (1536 chars)... | reviewer | "The coder has implemented the mergeIntervals function with tests; a reviewer should now check for correctness, edge cases, and code quality before final audit." | y |
| full-2 | 3 | + Turn 2 — reviewer: No issues found... | auditor | "The coder has implemented mergeIntervals and the reviewer has confirmed correctness and quality; final auditor check needed before completion." | y |
| full-2 | 4 | + Turn 3 — auditor: ✅ READY TO SHIP... | end | "The auditor has confirmed the implementation is complete, correct, and production-ready with no gaps or issues remaining." | y |
| full-3 | 1 | (empty) | coder | "No code has been written yet; the coder must implement the mergeIntervals function and basic tests." | y |
| full-3 | 2 | Turn 1 — coder: wrote generated/mergeIntervals-full-3.ts (1242 chars)... | reviewer | "The coder has already implemented mergeIntervals with a sorting and merging strategy; now we need a code review to verify correctness, test coverage, and identify any potential bugs or edge cases." | y |
| full-3 | 3 | + Turn 2 — reviewer: No issues found... | auditor | "The coder has implemented the solution and the reviewer found no issues; auditor should confirm all requirements are met and the task is ready to ship." | y |
| full-3 | 4 | + Turn 3 — auditor: TASK IS COMPLETE AND READY TO SHIP... | end | "The auditor confirmed in Turn 3 that the task is complete, all tests pass, the implementation is correct and optimal, and it is ready to ship." | y |
| edge | 1 | Turn 1 — coder: wrote generated/mergeIntervals-edge.ts (612 chars)...; Turn 2 — reviewer: No issues found, implementation looks correct. | auditor | "Reviewer found no issues; auditor should perform final correctness check to confirm the implementation is complete and ready to ship." | y |

---

## Summary

| # | Question | Verdict |
|---|---|---|
| 1 | Turn 1, empty history, x5 | GOOD — 5/5 `coder`, distinct genuine reasoning each time |
| 2/3 | 3 full real runs, sequence quality | GOOD — all 3 independently converged on `coder → reviewer → auditor → end`, no premature reviewer/auditor picks, no unproductive loops |
| 4 | "No bug found" edge case | GOOD — routed straight to `auditor`, no loop-back |
| 5 | Schema/enum reliability | GOOD — 0/18 misfires, 0/18 missing tool calls (forced via Anthropic `toolChoice: {type:"tool",...}`, not prompting alone) |
| 6 | Latency | GOOD — 852–1232ms per router call (avg 1031ms), well under a single agent turn; not the pacing bottleneck |

**Bottom line, stated bluntly as asked:** on this locked scenario, with
this model, the router is not just "technically valid" (no crashes, no
schema violations) — its choices are actually sensible: correct ordering,
correct recognition of completion, correct handling of the tempting
"reviewer said nothing's wrong" edge case, and reasons that reference the
actual history rather than generic boilerplate. Nothing here is a FAILED
spike. The one real caveat is architectural, not behavioral: the given
3-agent registry has no built-in way to say "done," so this script had to
invent a router-only `end` sentinel to test completion recognition at
all — whoever implements the real router needs an explicit answer for how
"stop" gets expressed, because it does not fall out of the registry as
specified.

**What this spike does NOT tell you**, scoped out on purpose: whether the
router (or any role) picks sensibly on a *different* model or provider
(that's the cross-provider question, still open); whether it holds up on
a harder task where reviewer genuinely finds bugs and a real fix-loop
(coder → reviewer → coder → reviewer → ...) is needed — every real run
here had a clean first-try implementation, so the "3+ repeats, no new
information" unproductive-loop check was never actually exercised against
a case that should loop at least once before succeeding; and whether
router quality holds at all under prompt injection or adversarial history
content, since all history here was either router-of-record fact or
literally hand-written by us for Q4.
