/**
 * Phase 5 verification — deterministic render of the live agent tree (no tokens, no model).
 * Run: bun run pi-plugin/rlm/test/phase5.ts
 */

import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createFsBridge } from "../src/bridge/fs-tools.ts";
import { createLlmBridge } from "../src/bridge/llm-query.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { shouldCompact } from "../src/core/compaction.ts";
import { createEngine } from "../src/core/engine.ts";
import { AgentTree } from "../src/state/agent-tree.ts";
import { treeObserver, type SubcallObserver } from "../src/state/events.ts";
import { renderTree } from "../src/ui/tree-widget.ts";

// Minimal theme stub: identity colors so we can assert on plain text.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures++;
};

function testCompactionFallback(): void {
  check("compaction defaults on", DEFAULT_CONFIG.compaction);
  const huge = "x".repeat(600_000);
  const compact = shouldCompact([{ role: "user", content: huge }], { model: {} as Model<Api>, registry: {} as ModelRegistry, thresholdPct: 0.1 });
  check("compaction uses fallback context window", compact);
}

async function testFsBridgeObserver(): Promise<void> {
  const tree = new AgentTree();
  const obs = treeObserver(tree);
  const root = obs.start({ kind: "root", depth: 0, label: "root" });
  const fs = createFsBridge(process.cwd(), { observer: obs, parentId: root });
  await fs.readFile("pi-plugin/rlm/README.md", 1, 3);
  const text = renderTree(tree, theme, 120).join("\n");
  check("fs bridge emits read_file node", text.includes("read_file"));
  check("fs bridge emits args line", text.includes("pi-plugin/rlm/README.md:1-3"));
  check("fs bridge emits result line", text.includes("→") && text.includes("lines"));
}

async function testStartupFailureEndsNode(): Promise<void> {
  const tree = new AgentTree();
  const model = { id: "smart", provider: "test", cost: { input: 0, output: 0 }, contextWindow: 1000 } as Model<Api>;
  const registry = { find: () => undefined, getAvailable: () => [model] } as unknown as ModelRegistry;
  const engine = createEngine({
    smartModel: model,
    workerModel: model,
    registry,
    config: { ...DEFAULT_CONFIG, python: "definitely-missing-python-for-rlm-test" },
    observer: treeObserver(tree),
  });
  try {
    await engine({ rootPrompt: "x", context: "x", depth: 0 });
    check("startup failure throws", false);
  } catch {
    check("startup failure ends root node", tree.totals().running === 0, String(tree.totals().running));
    check("startup failure marks root error", tree.children(undefined)[0]?.status === "error");
  }
}

async function testBatchedFailure(): Promise<void> {
  let endedError = "";
  let endedResult = "";
  const observer: SubcallObserver = {
    start: () => "batch",
    end: (_id, opts) => { endedError = opts?.error ?? ""; endedResult = opts?.resultPreview ?? ""; },
    usage: () => {},
    detail: () => {},
    action: () => {},
    result: () => {},
  };
  const workerModel = { id: "worker", provider: "test", cost: { input: 0, output: 0 } } as Model<Api>;
  const registry = { find: () => undefined } as unknown as ModelRegistry;
  const bridge = createLlmBridge({ workerModel, registry, observer });
  const out = await bridge.llmQueryBatched(["a", "b"], "missing/model", 0);
  check("batched call returns per-item errors", out.length === 2 && out.every((v) => v.startsWith("Error:")));
  check("batched failure surfaces on tree node", endedError === "all 2 sub-calls failed", endedError);
  check("batched response preview surfaces on tree node", endedResult.includes("(+1 more)"), endedResult);
}

async function main() {
  const tree = new AgentTree();
  const obs = treeObserver(tree);

  const root = obs.start({ kind: "root", depth: 0, model: "smart", label: "root", detail: "find the code" });
  obs.usage(root, 0.0123, 1200);
  const tool = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/jwt.ts:1-120" });
  obs.end(tool, { resultPreview: "118 lines · 3.2k chars" });
  const repeatedTool = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/jwt.ts:30-90" });
  obs.end(repeatedTool, { resultPreview: "60 lines · 1.7k chars" });
  // read_file with DIFFERENT args — verifies label-only grouping works in practice
  const readFile3 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/refresh.ts:5-80" });
  obs.end(readFile3, { resultPreview: "75 lines · 2.1k chars" });
  const readFile4 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/login.ts" });
  obs.end(readFile4, { resultPreview: "200 lines · 5.4k chars" });
  const readFile5 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/claims.ts:10-50" });
  obs.end(readFile5, { resultPreview: "40 lines · 1.1k chars" });
  const readFile6 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "read_file", args: "src/auth/session.ts" });
  obs.end(readFile6, { resultPreview: "95 lines · 2.8k chars" });
  // find calls with different globs — verifies label-only grouping
  const find1 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "find", args: "**/*.rs" });
  obs.end(find1, { resultPreview: "142 files" });
  const find2 = obs.start({ kind: "tool", depth: 0, parentId: root, label: "find", args: "src/**/*.ts" });
  obs.end(find2, { resultPreview: "38 files" });
  const grepOne = obs.start({ kind: "tool", depth: 0, parentId: root, label: "grep", args: "auth src/**/*.ts (max 20)" });
  obs.end(grepOne, { resultPreview: "3 matches in 2 files" });
  const grepTwo = obs.start({ kind: "tool", depth: 0, parentId: root, label: "grep", args: "token src/**/*.ts (max 20)" });
  obs.end(grepTwo, { resultPreview: "5 matches in 3 files" });
  const llm = obs.start({ kind: "llm", depth: 0, parentId: root, model: "worker", label: "llm_query", args: "prompt: summarize chunk" });
  obs.end(llm, { costUsd: 0.0003, tokens: 800, resultPreview: "Worker response summary with exported symbol details" });
  const secondLlm = obs.start({ kind: "llm", depth: 0, parentId: root, model: "worker", label: "llm_query", args: "prompt: summarize other chunk" });
  obs.end(secondLlm, { costUsd: 0.0002, tokens: 400, resultPreview: "Second worker response summary" });
  const rlm = obs.start({ kind: "rlm", depth: 1, parentId: root, model: "smart", label: "rlm_query", detail: "sub-problem" });
  obs.action(root, "▶ print('block 1 — initial analysis')\n▶ print('block 2 — follow-up reasoning')");
  obs.result(root, "root stdout sample");
  const nested = obs.start({ kind: "llm", depth: 1, parentId: rlm, model: "worker", label: "llm_query" });
  obs.end(nested);

  const lines = renderTree(tree, theme, 100);
  const text = lines.join("\n");
  console.log(text);

  check("header shows rolled-up totals", /RLM · \$/.test(lines[0] ?? ""));
  check("root node rendered", text.includes("root"));
  check("llm_query child rendered", text.includes("llm_query"));
  check("llm_query node carries response preview", tree.get(llm)?.resultPreview === "Worker response summary with exported symbol details");
  check("llm_query response preview rendered", text.includes("Worker response summary"));
  check("root node carries multi-block action preview", tree.get(root)?.args === "▶ print('block 1 — initial analysis')\n▶ print('block 2 — follow-up reasoning')");
  check("root node carries stdout preview", tree.get(root)?.resultPreview === "root stdout sample");
  check("root action renders multi-block thinking", text.includes("block 1") && text.includes("block 2"));
  check("root stdout preview rendered", text.includes("→ root stdout sample"));
  check("read_file tool rendered", text.includes("read_file"));
  check("repeated read_file calls are counted across different args", text.includes("read_file(6)"));
  check("find calls are grouped by label", text.includes("find(2)"));
  check("repeated grep calls are counted", text.includes("grep(2)"));
  check("llm_query calls are not collapsed", !text.includes("llm_query(2)"));
  check("tool args rendered (first grouped node)", text.includes("src/auth/jwt.ts:1-120"));
  check("tool result preview rendered (first grouped node)", text.includes("→ 118 lines"));
  check("grouped read_file shows sub-item with individual result", text.includes("src/auth/jwt.ts:30-90 → 60 lines"));
  check("grouped find shows sub-item with individual result", text.includes("src/**/*.ts → 38 files"));
  check("grouped read_file overflow summary", text.includes("(+2 more)"));
  check("rlm_query child rendered", text.includes("rlm_query"));
  check("tree uses branch glyphs", text.includes("├─") || text.includes("└─"));
  check("nested sub-call indented under rlm_query", /[│ ]\s*[├└]─ .*llm_query/.test(text));
  check("running spinner for active rlm node", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text));
  check("totals reflect 2 running (root + rlm)", tree.totals().running === 2, String(tree.totals().running));

  testCompactionFallback();
  await testFsBridgeObserver();
  await testStartupFailureEndsNode();
  await testBatchedFailure();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
