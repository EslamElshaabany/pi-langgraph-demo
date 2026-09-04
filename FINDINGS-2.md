# Findings 2: Tool-approval interception via Pi's extension-UI protocol, in-process TypeScript

Follow-up to `FINDINGS.md` Q6, which concluded (correctly, for the path it
tried) that `createAgentSession()`'s options have no `extensions` field.
This spike went further into the actual source
(`node_modules/@earendil-works/pi-coding-agent/dist/**`, package version
`0.84.4`, same as before; `@earendil-works/pi-agent-core@0.84.4` present as
a transitive dep, not installed separately) to find a different
construction path. **One exists, and it works.**

## Verdict: REACHABLE WITH VETO POWER

Same PID throughout every test below — no `pi` binary spawned, no RPC
transport, no subprocess. Confirmed by direct `bun run` execution and by
reading the compiled source for every function used.

---

## The path (Q1)

Two things had to be found, neither of them exposed through
`createAgentSession()`'s documented options:

**1. `AgentSession.bindExtensions()` — a public, post-construction method.**
Found by reading `dist/core/agent-session.d.ts` directly:
```ts
bindExtensions(bindings: ExtensionBindings): Promise<void>
// ExtensionBindings = { uiContext?, mode?, commandContextActions?, onError? }
```
`uiContext` is an `ExtensionUIContext` — the same interface with
`confirm(title, message): Promise<boolean>`, `select()`, `input()`, etc.
that the RPC protocol's `extension_ui_request`/`on_ui_request` messages
(from the Python docs you cited) are a wire-format serialization of. In
other words: **RPC mode's `on_ui_request` and this in-process `uiContext`
are two transports for the same underlying `ExtensionUIContext` interface.**
RPC mode ships its own implementation that serializes calls to JSON over
stdout and waits for a JSON response on stdin — see
`dist/modes/rpc/rpc-mode.js`, which calls `takeOverStdout()` and hardcodes
`attachJsonlLineReader(process.stdin, ...)` with no injectable stream
(confirmed by reading the call site — the reader function itself is
generic, but `runRpcMode()` never lets you pass a substitute). `bindExtensions()`
lets you supply your own implementation directly as JS functions instead —
no serialization, no transport, no subprocess.

**2. A `pi.on("tool_call", ...)` handler still has to exist somewhere** —
`bindExtensions()` only supplies the UI *implementation*; something still
has to *call* `ctx.ui.confirm()` before a tool runs. `CreateAgentSessionOptions`
has no field for registering one inline. What does work: `createAgentSession({ cwd })`
auto-discovers and loads `.pi/extensions/*.ts` from the project directory
(confirmed via the returned `extensionsResult` — see Evidence below), the
same mechanism the CLI uses. So the extension lives in a real file
(`.pi/extensions/gate.ts` in this repo), and `bindExtensions()` from the
host process supplies the decision logic. This is a two-piece system:
extension code (what gets intercepted) + host-bound UI context (who
decides), not a single call.

**Caveat — project trust.** Project-local extensions "load only after the
project is trusted" (`docs/security.md`, `docs/settings.md`). Non-interactive
construction never shows a trust prompt; it falls back to the global
`defaultProjectTrust` setting (`"ask"` by default, which silently skips
loading protected resources — including `.pi/extensions` — in non-interactive
mode). `createAgentSession()` itself has **no parameter to override this
per-call**; the only per-call trust override (`projectTrustContext`) belongs
to the higher-level `createAgentSessionRuntime()` factory, not to plain
`createAgentSession()`. In this spike, trust was granted globally by writing
`~/.pi/agent/settings.json`: `{ "defaultProjectTrust": "always" }`. That's a
real, load-bearing setup step, not a two-line snippet — worth knowing before
assuming this "just works" in a fresh environment.

Evidence extension discovery actually happened:
```
extensionsResult: {
 "extensions": [ { "path": ".../.pi/extensions/gate.ts", "sourceInfo": { "source": "auto", "scope": "project" }, ... } ],
 "errors": []
}
```

---

## Q2 — real veto power

`.pi/extensions/gate.ts`:
```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const ok = await ctx.ui.confirm("Approve bash?", JSON.stringify(event.input));
      if (!ok) return { block: true, reason: "denied by outer gate" };
    }
  });
}
```
Host side, DENY:
```ts
await session.bindExtensions({ uiContext: noopUi({ confirm: async () => false }) });
await session.prompt(`Run bash: touch generated/gate-marker.txt`);
```
Output:
```
confirm() called with: Approve bash? {"command":"touch generated/gate-marker.txt"}
marker file exists after DENY (should be false): false
```
Host side, ALLOW (same code, `confirm: async () => true`):
```
marker file exists after ALLOW (should be true): true
```
Not "no error was thrown" — the actual OS-level side effect (a file
touched by real bash) provably did not happen on DENY and provably did
happen on ALLOW, from the same extension, same tool, only the confirm
return value changed.

---

## Q3 — timing: before, not after

```ts
session.subscribe((e) => {
  if (e.type === "tool_execution_start") events.push(`tool_execution_start ${Date.now()}`);
  if (e.type === "tool_execution_end") events.push(`tool_execution_end ${Date.now()}`);
});
await session.bindExtensions({ uiContext: noopUi({
  confirm: async () => { events.push(`confirm_called ${Date.now()}`); return true; },
}) });
```
Output:
```
event order: [ "tool_execution_start 1788482236979", "confirm_called 1788482236979", "tool_execution_end 1788482236984" ]
```
`confirm_called` lands between `tool_execution_start` and
`tool_execution_end` (5ms later, the actual bash exec time). One nuance:
`tool_execution_start` fires the instant the tool call is *initiated*, not
after it's approved — it marks "a call is pending," not "a call ran." The
DENY test above is the real proof of "before": no marker file appears, so
whatever `tool_execution_start` represents, the actual command never
reached the shell when `confirm()` returned `false`. This is true
interception, not after-the-fact logging.

---

## Q4 — fail-safe with no handler bound

Same extension loaded (still auto-discovered from `.pi/extensions/`), but
`bindExtensions()` is **never called** on this session at all:
```ts
const session = await newSession(); // gate.ts loaded, no uiContext ever bound
await session.prompt(`Run bash: touch generated/gate-marker.txt`);
```
Output:
```
elapsed ms: 3086
error/timeout: null
marker file exists (unbound confirm() outcome): false
```
No hang (well under the 15s race-timeout used to guard against exactly
that), no thrown error, normal latency (~3s is pure model round-trip time
seen elsewhere in this spike). The file was not created — confirms the
documented claim precisely: with no handler bound, `ctx.ui.confirm()`
resolves to a safe deny by default, in-process, no popup, no hang.

---

## Q5 — the `ask_question` tool: dead end

`ask_question` is **not a real built-in tool** in this package version —
zero matches anywhere under `dist/core/`. It appears only in doc *examples*
(`docs/sdk.md`, `docs/usage.md`) as an illustrative name for
`excludeTools`/`--exclude-tools`, describing it generically as "one
extension or built-in tool" without confirming it ships.

The closest real, shipped analog is `examples/extensions/question.ts`
(not auto-loaded — it's a reference example, and it registers itself as
`"question"`, not `"ask_question"`). Reading its `execute()`:
```ts
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  if (ctx.mode !== "tui") {
    return { content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }], ... };
  }
  // ...full custom TUI select/editor component via ctx.ui.custom(), never reached outside TUI mode
```
In SDK/non-interactive mode it short-circuits immediately with a plain
error string — it never calls any `ctx.ui` method, so there's nothing to
intercept and no `bindExtensions()` hook that changes its behavior. It's
built for an interactive terminal, full stop.

Verdict: **dead end for this purpose.** It's not the same mechanism as the
`tool_call` + `confirm()` gate proven above, and doesn't do anything useful
in-process.

---

## Minimal working example (deny + allow)

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// .pi/extensions/gate.ts (auto-discovered; project must be trusted -
// e.g. ~/.pi/agent/settings.json: { "defaultProjectTrust": "always" }):
//
//   export default function (pi) {
//     pi.on("tool_call", async (event, ctx) => {
//       if (event.toolName === "bash") {
//         const ok = await ctx.ui.confirm("Approve bash?", JSON.stringify(event.input));
//         if (!ok) return { block: true, reason: "denied by outer gate" };
//       }
//     });
//   }

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");

const { session } = await createAgentSession({
  model, tools: ["bash"], modelRuntime,
  sessionManager: SessionManager.inMemory(),
  cwd: process.cwd(), // must point at the dir containing .pi/extensions/
});

await session.bindExtensions({
  uiContext: {
    confirm: async () => false, // <- your approval decision here
    select: async () => undefined, input: async () => undefined, notify: () => {},
    onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {},
    setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
    setWidget: () => {}, setFooter: () => {},
  } as ExtensionUIContext,
});

await session.prompt("Run bash: touch should-not-exist.txt");
// file is never created - denied before execution
```

---

## Summary

| # | Question | Answer |
|---|---|---|
| 1 | Injection path exists in-process? | Yes — `AgentSession.bindExtensions({ uiContext })`, paired with a project-local `.pi/extensions/*.ts` file registering `pi.on("tool_call", ...)`. Requires project trust, which `createAgentSession()` has no per-call override for. |
| 2 | Real veto power? | Yes, provably — DENY leaves no OS-level trace, ALLOW does, same code path. |
| 3 | Before or after? | Before. `confirm()` resolves before the tool's actual execution; a deny prevents the execution entirely. |
| 4 | Fail-safe with no handler? | Confirmed safe-deny, no hang, no error, in-process. |
| 5 | `ask_question` tool? | Not real in this version; nearest analog is TUI-only and irrelevant to interception. |

This closes the question the first spike left open: an outer system **can**
own the tool-approval decision for an in-process Pi session, through
`bindExtensions()` — just not through `createAgentSession()`'s options
directly, and it needs an extension file on disk plus a project-trust
setting, not a single inline callback.
