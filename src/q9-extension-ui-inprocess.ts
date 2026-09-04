// Follow-up spike: is Pi's extension-UI protocol (on_ui_request / ctx.ui.confirm)
// reachable in-process from TypeScript (same PID, no `pi` binary, no RPC)?
//
// Path found by reading node_modules source (not docs):
//   - CreateAgentSessionOptions has NO `extensions` field (confirmed in prior spike).
//   - BUT AgentSession has a PUBLIC post-construction method:
//       bindExtensions(bindings: ExtensionBindings): Promise<void>
//     where ExtensionBindings = { uiContext?, mode?, commandContextActions?, onError? }
//   - createAgentSession({ cwd }) auto-discovers project-local .pi/extensions/*.ts
//     (confirmed via extensionsResult in the previous run of this script), gated
//     by project trust (bypassed here via ~/.pi/agent/settings.json defaultProjectTrust:"always").
//   - .pi/extensions/gate.ts (this repo) registers `pi.on("tool_call", ...)` that
//     calls `ctx.ui.confirm(...)` before letting `bash` run.
//   - bindExtensions({ uiContext: { confirm: async () => boolean, ... } }) supplies
//     OUR OWN in-process implementation of confirm() - no RPC, no subprocess.
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("anthropic", "claude-haiku-4-5");

function noopUi(overrides: Partial<ExtensionUIContext>): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    ...overrides,
  } as ExtensionUIContext;
}

async function newSession() {
  return (await createAgentSession({
    model, tools: ["bash"], modelRuntime, sessionManager: SessionManager.inMemory(), cwd: process.cwd(),
  })).session;
}

const markerFile = "generated/gate-marker.txt";
async function reset() { try { await Bun.file(markerFile).unlink?.(); } catch {} try { await (await import("node:fs/promises")).rm(markerFile); } catch {} }

// ---------- Q2: real veto power - DENY ----------
console.log("=== DENY test ===");
await reset();
{
  const session = await newSession();
  const order: string[] = [];
  session.subscribe((e) => { if (e.type === "tool_execution_start") order.push("tool_execution_start:" + Date.now()); });
  const confirmCalledAt: number[] = [];
  await session.bindExtensions({
    uiContext: noopUi({
      confirm: async (title, message) => {
        confirmCalledAt.push(Date.now());
        console.log("  confirm() called with:", title, message);
        return false; // DENY
      },
    }),
  });
  await session.prompt(`Run bash: touch ${markerFile}`);
  console.log("  confirm() timestamps:", confirmCalledAt);
  console.log("  tool_execution_start events (should be ABSENT if truly blocked):", order);
  console.log("  marker file exists after DENY (should be false):", await Bun.file(markerFile).exists());
}

// ---------- Q2: real veto power - ALLOW ----------
console.log("=== ALLOW test ===");
await reset();
{
  const session = await newSession();
  await session.bindExtensions({ uiContext: noopUi({ confirm: async () => true }) });
  await session.prompt(`Run bash: touch ${markerFile}`);
  console.log("  marker file exists after ALLOW (should be true):", await Bun.file(markerFile).exists());
}

// ---------- Q3: timing - before or after? ----------
console.log("=== TIMING test ===");
await reset();
{
  const session = await newSession();
  const events: string[] = [];
  session.subscribe((e) => {
    if (e.type === "tool_execution_start") events.push(`tool_execution_start ${Date.now()}`);
    if (e.type === "tool_execution_end") events.push(`tool_execution_end ${Date.now()}`);
  });
  await session.bindExtensions({
    uiContext: noopUi({
      confirm: async () => { events.push(`confirm_called ${Date.now()}`); return true; },
    }),
  });
  await session.prompt(`Run bash: echo timing-check`);
  console.log("  event order:", events);
}

// ---------- Q4: fail-safe with NO handler bound ----------
console.log("=== FAIL-SAFE test (no bindExtensions call at all) ===");
await reset();
{
  const session = await newSession(); // gate.ts extension IS loaded (auto-discovered), but no uiContext ever bound
  const start = Date.now();
  let errored: string | null = null;
  try {
    await Promise.race([
      session.prompt(`Run bash: touch ${markerFile}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT after 15s - looks like a hang")), 15000)),
    ]);
  } catch (e) {
    errored = String(e);
  }
  console.log("  elapsed ms:", Date.now() - start);
  console.log("  error/timeout:", errored);
  console.log("  marker file exists (unbound confirm() outcome):", await Bun.file(markerFile).exists());
}

console.log("done");
