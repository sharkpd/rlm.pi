import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEditToolDefinition, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import type { EditRegistry } from "../registry/edit-registry.ts";
import { countOccurrences } from "../text/edits.ts";
import { errorMessage, formatError } from "../util/errors.ts";

export const ApplyEditsToolParams = Object.freeze(Type.Object({
  ids: Type.Array(Type.String({ description: "A staged edit ID returned by stage_edit()." }), {
    description: "Staged edit IDs to apply.",
  }),
}));

export interface ApplyEditsFailure {
  readonly id: string;
  readonly error: string;
}

export interface ApplyEditsDetails {
  readonly status: "done" | "partial" | "error";
  readonly appliedIds: readonly string[];
  readonly errors: readonly ApplyEditsFailure[];
  readonly editDetails: readonly EditToolDetails[];
}

function statusFor(appliedCount: number, errorCount: number): ApplyEditsDetails["status"] {
  if (errorCount === 0) return "done";
  return appliedCount > 0 ? "partial" : "error";
}

function summarize(details: ApplyEditsDetails): string {
  const head = details.errors.length > 0
    ? `apply_edits: ${details.appliedIds.length} applied, ${details.errors.length} failed`
    : `apply_edits: ${details.appliedIds.length} applied`;
  if (details.errors.length === 0) return `${head}.`;
  const rows = new Array<string>(details.errors.length);
  for (let i = 0; i < details.errors.length; i++) {
    const error = details.errors[i];
    rows[i] = `${error.id}: ${error.error}`;
  }
  return `${head}.\n${rows.join("\n")}`;
}

export function createApplyEditsTool(editRegistry: EditRegistry): ToolDefinition<typeof ApplyEditsToolParams, ApplyEditsDetails> {
  return {
    name: "apply_edits",
    label: "Apply Edits",
    description: "Apply staged REPL edits by ID without re-typing file paths or edit bodies.",
    parameters: ApplyEditsToolParams,

    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ApplyEditsDetails>> {
      const appliedIds = new Array<string>(params.ids.length);
      const errors = new Array<ApplyEditsFailure>(params.ids.length);
      const editDetails = new Array<EditToolDetails>(params.ids.length);
      let appliedCount = 0;
      let errorCount = 0;
      let detailCount = 0;

      const editTool = createEditToolDefinition(ctx.cwd);
      for (let i = 0; i < params.ids.length; i++) {
        const id = params.ids[i];
        const edit = editRegistry.get(id);
        if (edit === undefined) {
          errors[errorCount] = { id, error: formatError("unknown edit id") };
          errorCount++;
          continue;
        }

        try {
          const fullPath = resolve(ctx.cwd, edit.path);
          const content = await readFile(fullPath, "utf8");
          const occurrences = countOccurrences(content, edit.oldText);
          if (occurrences !== 1) {
            errors[errorCount] = { id, error: formatError(`anchor occurs ${occurrences} times in ${edit.path}`) };
            errorCount++;
            continue;
          }

          const result = await editTool.execute(
            toolCallId,
            { path: edit.path, edits: [{ oldText: edit.oldText, newText: edit.newText }] },
            signal,
            undefined,
            ctx,
          );
          if (result.details !== undefined) {
            editDetails[detailCount] = result.details;
            detailCount++;
          }
          editRegistry.delete(id);
          appliedIds[appliedCount] = id;
          appliedCount++;
        } catch (error) {
          errors[errorCount] = { id, error: formatError(errorMessage(error)) };
          errorCount++;
        }
      }

      const details: ApplyEditsDetails = {
        status: statusFor(appliedCount, errorCount),
        appliedIds: appliedIds.slice(0, appliedCount),
        errors: errors.slice(0, errorCount),
        editDetails: editDetails.slice(0, detailCount),
      };
      return { content: [{ type: "text", text: summarize(details) }], details };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("apply_edits ")) + theme.fg("dim", args.ids.join(", ")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (details === undefined) return new Text("(no apply_edits details)", 0, 0);
      const summary = summarize(details);
      return new Text(theme.fg(details.status === "error" ? "error" : "success", summary), 0, 0);
    },
  };
}
