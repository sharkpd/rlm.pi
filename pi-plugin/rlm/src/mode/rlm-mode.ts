/**
 * RlmController — holds RLM config + chosen models.
 *
 * Two run modes:
 * - Native: startNative() spawns a sandbox; Pi's agent loop drives the root model via the
 *   `rlm_repl` tool; the controller owns the sandbox and system prompt.
 * - Engine: start() creates a headless engine (for recursive rlm_query children / future -p mode).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModelId } from "../config/settings.ts";
import { createEngine } from "../core/engine.ts";
import type { RlmConfig, RlmResult } from "../core/types.ts";
import { createLlmBridge } from "../bridge/llm-query.ts";
import { createRlmHandlers } from "../bridge/rlm-query.ts";
import { buildRlmSystemPrompt, type PromptMeta } from "../prompts/system.ts";
import { PythonSandbox } from "../sandbox/sandbox.ts";
import { AgentTree } from "../state/agent-tree.ts";
import { NOOP_OBSERVER, treeObserver } from "../state/events.ts";
import { contextLength, contextTypeLabel } from "../text/tokens.ts";

export function cheapestModel(registry: ModelRegistry): Model<Api> | undefined {
  const models = registry.getAvailable();
  if (models.length === 0) return undefined;
  return [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
}

export interface RunUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  subCalls: number;
}

export interface NativeRun {
  rootPrompt: string;
  meta: PromptMeta;
  sandbox: PythonSandbox;
  usage: RunUsage;
  turns: number;
  startedAt: number;
  abortController: AbortController;
}

export interface RunHandle {
  tree: AgentTree;
  abort: () => void;
  done: Promise<RlmResult>;
}

export class RlmController {
  smartModel: Model<Api> | undefined;
  workerModel: Model<Api> | undefined;
  savedSmartRef: string | undefined;
  savedWorkerRef: string | undefined;
  private nativeRun: NativeRun | null = null;
  private active: AbortController | null = null;

  constructor(public config: RlmConfig) {}

  isBusy(): boolean {
    return this.nativeRun !== null || this.active !== null;
  }

  current(): NativeRun | null {
    return this.nativeRun;
  }

  abort(): void {
    this.nativeRun?.abortController.abort();
    this.active?.abort();
  }

  systemPrompt(): string {
    if (!this.nativeRun) return "";
    return buildRlmSystemPrompt(this.nativeRun.meta, {
      transport: "tool",
      orchestrator: this.config.orchestrator,
      recursion: this.config.maxDepth > 1,
    });
  }

  tick(): NativeRun | null {
    if (this.nativeRun) this.nativeRun.turns += 1;
    return this.nativeRun;
  }

  async finishNative(): Promise<void> {
    if (!this.nativeRun) return;
    const run = this.nativeRun;
    this.nativeRun = null;
    await run.sandbox.dispose();
  }

  resolveModels(ctx: ExtensionContext): { smart: Model<Api>; worker: Model<Api> } | undefined {
    if (!this.smartModel && this.savedSmartRef) this.smartModel = resolveModelId(ctx.modelRegistry, this.savedSmartRef);
    if (!this.workerModel && this.savedWorkerRef) this.workerModel = resolveModelId(ctx.modelRegistry, this.savedWorkerRef);
    const smart = this.smartModel ?? ctx.model ?? cheapestModel(ctx.modelRegistry);
    if (!smart) return undefined;
    const worker = this.workerModel ?? cheapestModel(ctx.modelRegistry) ?? smart;
    return { smart, worker };
  }

  async startNative(ctx: ExtensionContext, rootPrompt: string, context: unknown): Promise<void> {
    await this.finishNative();

    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");

    const abortController = new AbortController();
    const usage: RunUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0, subCalls: 0 };

    const llm = createLlmBridge({
      workerModel: models.worker,
      registry: ctx.modelRegistry,
      maxPromptChars: this.config.maxPromptChars,
      maxConcurrent: this.config.maxConcurrentSubcalls,
      sampling: this.config.subSampling,
      signal: abortController.signal,
      onUsage: (u) => {
        usage.costUsd += u.cost.total;
        usage.inputTokens += u.input;
        usage.outputTokens += u.output;
        usage.subCalls += 1;
      },
    });

    const engine = createEngine({
      smartModel: models.smart,
      workerModel: models.worker,
      registry: ctx.modelRegistry,
      config: this.config,
      signal: abortController.signal,
      observer: NOOP_OBSERVER,
    });
    const rlm = createRlmHandlers({
      run: engine,
      llm,
      maxDepth: this.config.maxDepth,
      maxConcurrent: this.config.maxConcurrentSubcalls,
    });

    const sandbox = await PythonSandbox.spawn({
      depth: 1,
      execTimeoutS: this.config.execTimeoutS,
      requestTimeoutMs: this.config.requestTimeoutMs,
      python: this.config.python,
      signal: abortController.signal,
      handlers: { ...llm, ...rlm },
    });
    await sandbox.loadContext(context);

    this.nativeRun = {
      rootPrompt,
      meta: { contextType: contextTypeLabel(context), contextChars: contextLength(context), rootPrompt },
      sandbox,
      usage,
      turns: 0,
      startedAt: Date.now(),
      abortController,
    };
  }

  start(ctx: ExtensionContext, rootPrompt: string, context: unknown): RunHandle {
    const models = this.resolveModels(ctx);
    if (!models) throw new Error("no model with configured auth is available");

    const tree = new AgentTree();
    const abortController = new AbortController();
    this.active = abortController;

    const engine = createEngine({
      smartModel: models.smart,
      workerModel: models.worker,
      registry: ctx.modelRegistry,
      config: this.config,
      signal: abortController.signal,
      observer: treeObserver(tree),
    });

    const done = engine({ rootPrompt, context, depth: 0 }).finally(() => {
      if (this.active === abortController) this.active = null;
    });

    return { tree, abort: () => abortController.abort(), done };
  }
}
