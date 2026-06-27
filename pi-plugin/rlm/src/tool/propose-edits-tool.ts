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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RlmController } from "../mode/rlm-mode.ts";
import { reviewAndApplyEdits } from "../patch/index.ts";
import { validateToolParams } from "./tool-utils.ts";
import { errorMessage } from "../util/errors.ts";
import type { ProposedDiffEdit } from "../sandbox/protocol.ts";
import { buildEditingRootPrompt } from "../prompts/editing.ts";

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
  // Strip any bare `---` / `+++` lines the model may have put at the top
  const body = diff.replace(/^[-+]{3}\s*\n/gm, "");
  return `--- a/${filePath}\n+++ b/${filePath}\n${body}`;
}

// ── Parameter schema ──────────────────────────────────────────────────────

const ProposeEditsParams = Object.freeze(Type.Object({
  path: Type.String({ description: "Relative path of the file to edit" }),
  instruction: Type.String({ description: "What change to make and why" }),
}));

// ── Details (progressive state for rendering) ──────────────────────────────

export interface ProposeEditsDetails {
  readonly status: "idle" | "running" | "done" | "error";
}

// ── Tool factory ──────────────────────────────────────────────────────────

export function createProposeEditsTool(
  controller: RlmController,
): ToolDefinition<typeof ProposeEditsParams, ProposeEditsDetails> {
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

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const validation = validateToolParams(
        ProposeEditsParams,
        rawParams,
        "propose_edits",
        (): ProposeEditsDetails => ({ status: "error" }),
      );
      if (!validation.ok) return validation.error;
      const { path: filePath, instruction } = validation.value;

      if (!filePath || filePath === "undefined" || filePath === "null") {
        return {
          content: [{ type: "text", text: `propose_edits requires a valid file path, got: "${filePath}"` }],
          details: { status: "error" },
        };
      }

      // Read the target file — treat ENOENT as a new (empty) file so propose_edits
      // can also create files from scratch.
      const abs = resolve(ctx.cwd ?? process.cwd(), filePath);
      let fileContent: string;
      try {
        fileContent = await readFile(abs, "utf8");
      } catch (e) {
        const isNotFound = (e as NodeJS.ErrnoException).code === "ENOENT";
        if (!isNotFound) {
          return {
            content: [{ type: "text", text: `Cannot read ${filePath}: ${errorMessage(e)}` }],
            details: { status: "error" },
          };
        }
        fileContent = "";
      }

      // One engine run — the model negotiates generate→validate→revise itself
      // through llm_query inside the REPL, then returns the final diff.
      const fileContext = fileContent
        ? [`File: ${filePath}`, "```", fileContent, "```"].join("\n")
        : `File: ${filePath} (new file — does not exist yet, create it from scratch)`;
      const rootPrompt = buildEditingRootPrompt(instruction);

      let diff: string;
      try {
        const handle = controller.start(ctx, { kind: "fresh", rootPrompt, context: fileContext });
        const rlmResult = await handle.done;
        diff = ensureDiffHeader(extractDiff(rlmResult.answer), filePath);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Negotiation failed: ${errorMessage(e)}` }],
          details: { status: "error" },
        };
      }

      if (!diff.trim()) {
        return {
          content: [{ type: "text", text: "Negotiation produced no diff." }],
          details: { status: "error" },
        };
      }

      // Apply via the shared reviewer (popup + write)
      const diffEdit: ProposedDiffEdit = { diff };
      await reviewAndApplyEdits([], [diffEdit], controller.config, ctx);

      return {
        content: [{
          type: "text",
          text: "Edit proposed via recursive negotiation; see apply result above.",
        }],
        details: { status: "done" },
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
  };
}
