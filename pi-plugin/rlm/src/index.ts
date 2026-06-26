/** pi-rlm — Recursive Language Model for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { registerRlmCommand } from "./commands/rlm.ts";
import { registerRlmConfigCommand } from "./commands/rlm-config.ts";
import { createRlmTool } from "./tool/rlm-tool.ts";
import { loadSettings, mergeConfig } from "./config/settings.ts";
import { decideRlmInputRoute } from "./mode/input-router.ts";
import { RlmController } from "./mode/rlm-mode.ts";
import { postRlmGuide } from "./ui/intro.ts";
import { setRlmModeStatus } from "./ui/status.ts";

export default function rlmExtension(pi: ExtensionAPI): void {
  const persisted = loadSettings();
  const controller = new RlmController(mergeConfig(persisted.config));
  controller.savedSmartRef = persisted.smart;
  controller.savedWorkerRef = persisted.worker;

  pi.registerMessageRenderer(
    "rlm-answer",
    (message, _options, _theme) => new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );
  pi.registerMessageRenderer("rlm-question", (message, _options, _theme) =>
    new Markdown(`**RLM question**\n\n${String(message.content ?? "")}`, 1, 0, getMarkdownTheme()),
  );
  pi.registerMessageRenderer("rlm-intro", (message, _options, _theme) =>
    new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );

  registerRlmCommand(pi, controller);
  registerRlmConfigCommand(pi, controller);

  // Register RLM as a Pi tool for inline tool card rendering (replaces setWidget)
  pi.registerTool(createRlmTool(controller));

  let guidePosted = false;
  pi.on("session_start", async (_event, ctx) => {
    setRlmModeStatus(ctx.ui, controller);
    if (!guidePosted && controller.enabled) {
      guidePosted = true;
      postRlmGuide(pi, controller);
    }
  });

  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === "rlm-intro"),
    );
    if (!controller.enabled) return { messages: filtered };

    // Inject a standing directive so Claude knows it must delegate via the rlm tool.
    // Without this, Claude often handles requests directly using its own tools (e.g. zebra-mcp).
    const directive = {
      role: "user" as const,
      content:
        "[RLM MODE ACTIVE] You MUST call the `rlm` tool with the user's request as `prompt`. " +
        "Do not read files, search, or use any other tool. Only call rlm.",
      timestamp: 0,
    } as (typeof filtered)[number];
    return { messages: [directive, ...filtered] };
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    const decision = decideRlmInputRoute({ source: event.source, text }, { enabled: controller.enabled, busy: controller.isBusy() });
    if (decision === "continue") return { action: "continue" };
    if (decision === "busy") {
      ctx.ui.notify("RLM is busy (use /rlm-stop to cancel).", "warning");
      return { action: "handled" };
    }

    // Route through the RLM tool: explicit JSON parameters + no-other-tools directive.
    return {
      action: "transform",
      text: `[RLM] Call rlm({"prompt": ${JSON.stringify(text)}}) now. Do not use any other tools.`,
    };
  });

  pi.on("session_shutdown", async () => {
    controller.abort();
  });
}
