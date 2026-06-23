/**
 * The `rlm_query` recursion bridge.
 *
 * A child RLM gets its own sandbox and iterates over the prompt as its context. At/over the
 * depth cap it degrades to a plain `llm_query` (ported from rlm/core/rlm.py `_subcall`). The
 * concurrency pool bounds parallel children for `rlm_query_batched`.
 */

import type { RunRlm } from "../core/types.ts";
import type { LlmBridge } from "./llm-query.ts";
import { mapPool } from "../util/concurrency.ts";

export interface RlmHandlers {
  rlmQuery(prompt: string, model: string | null, depth: number): Promise<string>;
  rlmQueryBatched(prompts: string[], model: string | null, depth: number): Promise<string[]>;
}

export interface RlmBridgeOptions {
  run: RunRlm;
  llm: LlmBridge;
  maxDepth: number;
  maxConcurrent: number;
  /** AgentTree node of the current run; recursive children attach under it. */
  parentNodeId?: string;
  /** Returns the parent's remaining budget/timeout for seeding child runs. */
  remainingBudget?: () => { budgetUsd?: number; timeoutMs?: number };
  /** Called with a child run's total cost/tokens so the parent LimitGuard debits it. */
  onChildUsage?: (costUsd: number, inputTokens: number, outputTokens: number) => void;
  /** Workspace root inherited by recursive children for filesystem tools. */
  workspaceRoot?: string;
}

export function createRlmHandlers(opts: RlmBridgeOptions): RlmHandlers {
  async function child(prompt: string, model: string | null, depth: number): Promise<string> {
    const childDepth = depth + 1;
    // At the cap, a child RLM would just be an LM — short-circuit to a one-shot llm_query.
    if (childDepth >= opts.maxDepth) return opts.llm.llmQuery(prompt, model, depth);
    try {
      const rem = opts.remainingBudget?.() ?? {};
      // Pre-spawn guard: refuse if the parent's budget or timeout is already exhausted
      // (reference: _subcall checks remaining_budget/timeout before spawning).
      if (rem.budgetUsd !== undefined && rem.budgetUsd <= 0) return "Error: budget exhausted";
      if (rem.timeoutMs !== undefined && rem.timeoutMs <= 0) return "Error: timeout exhausted";
      const res = await opts.run({
        rootPrompt: "",
        context: prompt,
        depth: childDepth,
        parentNodeId: opts.parentNodeId,
        smartModelOverride: model ?? undefined,
        remainingBudgetUsd: rem.budgetUsd,
        remainingTimeoutMs: rem.timeoutMs,
        workspaceRoot: opts.workspaceRoot,
      });
      opts.onChildUsage?.(res.costUsd, res.inputTokens, res.outputTokens);
      return res.answer;
    } catch (err) {
      return `Error: child RLM failed - ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    rlmQuery: (prompt, model, depth) => child(prompt, model, depth),
    rlmQueryBatched: (prompts, model, depth) => mapPool(prompts, opts.maxConcurrent, (p) => child(p, model, depth)),
  };
}
