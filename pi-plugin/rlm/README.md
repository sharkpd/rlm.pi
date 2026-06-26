# pi-rlm — Recursive Language Model for Pi

A [Pi](https://github.com/earendil-works) extension that implements the **Recursive Language Model
(RLM)** method: a root model orchestrates over a *very large* context by driving a persistent Python
REPL, delegating long-context work to sub-LLMs, and recursing into child RLMs for hard sub-problems —
all **natively inside pi, with no extra servers**.

## How it works

```
pi process (TypeScript)
 ├─ /rlm  ──► engine drives the SMART model turn-by-turn (writes ```repl``` Python)
 │             │  each turn: parse repl blocks ──► run in sandbox ──► feed stdout back
 │             ▼
 ├─ bridge ── llm_query / llm_query_batched ──► WORKER model (serverless, in-process)
 │            rlm_query ──► recursive child RLM (own sandbox), depth-capped
 ├─ AgentTree ──► live agent/subagent tree above the editor (roles, depth, cost, tokens)
 └─ PythonSandbox ── `python3 worker.py` ──[JSONL over stdio, bidirectional]── persistent REPL
```

- **No servers, no sockets, no Docker.** The only external process is one local `python3` sandbox.
  When sandbox code calls `llm_query`, the worker writes a request on stdout and blocks on stdin;
  pi services it in-process and writes the reply back. **Provider API keys never enter the sandbox.**
- The sandbox exposes `context`, `llm_query`, `llm_query_batched`, `rlm_query`, `rlm_query_batched`,
  `SHOW_VARS()`, and an `answer` dict. The model submits by setting `answer["ready"] = True`.

## Install

`pi-rlm` is a Pi package. Pi provides the `@earendil-works/pi-*` and `typebox` peer dependencies;
do not install a separate copy of them into this package. Requires `python3` on `PATH` (standard
library only).

Recommended local install while developing:

```bash
pi install /Users/hicaru/projects/zebra/rlm.pi/pi-plugin/rlm
```

Published npm package install:

```bash
npm publish  # for example as @hicaru/pi-rlm
pi install npm:@hicaru/pi-rlm
```

Git installs require the package manifest to live at the installed repository root. For monorepo
subdirectories like this one, prefer the local path or npm flow above.

If you previously copied the extension folder directly, remove it so it does not shadow the package:

```bash
rm -rf ~/.pi/agent/extensions/rlm
```

Then run `/reload` or restart Pi. Verify with `pi list` that the package appears in
`settings.packages`, and check that `/rlm`, `/rlm-config`, and `/rlm-stop` appear under
[Extensions].

## Usage

```
/rlm                                # toggle persistent RLM mode (Ctrl+Shift+R)
/rlm-stop                           # abort an in-progress run
/rlm-config                         # pick smart + worker models and tune run settings
```

While a run is active, a live tree shows the root orchestrator and every sub-LLM / recursive child
with status, model, cost, tokens, and duration. The final answer is posted to the chat as markdown.

## Settings (`/rlm-config`)

| Setting | Default | Meaning |
|---|---|---|
| Smart model | pi's active model | the root orchestrator |
| Worker model | cheapest available | answers `llm_query` |
| Max recursion depth | 4 | `rlm_query` past this falls back to `llm_query` |
| Max iterations | 30 | turns before the engine finalizes |
| Budget ceiling | none | stops the whole tree when USD spend exceeds this |
| Max consecutive errors | 5 | stops after N consecutive error turns |
| REPL block timeout | 120s | per-`repl`-block wall-clock (SIGALRM in the worker) |
| Max concurrent sub-calls | 4 | pool size for `*_batched` |
| Orchestrator addendum | on | "delegate, don't solve" guidance |
| Trajectory compaction | off | summarize history when it nears the context window |

> **Concurrency note:** each `rlm_query` child spawns its own `python3` worker (~50–150 ms
> cold start). Worst-case concurrent interpreters ≈ `maxConcurrentSubcalls`^(depth−1); at
> defaults (depth 4, conc 4) that's 4, but raising both via `/rlm-config` can fork many. Budget
> and error caps (above) bound total spend regardless of fan-out.

## Security

- **Key isolation**: provider keys live only in TypeScript (`AuthStorage`); the sandbox
  receives prompts and returns text — never keys.
- **NOT a security sandbox**: the Python worker exposes `__import__` and `open`. Model-authored
  code can import networking modules (`socket`, `urllib`, `subprocess`), read/write local
  files, and write protocol-shaped JSON to stdout. This tier trusts the root model's code; the
  stdio protocol is for isolation of provider keys and process lifecycle, not adversarial code
  containment. A stronger sandbox (Docker, seccomp) can be added later behind a setting without
  protocol changes.
- **Environment sanitization**: sensitive env vars (API keys, tokens) are stripped before the
  worker spawns. The worker cannot read provider credentials from `os.environ`.
- **Restricted builtins**: no `eval`/`exec`/`compile`/`input`/`globals`/`locals`; per-block
  SIGALRM timeout + parent watchdog (SIGKILL on hang); budget / token / timeout /
  consecutive-error caps.
- **Trust**: project-local install requires Pi project trust.

## Layout

```
src/
  sandbox/   worker.py + JSONL stdio driver (PythonSandbox)
  bridge/    model.ts (one-shot completion) · llm-query.ts · rlm-query.ts (recursion)
  core/      engine.ts (the loop) · iteration · limits · answer · compaction · types
  prompts/   system + per-turn prompts (ported from the Python reference)
  text/      parsing (repl blocks) · tokens
  state/     agent-tree · events (SubcallObserver)
  ui/        tree-widget · status · model-picker · config-panel · theme
  commands/  rlm · rlm-config
  mode/      rlm-mode (controller)
test/        phase1 (sandbox) · phase2 (bridge) · phase3 (e2e) · phase4 (engine) · phase5 (tree)
```

## Tests

```
bun run test/phase1.ts                  # sandbox: exec, persistence, key isolation, timeout kill
bun run test/phase4.ts                  # recursion depth-cap logic (no tokens)
bun run test/phase5.ts                  # live agent tree rendering (no tokens)
RLM_TEST_LIVE=1 bun run test/phase2.ts  # real llm_query through the sandbox
RLM_TEST_LIVE=1 bun run test/phase3.ts  # real end-to-end /rlm over a file context
RLM_TEST_LIVE=1 bun run test/phase4.ts  # engine solves a 20-doc needle-in-haystack
```

Modeled on the Python reference `rlm` and the method in `books`; reimplemented natively for pi.
