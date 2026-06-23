/** `/rlm` — toggle persistent Recursive Language Model mode. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { postRlmGuide } from "../ui/intro.ts";
import { clearRlmStatus, setRlmModeStatus } from "../ui/status.ts";
import { createTreeWidget } from "../ui/tree-widget.ts";

export async function executeRlmRun(
  pi: ExtensionAPI,
  controller: RlmController,
  ctx: ExtensionContext,
  question: string,
  context: unknown,
  restoreModeStatus = true,
): Promise<void> {
  let handle;
  try {
    handle = controller.start(ctx, question, context);
  } catch (e) {
    ctx.ui.notify(`RLM failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }

  const { tree, done } = handle;
  ctx.ui.setWidget("rlm-tree", createTreeWidget(tree), { placement: "aboveEditor" });

  try {
    const result = await done;
    pi.sendMessage({
      customType: "rlm-answer",
      content: result.answer,
      display: true,
    });
  } catch (e) {
    ctx.ui.notify(`RLM failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    ctx.ui.setWidget("rlm-tree", undefined);
    if (restoreModeStatus) setRlmModeStatus(ctx.ui, controller);
    else clearRlmStatus(ctx.ui);
  }
}

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Toggle persistent RLM mode (route plain prompts through the RLM engine).",
    handler: async (_args, ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("rlm-stop", {
    description: "Abort the in-progress RLM run.",
    handler: async (_args, ctx) => {
      if (!controller.isBusy()) {
        ctx.ui.notify("No RLM run in progress.", "info");
        return;
      }
      controller.abort();
      ctx.ui.notify("RLM run aborted.", "info");
    },
  });

  pi.registerCommand("rlm-help", {
    description: "Show the RLM startup guide and command cheatsheet.",
    handler: async () => {
      postRlmGuide(pi, controller);
    },
  });

  pi.registerShortcut?.("ctrl+shift+r", {
    description: "Toggle RLM mode (off also stops a running query)",
    handler: async (ctx) => {
      const enabled = controller.toggle();
      setRlmModeStatus(ctx.ui, controller);
      ctx.ui.notify(`RLM mode ${enabled ? "ON" : "OFF"}`, "info");
    },
  });
}
