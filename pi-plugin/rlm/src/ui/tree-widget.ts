/** Live verbose agent/subagent tree shown above the editor during an RLM run. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AgentTree, type TreeNode } from "../state/agent-tree.ts";
import { formatCost, formatDuration, formatTokens, kindLabel, statusGlyph } from "./theme.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
type TreeColor = "accent" | "success" | "error" | "muted";

interface RenderNode {
  readonly node: TreeNode;
  readonly repeatCount: number;
  readonly details?: ReadonlyArray<{ args?: string; resultPreview?: string }>;
}

const COLOR: Readonly<Record<TreeNode["kind"], TreeColor>> = Object.freeze({
  root: "accent",
  rlm: "accent",
  batch: "muted",
  llm: "muted",
  tool: "muted",
});

function headline(node: TreeNode, theme: Theme, repeatCount = 1): string {
  const statusColor: TreeColor = node.status === "error" ? "error" : node.status === "done" ? "success" : "accent";
  const glyph = theme.fg(statusColor, statusGlyph(node.status));
  const baseLabel = node.label || kindLabel(node.kind);
  const labelText = repeatCount > 1 ? `${baseLabel}(${repeatCount})` : baseLabel;
  const label = theme.fg(COLOR[node.kind], labelText);
  const model = node.model ? theme.fg("dim", ` ${node.model}`) : "";
  const stats: string[] = [];
  if (node.costUsd > 0) stats.push(formatCost(node.costUsd));
  if (node.tokens > 0) stats.push(formatTokens(node.tokens));
  stats.push(formatDuration((node.endedAt ?? Date.now()) - node.startedAt));
  return `${glyph} ${label}${model}${theme.fg("muted", `  ${stats.join(" · ")}`)}`;
}

function wrapPreview(text: string, width: number, indent: string, marker: string, maxLines = 2): string[] {
  const firstIndent = `${indent}${marker}`;
  const nextIndent = `${indent}${" ".repeat(marker.length)}`;
  const body = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), Math.max(8, width - firstIndent.length)).slice(0, maxLines);
  return body.map((line, index) => `${index === 0 ? firstIndent : nextIndent}${line}`);
}

function coloredRows(theme: Theme, color: "dim" | "muted", rows: readonly string[]): string[] {
  return rows.map((line) => theme.fg(color, line));
}

function nodeLines(
  node: TreeNode,
  theme: Theme,
  width: number,
  prefix: string,
  childIndent: string,
  repeatCount = 1,
  details?: ReadonlyArray<{ args?: string; resultPreview?: string }>,
): string[] {
  const lines: string[] = [truncateToWidth(`${prefix}${headline(node, theme, repeatCount)}`, width)];
  const nodeDetail = node.kind === "root" && node.detail?.startsWith("turn ") ? undefined : node.detail;
  const detail = node.args ?? nodeDetail;
  if (detail) lines.push(...coloredRows(theme, "dim", wrapPreview(detail, width, `${childIndent}  `, "")));
  if (node.status === "error" && node.detail) lines.push(truncateToWidth(`${childIndent}  ${theme.fg("error", `✗ ${node.detail}`)}`, width));
  else if (node.resultPreview) lines.push(...coloredRows(theme, "muted", wrapPreview(node.resultPreview, width, `${childIndent}  `, "→ ")));
  // Sub-item rendering for grouped nodes
  if (repeatCount > 1 && details && details.length > 0) {
    const maxSubItems = 3;
    const shown = details.slice(0, maxSubItems);
    for (const item of shown) {
      const itemLine = [item.args, item.resultPreview].filter(Boolean).join(" → ");
      lines.push(truncateToWidth(`${childIndent}  ${theme.fg("dim", itemLine)}`, width));
    }
    const hidden = details.length - shown.length;
    if (hidden > 0) lines.push(truncateToWidth(`${childIndent}  ${theme.fg("dim", `(+${hidden} more)`)}`, width));
  }
  return lines;
}

function toolGroupKey(node: TreeNode): string | undefined {
  if (node.kind !== "tool") return undefined;
  if (node.label === "grep" || node.label === "read_file" || node.label === "find") return `tool:${node.label}`;
  return `tool:${node.label}:${node.args ?? ""}`;
}

function renderChildren(tree: AgentTree, parentId: string | undefined): RenderNode[] {
  const rendered: RenderNode[] = [];
  const groupedIndexes = new Map<string, number>();
  for (const node of tree.children(parentId)) {
    const key = toolGroupKey(node);
    if (key === undefined) {
      rendered.push({ node, repeatCount: 1 });
      continue;
    }
    const existingIndex = groupedIndexes.get(key);
    if (existingIndex === undefined) {
      groupedIndexes.set(key, rendered.length);
      rendered.push({ node, repeatCount: 1 });
      continue;
    }
    const existing = rendered[existingIndex];
    if (existing === undefined) {
      groupedIndexes.set(key, rendered.length);
      rendered.push({ node, repeatCount: 1 });
      continue;
    }
    const prevDetail = { args: node.args, resultPreview: node.resultPreview };
    const details = existing.details ? [...existing.details, prevDetail] : [prevDetail];
    rendered[existingIndex] = { node: existing.node, repeatCount: existing.repeatCount + 1, details };
  }
  return rendered;
}

function renderSubtree(tree: AgentTree, parentId: string | undefined, theme: Theme, width: number, indent: string, lines: string[]): void {
  const kids = renderChildren(tree, parentId);
  kids.forEach((rendered, i) => {
    const last = i === kids.length - 1;
    const branch = parentId === undefined ? "" : last ? "└─ " : "├─ ";
    const childIndent = parentId === undefined ? "" : indent + (last ? "   " : "│  ");
    lines.push(...nodeLines(rendered.node, theme, width, indent + branch, childIndent, rendered.repeatCount, rendered.details));
    renderSubtree(tree, rendered.node.id, theme, width, childIndent, lines);
  });
}

/** Pure render of the whole tree to lines (exported for tests). */
export function renderTree(tree: AgentTree, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  renderSubtree(tree, undefined, theme, width, "", lines);
  if (lines.length === 0) return [];
  const t = tree.totals();
  const turn = tree.rootDetail();
  const headerText = `RLM · ${formatCost(t.costUsd)} · ${formatTokens(t.tokens)} tok · ${t.running} active${turn ? ` · ${turn}` : ""}`;
  const header = theme.fg("accent", theme.bold(headerText));
  return [truncateToWidth(header, width), ...lines];
}

class TreeWidget implements Component {
  constructor(
    private readonly tree: AgentTree,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    return renderTree(this.tree, this.theme, width);
  }

  invalidate(): void {}
}

/** Build a setWidget factory that renders `tree` live and ticks while work is running. */
export function createTreeWidget(tree: AgentTree): WidgetFactory {
  return (tui, theme) => {
    const widget = new TreeWidget(tree, theme);
    const unsub = tree.onChange(() => tui.requestRender());
    const timer = setInterval(() => {
      if (tree.totals().running > 0) tui.requestRender();
    }, 120);
    return Object.assign(widget, {
      dispose() {
        unsub();
        clearInterval(timer);
      },
    });
  };
}
