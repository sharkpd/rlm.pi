/**
 * The `rlm_repl` tool — the single tool the root model uses in native RLM mode.
 *
 * Each call runs one Python snippet in the persistent sandbox. Sub-LLM calls made inside the
 * snippet are serviced mid-exec by the bridge. When the snippet flips `answer["ready"]`, the
 * worker surfaces the final answer and we return `terminate: true` to end pi's agent loop.
 */

import { Type } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { RlmController } from "../mode/rlm-mode.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import { truncateOutput } from "../text/parsing.ts";
import { renderReplCall, renderReplResult } from "../ui/repl-render.ts";

const Params = Type.Object({
  code: Type.String({ description: "Python to run in the persistent RLM REPL. Use print(...) to see output." }),
});

function formatForModel(res: ReplResult): string {
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(truncateOutput(res.stdout));
  if (res.stderr.trim()) parts.push(`[stderr]\n${truncateOutput(res.stderr, 8000)}`);
  if (parts.length === 0) parts.push("(no output — remember to print(...) what you want to see)");
  return parts.join("\n");
}

export function createReplTool(controller: RlmController) {
  return {
    name: "rlm_repl" as const,
    label: "RLM REPL",
    description:
      "Execute Python in the persistent RLM sandbox. `context` holds your input; `llm_query`/" +
      "`llm_query_batched` (and `rlm_query`) call sub-LLMs; submit by setting answer['content'] and " +
      "answer['ready']=True.",
    parameters: Params,
    async execute(
      _toolCallId: string,
      params: { code: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<ReplResult> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<ReplResult>> {
      const run = controller.current();
      if (!run) throw new Error("RLM mode is not active. Start a run with /rlm <question>.");

      const res = await run.sandbox.exec(params.code);
      controller.tick();

      if (res.finalAnswer != null) {
        await controller.finishNative();
        return {
          content: [{ type: "text" as const, text: res.finalAnswer }],
          details: res,
          terminate: true,
        };
      }

      const { maxIterations } = controller.config;
      if (run.turns >= maxIterations + 2) {
        await controller.finishNative();
        const best = res.stdout.trim() || "(no answer produced before the iteration limit)";
        return { content: [{ type: "text" as const, text: best }], details: res, terminate: true };
      }

      let text = formatForModel(res);
      if (run.turns >= maxIterations) {
        text += `\n\n[RLM: you are at the turn limit (${run.turns}/${maxIterations}). Submit your best answer NOW by setting answer['content'] and answer['ready']=True.]`;
      }
      return { content: [{ type: "text" as const, text }], details: res };
    },
    renderCall: (args: { code: string }, theme: Theme) => renderReplCall(args.code, theme),
    renderResult: (result: { details?: ReplResult }, _opts: unknown, theme: Theme) =>
      renderReplResult(result.details ?? { stdout: "", stderr: "", finalAnswer: null, executionTimeMs: 0, localsKeys: [] }, theme),
  };
}
