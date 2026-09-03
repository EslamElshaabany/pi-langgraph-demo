# Findings: Pi coding-agent SDK inside a LangGraph.js node, on Bun

Spike repo. Bun 1.3.11, Node 22.22.2 (unused). Packages: `@langchain/core@1.2.9`,
`@langchain/langgraph@1.4.13`, `@earendil-works/pi-coding-agent@0.84.4`,
`@earendil-works/pi-ai@0.84.4` — confirmed via npm registry as the current,
non-deprecated package names (`@mariozechner/pi-coding-agent` is npm-deprecated
in favor of `@earendil-works/pi-coding-agent`).

Model provider: Anthropic (`ANTHROPIC_API_KEY`), model `claude-haiku-4-5`
(and `claude-sonnet-5`/`claude-opus-4-5` where a second model was needed).
**Two other providers were tried first and both hit environment-specific
blockers unrelated to Bun/LangGraph/Pi** — worth knowing if you reproduce this
elsewhere:
- Gemini (`GEMINI_API_KEY`): Pi's Google provider calls `client.models.generateContentStream()` from Google's official SDK, which uses true SSE (`alt=sse`). In this sandbox, SSE to `generativelanguage.googleapis.com` hangs indefinitely and never returns a byte — reproduced with plain `curl -N`, independent of Bun or Pi. Non-streaming `generateContent` to the same host works fine. This is a sandbox network-proxy limitation, not a code bug.
- OpenCode Zen (`OPENCODE_API_KEY`, `opencode` provider in `@earendil-works/pi-ai` — one key, many models incl. Claude/GPT/Gemini): blocked entirely at this sandbox's network egress allowlist (`curl https://opencode.ai/` → `403 CONNECT tunnel failed`). No key fixes an allowlist block.

Run any script with `bun run src/qN-*.ts` (needs a valid `ANTHROPIC_API_KEY`
in a local `.env`, which is git-ignored).

---

## Q1 — Bun compatibility

**Verdict: WORKS**

Evidence (`src/q1-bun-langgraph.ts`):
```ts
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
const State = Annotation.Root({ text: Annotation<string> });
const graph = new StateGraph(State)
  .addNode("a", async (state) => ({ text: state.text + " -> a" }))
  .addNode("b", async (state) => ({ text: state.text + " -> b" }))
  .addEdge(START, "a").addEdge("a", "b").addEdge("b", END)
  .compile();
const result = await graph.invoke({ text: "start" });
```
Output: `RESULT: {"text":"start -> a -> b"}` — zero warnings, zero patches needed.

Notes: nothing to report. `bun run` on `@langchain/langgraph` v1.4.13 just works.

---

## Q2 — Pi SDK standalone

**Verdict: WORKS**

Evidence (`src/q2-pi-standalone.ts`):
```ts
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");
const { session } = await createAgentSession({ model, tools: [], modelRuntime, sessionManager: SessionManager.inMemory() });
session.subscribe((event) => { /* accumulate text_delta */ });
const result = await session.prompt("Reply with exactly the word: PONG");
```
Output:
```
PID (this process, no child pi binary spawned): 1771
session.prompt() return value: undefined
assistant reply (via subscribe): "PONG"
```
Confirmed in-process: same PID throughout, no `pi` CLI subprocess spawned (the
`pi` binary that ships with the npm package was never invoked).

Notes: `session.prompt()`'s own return value is `undefined` — it's a
completion signal, not a result carrier. The actual reply only comes through
`session.subscribe(event => ...)`. Also: **the SDK docs are wrong/stale** —
they show `import { getModel } from "@earendil-works/pi-ai"`, but
`getModel` is not exported from that package at all (verified via
`Object.keys()` on the installed module). It's a method on the runtime
instance: `modelRuntime.getModel(providerId, modelId)`.

---

## Q3 — The actual seam (the point of this spike)

**Verdict: WORKS, with one real awkwardness**

Evidence (`src/q3-seam.ts`) — full 2-node graph, node A writes a file with
its own Pi session, node B reviews it with a completely separate Pi session,
communicating only through `Annotation.Root` state:
```ts
async function nodeA(_state) {
  const session = await newSession(["write"]);
  await session.prompt("Write a JavaScript file at exactly generated/add.js ...");
  return { filePath: "generated/add.js" };
}
async function nodeB(state) {           // only ever touches `state`
  const session = await newSession(["read"]);
  await session.prompt(`Read the file at ${state.filePath} and give one sentence of review comments.`);
  return { review: comments };
}
```
Output:
```
FINAL STATE: {
 "filePath": "generated/add.js",
 "review": "**Review comment:** This is a straightforward and functional implementation, but it lacks input validation (e.g., type checking or null/undefined handling) and has no documentation explaining its behavior or parameters."
}
--- file node A wrote ---
function add(a, b) {
  return a + b;
}
module.exports = add;
```
Node B never held any reference to node A's session — it's structurally
impossible in this code, since `nodeB` only receives `state` as an argument
and constructs its own `ModelRuntime`/session from scratch.

Notes — what's awkward: every node has to build its own `ModelRuntime` +
`createAgentSession` from the ground up (5-6 lines of boilerplate each,
factored here into a shared `newSession()` helper). There's no natural
place in LangGraph's node signature `(state) => update` to inject shared
config (model, tool policy, auth) — you either recreate it per node call
(cost: a fresh `ModelRuntime.create()` and auth check every single node
invocation) or reach for module-level constants/closures, which is exactly
the kind of implicit coupling the spike's own constraint ("node B must not
hold any reference to node A's session") is trying to avoid at the session
level, so it just moves the coupling problem to config level instead. This
gets more awkward, not less, once you want per-node model/tool/thinking-level
variation (Q4/Q5), since now the boilerplate isn't even copy-pasteable.

---

## Q4 — Per-session model control

**Verdict: WORKS, but only fully verified for different-model-same-provider
(different-provider was blocked by this sandbox's network, see header)**

Evidence (`src/q4-model-control.ts`):
```ts
const sessionA = (await createAgentSession({ model: modelRuntime.getModel("anthropic", "claude-haiku-4-5"), ... })).session;
const sessionB = (await createAgentSession({ model: modelRuntime.getModel("anthropic", "claude-sonnet-5"), ... })).session;
await sessionA.setModel(modelRuntime.getModel("anthropic", "claude-opus-4-5"));
```
Output:
```
sessionA model (construction): claude-haiku-4-5
sessionB model (construction): claude-sonnet-5
sessionA model before setModel: claude-haiku-4-5
sessionA model after setModel: claude-opus-4-5
sessionA reply after runtime switch: "SWITCHED"
sessionA model actually used for that call: claude-opus-4-5
```
Confirms: (1) different sessions can be constructed with different models
independently — proven with two live sessions side by side; (2) a session's
model can be changed **at runtime**, not just at construction, via
`session.setModel()`, and the switch actually takes effect on the next call.

Notes: this is load-bearing per your note, so the caveat matters — I could
only prove cross-*model* control (haiku/sonnet/opus, all `anthropic`
provider) end-to-end with a live API call, not cross-*provider* (e.g.
Anthropic session next to a Gemini session in the same run), because Gemini
and OpenCode Zen were both network-blocked in this sandbox (see header).
That said, nothing in the API shape suggests provider-switching is special —
`modelRuntime.getModel(providerId, modelId)` takes an arbitrary provider id,
and `ModelRuntime` uniformly manages auth for ~38 providers (confirmed via
`modelRuntime.getProviders()`) — so this is a sandbox-network limitation on
verification, not a sign of an SDK limitation. Re-run this exact script with
`getModel("openai", ...)` or similar in an unblocked environment to close
the gap.

---

## Q5 — Tool restriction

**Verdict: WORKS**

Evidence (`src/q5-tool-restriction.ts`):
```ts
const { session } = await createAgentSession({
  model, tools: ["read", "grep", "find", "ls"], // no write, no bash
  modelRuntime, sessionManager: SessionManager.inMemory(),
});
await session.prompt("Write a file at generated/should-not-exist.txt ...");
```
Output:
```
tool calls attempted: []
assistant text: "I don't have a tool available to write files. The tools I have access to are read-only:
- **read**: Read file contents
- **grep**: Search file contents
- **find**: Find files by pattern
- **ls**: List directory contents
..."
did generated/should-not-exist.txt get created?: false
```
The model never even attempted a tool call — the `write` tool simply doesn't
exist in its tool list, so it can't call it, and it says so in plain text.

Notes: clean, exactly as documented. `tools: [...]` is a real allowlist, not
just a suggestion the model can ignore.

---

## Q6 — Approval interception

**Verdict: DOESN'T WORK (no built-in prompt, but also no supported way for
an outer system to hook in through the public SDK)**

Evidence Part 1 — no approval prompt at all (`src/q6-approval.ts`):
```ts
const { session } = await createAgentSession({ model, tools: ["bash", "write"], ... });
await session.prompt('Run the bash command: echo "no approval needed"');
```
Output: `elapsed ms (no stdin attached to this process at all): 2317` /
`tool calls executed with zero approval prompt: ["bash"]` — the bash command
just ran. There was no stdin attached to this process at all, so if Pi tried
to prompt for approval it would have hung forever; instead it completed in
~2.3s (pure model latency).

Evidence Part 2 — no inline interception hook in the public SDK. Read
`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` directly:
`CreateAgentSessionOptions` accepts `cwd, agentDir, modelRuntime, model,
thinkingLevel, scopedModels, noTools, tools, excludeTools, customTools,
resourceLoader, sessionManager, settingsManager, sessionStartEvent` — **no
`extensions` field**. The `pi.on("tool_call", ...)` interception hook
documented for Pi's extension system does exist in the package
(`ExtensionRunner`, `InlineExtension`, `discoverAndLoadExtensions`,
`createExtensionRuntime` are all real exports), but `ExtensionRunner`'s
constructor requires an `ExtensionRuntime` + `ModelRegistry` that
`createAgentSession` builds and owns internally — it isn't handed back or
accepted as an injectable option.

Notes: this is the bluntest finding in the spike. Pi's own docs describe a
"no permission popups" philosophy and explicitly delegate sandboxing to the
embedding host — confirmed true in the sense that nothing blocks. But "the
embedding host can own the approval decision" is **not actually wired up**
in the version of the SDK tested here: there is no supported, public way to
intercept a tool call before it executes from inside `createAgentSession()`.
If you need this, you're currently looking at either (a) pre-restricting
`tools`/`excludeTools` per session (coarse, static, decided before the
prompt starts — this is real and works, see Q5) or (b) reaching into
undocumented internals (`_extensionRunner`, `extensionRunnerRef`) that
aren't part of the public API surface and could break on any patch release.
There is no middle ground today for "let the model choose a bash command,
but let my LangGraph node approve or veto it before it runs."

---

## Q7 — Interrupt + Pi

**Verdict: WORKS, with a significant caveat**

Evidence (`src/q7-interrupt.ts`):
```ts
async function piNode(state) {
  const { session } = await createAgentSession({ ... });
  await session.prompt("Reply with exactly the word: DRAFTED");
  const decision = interrupt({ question: "approve this?", piOutput: reply });
  return { piOutput: reply, approved: decision };
}
const checkpointer = new MemorySaver();
const graph = new StateGraph(State).addNode("piNode", piNode)... .compile({ checkpointer });
await graph.invoke({ ... }, config);                       // pauses at interrupt()
await graph.invoke(new Command({ resume: "yes" }), config); // resumes
```
Output:
```
--- first invoke (should pause at interrupt) ---
  [piNode] Pi session finished, about to call interrupt()
first result: {"piOutput":"","approved":"","__interrupt__":[{"id":"...","value":{"question":"approve this?","piOutput":"DRAFTED"}}]}
--- resuming with Command({ resume: 'yes' }) ---
  [piNode] Pi session finished, about to call interrupt()
  [piNode] resumed past interrupt() with: yes
second result: {"piOutput":"DRAFTED","approved":"yes"}
```
Pause and resume both work exactly as LangGraph's docs describe.

Notes — the caveat is real and expensive: **on resume, the entire node
function re-runs from the top**, including everything before the
`interrupt()` call. `"[piNode] Pi session finished..."` was logged twice —
once per invoke — meaning the Pi session was recreated and a second live
API call ("DRAFTED") was made on resume, purely to re-reach the same
interrupt point. Any side effect before `interrupt()` (writing a file,
calling an LLM, spending money) happens again on every resume. If you put a
Pi session before an `interrupt()` in a real graph, you need to either put
the interrupt *before* the Pi call, or make the Pi call idempotent/cached
yourself — LangGraph does not do this for you.

---

## Q8 — State visibility on checkpoint

**Verdict: WORKS (confirms expectation — only graph state is checkpointed)**

Evidence (`src/q8-checkpoint.ts`):
```ts
async function piNode(_state) {
  const { session } = await createAgentSession({ ... });
  await session.prompt("Reply with exactly the word: CHECKPOINTED");
  return { piReply: reply };            // only this plain string goes to state
}
const checkpointer = new MemorySaver();
// ... compile with checkpointer, invoke, then:
const snapshot = await graph.getState(config);
const tuple = await checkpointer.getTuple(config);
```
Output:
```
graph.getState(config).values: { "piReply": "CHECKPOINTED" }
keys present in checkpointed state: [ "piReply" ]
does checkpointed state contain any Pi session/message-history object? false
raw checkpoint.channel_values keys: [ "piReply", "__pregel_tasks" ]
```
Confirmed directly against the raw checkpoint object (not just the
convenience `getState()` wrapper): only `piReply` (the plain string
explicitly returned from the node) is checkpointed. Pi's internal session —
its full message history, tool-call log, event stream — is never touched by
LangGraph's checkpointer, because the node never returns it and LangGraph
has no visibility into objects that aren't part of the state update.

Notes: this cuts both ways for a real system. It means checkpoints stay
small and Pi session objects aren't forced through serialization (good —
`AgentSession` instances aren't obviously JSON-safe). It also means **if you
want Pi's conversation history to survive a checkpoint restore, you have to
persist it yourself** (e.g. via `SessionManager.create()`'s on-disk session
files, referenced by path/id in graph state, and reloaded manually in the
node) — LangGraph will not do it for you, and combined with the Q7 finding,
a resumed node gets a completely fresh Pi session by default, with no memory
of what the pre-interrupt session said.

---

## Summary

| # | Question | Verdict |
|---|---|---|
| 1 | Bun compatibility | WORKS |
| 2 | Pi SDK standalone | WORKS |
| 3 | The actual seam | WORKS (config-boilerplate-per-node is the friction) |
| 4 | Per-session model control | WORKS (cross-provider verification blocked by sandbox network, not the SDK) |
| 5 | Tool restriction | WORKS |
| 6 | Approval interception | DOESN'T WORK (no popup, but also no supported hook to own the decision) |
| 7 | Interrupt + Pi | WORKS (but re-runs pre-interrupt side effects, incl. Pi calls, on every resume) |
| 8 | State visibility | WORKS (only graph state persists; Pi session state is on you) |

The seam itself (Q3) is real and not fragile — this is not a "doesn't work"
result. The two things worth knowing before committing further: (1) there is
currently no way to have an outer system approve/veto a Pi tool call through
the public SDK (Q6), and (2) `interrupt()` combined with a Pi call before it
means that call runs again on every resume unless you design around it (Q7).
