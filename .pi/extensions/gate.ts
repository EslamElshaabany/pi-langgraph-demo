import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Permission gate: asks ctx.ui.confirm() before letting `bash` run.
// The actual approve/deny decision comes from whatever confirm()
// implementation the host binds via session.bindExtensions({ uiContext }).
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const ok = await ctx.ui.confirm("Approve bash?", JSON.stringify(event.input));
      if (!ok) return { block: true, reason: "denied by outer gate" };
    }
  });
}
