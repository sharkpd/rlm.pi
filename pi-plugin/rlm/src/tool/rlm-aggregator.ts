/**
 * RlmEventAggregator — builds RlmDetails from RlmEmitter events.
 *
 * Attaches as a listener to an RlmEmitter and accumulates sub-call lifecycle
 * events into a flat RlmSubcall[] array with O(1) running totals. Exposes
 * getState(): RlmDetails for direct access (spinner loop, final return).
 *
 * Replaces RlmToolBridge's internal state accumulation. The emitter is pure
 * dispatch; the aggregator is pure state. Separated for independent testing.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { RlmEmitter, SubcallCreatedEvent, SubcallUpdatedEvent, TurnEvent, RootUsageEvent, AnswerEvent, EditsEvent, StatusEvent, RootPromptEvent } from "./rlm-events.ts";
import type { RlmSubcall, RlmDetails, RlmRunStatus } from "./rlm-details.ts";

export class RlmEventAggregator {
  private readonly subcalls = new Map<string, RlmSubcall>();

  // Root-level state
  private rootStatus: RlmRunStatus = "running";
  private rootPrompt = "";
  private turnCurrent = 0;
  private turnMax = 0;
  private answer?: string;
  private edits: RlmDetails["edits"] = [];

  // Incremental running totals — O(1) getState()
  private totalCostUsd = 0;
  private totalTokens = 0;

  private readonly unsubs: (() => void)[];

  constructor(
    emitter: RlmEmitter,
    private readonly onChange?: AgentToolUpdateCallback<RlmDetails>,
  ) {
    this.unsubs = [
      emitter.onSubcallCreated((e) => this.handleSubcallCreated(e)),
      emitter.onSubcallUpdated((e) => this.handleSubcallUpdated(e)),
      emitter.onTurn((e) => this.handleTurn(e)),
      emitter.onRootUsage((e) => this.handleRootUsage(e)),
      emitter.onAnswer((e) => this.handleAnswer(e)),
      emitter.onEdits((e) => this.handleEdits(e)),
      emitter.onStatus((e) => this.handleStatus(e)),
      emitter.onRootPrompt((e) => this.handleRootPrompt(e)),
    ];
  }

  // ── Event handlers ──

  private handleSubcallCreated(event: SubcallCreatedEvent): void {
    this.subcalls.set(event.id, {
      id: event.id,
      parentId: event.parentId,
      kind: event.kind,
      label: event.label,
      model: event.model,
      status: "running",
      detail: event.detail,
      args: event.args,
      startedAt: Date.now(),
      costUsd: 0,
      tokens: 0,
    });
    this.notify();
  }

  private handleSubcallUpdated(event: SubcallUpdatedEvent): void {
    const sc = this.subcalls.get(event.id);
    if (!sc) return;

    if (event.status !== undefined) {
      sc.status = event.status;
      if (event.status !== "running") sc.endedAt = Date.now();
    }
    if (event.detail !== undefined) sc.detail = event.detail;
    if (event.args !== undefined) sc.args = event.args;
    if (event.resultPreview !== undefined) sc.resultPreview = event.resultPreview;
    if (event.costUsd !== undefined) {
      sc.costUsd += event.costUsd;
      this.totalCostUsd += event.costUsd;
    }
    if (event.tokens !== undefined) {
      sc.tokens += event.tokens;
      this.totalTokens += event.tokens;
    }

    this.notify();
  }

  private handleTurn(event: TurnEvent): void {
    this.turnCurrent = event.current;
    this.turnMax = event.max;
    this.notify();
  }

  private handleRootUsage(event: RootUsageEvent): void {
    this.totalCostUsd += event.costUsd;
    this.totalTokens += event.tokens;
    this.notify();
  }

  private handleAnswer(event: AnswerEvent): void {
    this.answer = event.text;
    this.notify();
  }

  private handleEdits(event: EditsEvent): void {
    this.edits = event.edits;
    this.notify();
  }

  private handleStatus(event: StatusEvent): void {
    this.rootStatus = event.status;
    this.notify();
  }

  private handleRootPrompt(event: RootPromptEvent): void {
    this.rootPrompt = event.text;
    // No notify — root prompt is set before listeners exist; no TUI re-render needed
  }

  // ── Read ──

  /** Snapshot the current accumulated state. O(1). */
  getState(): RlmDetails {
    return {
      status: this.rootStatus,
      rootPrompt: this.rootPrompt,
      turns: { current: this.turnCurrent, max: this.turnMax },
      subcalls: [...this.subcalls.values()],
      totals: { costUsd: this.totalCostUsd, tokens: this.totalTokens },
      answer: this.answer,
      edits: this.edits,
    };
  }

  // ── Lifecycle ──

  /** Detach all emitter listeners. Call after the run completes. */
  dispose(): void {
    for (const unsub of this.unsubs) unsub();
  }

  // ── Internal ──

  private notify(): void {
    if (!this.onChange) return;
    const state = this.getState();
    this.onChange({
      content: [{ type: "text", text: state.answer ?? "(running...)" }],
      details: state,
    });
  }
}
