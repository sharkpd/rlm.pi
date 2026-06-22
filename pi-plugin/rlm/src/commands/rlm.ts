/**
 * `/rlm` — run a Recursive Language Model over a (possibly huge) context.
 *
 * Usage:
 *   /rlm <question>                       run with no preloaded context
 *   /rlm --file a.txt --file b.txt <q>    load files as a list[str] context
 *   /rlm --paste <question>               open an editor to paste a large context
 *
 * Streams a live agent tree above the editor while the engine runs, then posts the answer.
 * `/rlm-stop` aborts an in-flight run.
 */

import { readFile, stat as fsStat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import { clearRlmStatus } from "../ui/status.ts";
import { formatCost, formatTokens } from "../ui/theme.ts";

interface ParsedArgs {
  files: string[];
  paste: boolean;
  question: string;
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const files: string[] = [];
  let paste = false;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--file" && tokens[i + 1]) files.push(tokens[++i]!);
    else if (t === "--paste") paste = true;
    else rest.push(t);
  }
  return { files, paste, question: rest.join(" ") };
}

async function loadContext(ctx: ExtensionCommandContext, parsed: ParsedArgs): Promise<unknown> {
  if (parsed.paste) return (await ctx.ui.editor("Paste RLM context", "")) ?? "";
  if (parsed.files.length === 0) return "";
  const contents = await Promise.all(
    parsed.files.map(async (f) => {
      try {
        const resolved = resolve(ctx.cwd, f);
        const rel = relative(ctx.cwd, resolved);
        if (rel.startsWith("..")) throw new Error(`--file ${f} escapes workspace`);
        const st = await fsStat(resolved);
        if (st.size > 10 * 1024 * 1024) throw new Error(`--file ${f} exceeds 10MB limit`);
        return await readFile(resolved, "utf8");
      } catch (e) {
        throw new Error(`could not read --file ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  return contents.length === 1 ? contents[0] : contents;
}

export function registerRlmCommand(pi: ExtensionAPI, controller: RlmController): void {
  pi.registerCommand("rlm", {
    description: "Run a Recursive Language Model over a (possibly huge) context.",
    handler: async (args, ctx) => {
      if (controller.isBusy()) {
        ctx.ui.notify("An RLM run is already in progress (use /rlm-stop to cancel).", "warning");
        return;
      }

      const parsed = parseArgs(args);
      let question = parsed.question;
      if (!question) question = (await ctx.ui.input("RLM question", "What should the RLM answer?")) ?? "";
      if (!question.trim()) {
        ctx.ui.notify("RLM: no question provided", "warning");
        return;
      }

      let context: unknown;
      try {
        context = await loadContext(ctx, parsed);
      } catch (e) {
        ctx.ui.notify(`RLM: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }

      try {
        await controller.startNative(ctx, question, context);
      } catch (e) {
        ctx.ui.notify(`RLM failed to start: ${e instanceof Error ? e.message : e}`, "error");
        return;
      }

      const statusTimer = setInterval(() => {
        const run = controller.current();
        if (!run) {
          clearInterval(statusTimer);
          clearRlmStatus(ctx.ui);
          return;
        }
        const u = run.usage;
        ctx.ui.setStatus(
          "rlm",
          `● RLM turn ${run.turns} · ${formatCost(u.costUsd)} · ${formatTokens(u.inputTokens + u.outputTokens)} tok · ${u.subCalls} sub-calls`,
        );
      }, 300);

      pi.sendUserMessage(question);
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
}
