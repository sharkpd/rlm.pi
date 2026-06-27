/**
 * `propose_edits` — the main-agent-facing editing tool.
 *
 * Runs ONE RLM engine turn: the root model drives a generate→validate→revise
 * loop via `llm_query` from inside the REPL (RLM paper, Algorithm 1) and
 * returns the final unified diff through the `answer` object.
 *
 * After the run, the diff is handed to `reviewAndApplyEdits()` for the patch
 * popup + disk apply. The negotiation is NOT orchestrated from TypeScript —
 * that would be a separate engine per round (Flaw #3 of the RLM paper).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { RlmController } from "../mode/rlm-mode.ts";
import { reviewAndApplyEdits } from "../patch/index.ts";
import { validateToolParams, createProgressNotifier } from "./tool-utils.ts";
import { errorMessage } from "../util/errors.ts";
import type { ProposedDiffEdit } from "../sandbox/protocol.ts";
import { buildEditingRootPrompt } from "../prompts/editing.ts";
import { RlmEmitter } from "./rlm-events.ts";
import { RlmEventAggregator } from "./rlm-aggregator.ts";
import { type RlmDetails } from "./rlm-details.ts";
import {
  headlineStatusGlyph,
  renderCollapsedSubcallTree,
  renderExpandedSubcallTree,
} from "./subcall-render.ts";
import { formatCost, formatTokens, spinnerFrame } from "../ui/theme.ts";

// ── Parameter schema ──────────────────────────────────────────────────────

const ProposeEditsParams = Object.freeze(Type.Object({
  path: Type.String({ description: "Relative path of the file to edit or create" }),
  instruction: Type.String({ description: "What change to make and why" }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

/** Strip optional markdown fence that the model may wrap around the diff. */
function extractDiff(answer: string): string {
  const match = /```(?:diff)?\n([\s\S]*?)```/.exec(answer);
  return (match?.[1] ?? answer).trim();
}

/**
 * Ensure the diff has a `--- a/path` / `+++ b/path` header.
 * The model sometimes emits a bare `---` line with no filename; patch apply
 * needs the path to locate the target file.
 */
function ensureDiffHeader(diff: string, filePath: string): string {
  if (/^--- \S/m.test(diff)) return diff;
  const body = diff.replace(/^[-+]{3}\s*\n/gm, "");
  return `--- a/${filePath}\n+++ b/${filePath}\n${body}`;
}

function rootStats(details: RlmDetails, theme: Theme): string {
  const parts: string[] = [];
  parts.push(formatCost(details.totals.costUsd));
  parts.push(`${formatTokens(details.totals.tokens)} tok`);
  if (details.turns.current > 0) parts.push(`${details.turns.current} turn${details.turns.current > 1 ? "s" : ""}`);
  return theme.fg("dim", parts.join(" · "));
}

// ── Tool factory ──────────────────────────────────────────────────────────

export function createProposeEditsTool(
  controller: RlmController,
): ToolDefinition<typeof ProposeEditsParams, RlmDetails> {
  return {
    name: "propose_edits",
    label: "Propose Edits",
    description: [
      "Generate, validate, and apply a code edit via recursive agent negotiation.",
      "Runs a single RLM turn where the model drives a generate→validate→revise loop via",
      "llm_query, then shows a patch preview before applying.",
      "Set yolo=true in /rlm-config to skip the preview.",
    ].join(" "),
    parameters: ProposeEditsParams,

    async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
      const emptyDetails = (): RlmDetails => ({
        status: "error",
        rootPrompt: "",
        turns: { current: 0, max: 0 },
        subcalls: [],
        totals: { costUsd: 0, tokens: 0 },
      });

      const validation = validateToolParams(ProposeEditsParams, rawParams, "propose_edits", emptyDetails);
      if (!validation.ok) return validation.error;
      const { path: filePath, instruction } = validation.value;

      if (!filePath || filePath === "undefined" || filePath === "null") {
        return {
          content: [{ type: "text", text: `propose_edits requires a valid file path, got: "${filePath}"` }],
          details: emptyDetails(),
        };
      }

      // Read the target file — treat ENOENT as a new (empty) file so propose_edits
      // can also create files from scratch.
      const abs = resolve(ctx.cwd ?? process.cwd(), filePath);
      let fileContent: string;
      try {
        fileContent = await readFile(abs, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          return {
            content: [{ type: "text", text: `Cannot read ${filePath}: ${errorMessage(e)}` }],
            details: emptyDetails(),
          };
        }
        fileContent = "";
      }

      const fileContext = fileContent
        ? [`File: ${filePath}`, "```", fileContent, "```"].join("\n")
        : `File: ${filePath} (new file — does not exist yet, create it from scratch)`;
      const rootPrompt = buildEditingRootPrompt(instruction);

      // Wire up emitter → aggregator → onUpdate for live progress rendering
      const emitter = new RlmEmitter();
      const aggregator = new RlmEventAggregator(emitter, onUpdate ?? (() => {}));
      emitter.emitRootPrompt(rootPrompt);

      const progress = createProgressNotifier<RlmDetails>({
        onUpdate,
        getDetails: () => aggregator.getState(),
        isRunning: (details) => details.status === "running",
        renderText: () => `${spinnerFrame()} editing ${filePath}…`,
      });
      progress.start();

      let diff: string;
      try {
        const handle = controller.start(ctx, { kind: "fresh", rootPrompt, context: fileContext }, emitter);
        const rlmResult = await handle.done;
        diff = ensureDiffHeader(extractDiff(rlmResult.answer), filePath);
      } catch (e) {
        emitter.emitStatus("error");
        return {
          content: [{ type: "text", text: `Negotiation failed: ${errorMessage(e)}` }],
          details: aggregator.getState(),
        };
      } finally {
        progress.stop();
        aggregator.dispose();
        emitter.shutdown();
      }

      if (!diff.trim()) {
        return {
          content: [{ type: "text", text: "Negotiation produced no diff." }],
          details: { ...aggregator.getState(), status: "error" },
        };
      }

      const diffEdit: ProposedDiffEdit = { diff };
      await reviewAndApplyEdits([], [diffEdit], controller.config, ctx);

      return {
        content: [{ type: "text", text: "Edit proposed via recursive negotiation; see apply result above." }],
        details: { ...aggregator.getState(), status: "done" },
      };
    },

    renderCall(args, theme) {
      const preview = args.instruction.length > 60
        ? `${args.instruction.slice(0, 60)}…`
        : args.instruction;
      return new Text(
        [theme.fg("toolTitle", theme.bold("propose_edits ")), theme.fg("dim", `${args.path}: ${preview}`)].join(""),
        0, 0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as RlmDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const glyph = headlineStatusGlyph(details.status, theme);
      const header = `${glyph} ${theme.fg("toolTitle", theme.bold("propose_edits"))} · ${rootStats(details, theme)}`;

      if (!expanded) {
        let body = "";
        if (details.subcalls.length > 0) body = `\n${renderCollapsedSubcallTree(details.subcalls, theme)}`;
        const hint = details.status === "running" ? "" : `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(`${header}${body}${hint}`, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.subcalls.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Sub-calls ───"), 0, 0));
        container.addChild(renderExpandedSubcallTree(details.subcalls, theme));
      }
      if (details.answer) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Diff ───"), 0, 0));
        container.addChild(new Markdown(details.answer, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
  };
}
