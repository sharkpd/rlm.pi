/**
 * TUI rendering for `rlm_repl` tool calls and results.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ReplResult } from "../sandbox/protocol.ts";

/** Show a one-line preview of the code being executed. */
export function renderReplCall(code: string, theme: Theme): Text {
  const preview = code.replace(/\s+/g, " ").trim();
  const truncated = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
  return new Text(theme.fg("accent", `▶ rlm_repl: ${truncated}`), 0, 0);
}

/** Show stdout/stderr or the final answer from a repl execution. */
export function renderReplResult(res: ReplResult, theme: Theme): Text {
  if (res.finalAnswer != null) {
    const answer = res.finalAnswer.length > 200 ? `${res.finalAnswer.slice(0, 200)}…` : res.finalAnswer;
    return new Text(theme.fg("success", `✓ ${answer}`), 0, 0);
  }
  const parts: string[] = [];
  const out = res.stdout.trim();
  const err = res.stderr.trim();
  if (out) parts.push(theme.fg("muted", out.slice(0, 300)));
  if (err) parts.push(theme.fg("warning", `[stderr] ${err.slice(0, 200)}`));
  if (parts.length === 0) parts.push(theme.fg("dim", "(no output)"));
  return new Text(parts.join("\n"), 0, 0);
}
