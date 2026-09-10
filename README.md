# pi-langgraph-demo

Throwaway spike code, not a real project. Answers a series of yes/no
questions about running the [Pi coding-agent SDK](https://pi.dev)
(`@earendil-works/pi-coding-agent`) inside [LangGraph.js](https://github.com/langchain-ai/langgraphjs)
nodes, under [Bun](https://bun.sh). The actual results are written up in
`FINDINGS.md`, `FINDINGS-2.md`, `FINDINGS-3.md`, and `FINDINGS-4.md` — read
those for the conclusions. This README is just "how do I run any of this
myself."

## Setup

1. **Install [Bun](https://bun.sh)** if you don't have it.
2. **Install dependencies:**
   ```
   bun install
   ```
3. **Add a model provider API key.** Create a `.env` file in the repo root
   (already git-ignored) with at least one of:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Everything in this repo was run against Anthropic (`claude-haiku-4-5`,
   plus `claude-sonnet-5`/`claude-opus-4-5` where a script needs a second
   model). Other providers work too — `ModelRuntime` picks up whichever
   `*_API_KEY` env var matches — but see `FINDINGS.md`'s header for two
   providers (Gemini, OpenCode Zen) that hit *this specific sandbox's*
   network restrictions during the original spike; that's an environment
   detail, not a code issue.
4. **For the tool-approval-gate scripts** (`q9`, `q11`, `q17` — anything
   using `.pi/extensions/gate.ts` + `bindExtensions()`), Pi's project-local
   extension auto-discovery requires the project to be trusted. Either
   answer the interactive trust prompt if one appears, or set it globally
   ahead of time:
   ```
   mkdir -p ~/.pi/agent
   echo '{ "defaultProjectTrust": "always" }' > ~/.pi/agent/settings.json
   ```
   Without this, `.pi/extensions/gate.ts` silently won't load and those
   scripts won't demonstrate what they claim to (see `FINDINGS-2.md` for
   why this is required at all).

## Running a script

Each spike question is its own standalone script, runnable directly:
```
bun run src/q3-seam.ts
```
or via the matching `package.json` script name (same thing, shorter):
```
bun run q3
```
There's no test runner and no shared entrypoint — every script prints its
own evidence (state, file contents, timestamps, thrown errors) to stdout,
which is what got copied into the `FINDINGS*.md` files. Some scripts write
real files under `generated/` (git-ignored) as part of their proof; re-running
a script is safe and just overwrites them.

Typecheck everything (sanity check only, not required to run anything):
```
bunx tsc --noEmit
```

## What's where

| Script | Question | Findings doc |
|---|---|---|
| `q1-bun-langgraph.ts` | Does `@langchain/langgraph` run under `bun run`? | `FINDINGS.md` |
| `q2-pi-standalone.ts` | Pi session via SDK, in-process, no CLI subprocess | `FINDINGS.md` |
| `q3-seam.ts` | Pi session inside a LangGraph node (the core seam) | `FINDINGS.md` |
| `q4-model-control.ts` | Per-session model selection, construction + runtime | `FINDINGS.md` |
| `q5-tool-restriction.ts` | Restricting which tools a session can use | `FINDINGS.md` |
| `q6-approval.ts` | Does Pi prompt for tool approval on its own? | `FINDINGS.md` |
| `q7-interrupt.ts` | LangGraph `interrupt()` + a Pi session in the node | `FINDINGS.md` |
| `q8-checkpoint.ts` | What actually gets checkpointed | `FINDINGS.md` |
| `q9-extension-ui-inprocess.ts` | In-process tool-approval interception via `bindExtensions()` | `FINDINGS-2.md` |
| `q10-dynamic-routing.ts` | Registry-driven nodes + `addConditionalEdges` | `FINDINGS-3.md` |
| `q11-dynamic-seam-and-gate.ts` | Real Pi session + approval gate inside a dynamically-routed node | `FINDINGS-3.md` |
| `q12-fallback.ts` | Fallback behavior for an invalid router decision | `FINDINGS-3.md` |
| `q13-fanout-mechanics.ts` | `Send`-based concurrent fan-out — genuine concurrency? | `FINDINGS-4.md` |
| `q14-session-isolation.ts` | N concurrent `newSession()` calls, cross-contamination? | `FINDINGS-4.md` |
| `q15-state-collision.ts` | Concurrent writes to shared vs. namespaced state keys | `FINDINGS-4.md` |
| `q16-same-agent-concurrent.ts` | Two concurrent instances of the same agent id | `FINDINGS-4.md` |
| `q17-approval-concurrent.ts` | Approval gate under concurrency, cross-talk? | `FINDINGS-4.md` |
| `q18-wave-completion.ts` | Wave completion timing, partial failure behavior | `FINDINGS-4.md` |

`.pi/extensions/gate.ts` is the shared tool-approval extension used by
`q9`, `q11`, and `q17` (see setup step 4 above). `generated/` is scratch
output from various scripts, git-ignored.
