import { execFile, spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_OUT_CHARS = 20_000;
const MAX_READ_SLICE_CHARS = MAX_OUT_CHARS;
const MAX_FIND_FILES = 2_000;
const MAX_MANIFEST_FILES = 5_000;

const WALK_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", ".DS_Store",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".svelte-kit", ".astro", ".vite", ".expo",
  ".gradle", ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
  ".venv", "venv", "env", "__pycache__", ".serverless", ".terraform", ".yarn", ".pnpm-store",
  "node_modules", "bower_components", "vendor", "Pods", "DerivedData", "Carthage",
  "target", "dist", "build", "out", "coverage", ".coverage", "htmlcov", "tmp", "temp", "logs",
  "bin", "obj", "pkg", "elm-stuff", "deps", "_build", "zig-cache", "zig-out",
  ".eslintcache", ".stylelintcache", ".tsbuildinfo", "npm-debug.log", "yarn-error.log", "pnpm-debug.log",
]);

const WALK_SKIP_SUFFIXES = [
  ".pyc", ".pyo", ".class", ".o", ".obj", ".so", ".dylib", ".dll", ".exe",
  ".beam", ".hi", ".dyn_hi", ".dyn_o", ".rlib", ".rmeta", ".wasm",
  ".min.js", ".min.css", ".map", ".log", ".tmp", ".temp", ".cache",
];

function shouldSkipWalkEntry(name: string): boolean {
  return WALK_SKIP_NAMES.has(name) || WALK_SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export interface FsBridge {
  readFile(path: string, start: number | null, end: number | null): Promise<string>;
  grep(pattern: string, glob: string | null, maxMatches: number | null): Promise<string>;
  find(glob: string | null): Promise<string>;
}

export interface FsBridgeOptions {
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  initialFiles?: string[];
}

interface CommandOptions extends FsBridgeOptions {
  commandTimeoutMs: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

function safeResolve(root: string, path: string): string {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path '${path}' is outside the workspace root`);
  return abs;
}

async function safeRealPath(root: string, path: string, rootReal?: string): Promise<string> {
  const abs = safeResolve(root, path);
  const realRoot = rootReal ?? await realpath(root);
  const real = await realpath(abs);
  const rel = relative(realRoot, real);
  if (rel === "") return real;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path '${path}' is outside the workspace root`);
  return real;
}

function truncateOutput(text: string, limit = MAX_OUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated to ${limit} characters]`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("filesystem tool aborted");
}

function commandOptions(opts?: FsBridgeOptions): CommandOptions {
  return { signal: opts?.signal, commandTimeoutMs: opts?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missingFileMessage(path: string): string {
  return `'${path}' not found`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const prev = glob[i - 1];
        const next = glob[i + 2];
        if (prev === "/" && next === "/") {
          out = out.endsWith("/") ? out.slice(0, -1) : out;
          out += "(?:/.*)?/";
          i += 2;
        } else {
          i++;
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`${out}$`);
}

interface GrepCommandResult {
  lines: string[];
  truncated: boolean;
}

async function grepCommand(command: string, args: string[], cwd: string, cap: number, opts: CommandOptions): Promise<GrepCommandResult> {
  throwIfAborted(opts.signal);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let pending = "";
    let stderr = "";
    let capped = false;
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };
    const resolveOnce = (value: GrepCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };
    const abort = () => {
      child.kill("SIGTERM");
      rejectOnce(new Error("filesystem tool aborted"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.commandTimeoutMs);

    opts.signal?.addEventListener("abort", abort, { once: true });

    const stopIfCapped = () => {
      if (lines.length >= cap && !capped) {
        capped = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0 && lines.length < cap) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) lines.push(line);
        nl = pending.indexOf("\n");
      }
      stopIfCapped();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => rejectOnce(err));
    child.on("close", (code) => {
      if (settled) return;
      if (pending && lines.length < cap) lines.push(pending);
      if (timedOut) rejectOnce(new Error(`${command} exceeded ${opts.commandTimeoutMs}ms timeout`));
      else if (code === 0 || code === 1 || capped) resolveOnce({ lines, truncated: capped });
      else rejectOnce(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}


async function gitLsFiles(root: string, opts: CommandOptions): Promise<string[]> {
  throwIfAborted(opts.signal);
  const { stdout } = await execFileP("git", ["ls-files"], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    signal: opts.signal,
    timeout: opts.commandTimeoutMs,
  });
  return stdout.split("\n").filter(Boolean).slice(0, MAX_MANIFEST_FILES);
}

async function walkFiles(root: string, dir = ".", out: string[] = [], limit = MAX_MANIFEST_FILES, opts = commandOptions()): Promise<string[]> {
  throwIfAborted(opts.signal);
  if (out.length >= limit) return out;
  const abs = safeResolve(root, dir);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit || shouldSkipWalkEntry(entry.name)) continue;
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkFiles(root, path, out, limit, opts);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function listProjectFiles(root: string, limit = MAX_MANIFEST_FILES, fsOpts?: FsBridgeOptions): Promise<string[]> {
  const absRoot = resolve(root);
  const opts = commandOptions(fsOpts);
  const load = async () => {
    try {
      return await gitLsFiles(absRoot, opts);
    } catch {
      return walkFiles(absRoot, ".", [], MAX_MANIFEST_FILES, opts);
    }
  };
  const files = await load();
  return files.slice(0, limit);
}

export async function buildProjectManifest(root: string, opts?: FsBridgeOptions): Promise<string> {
  const files = await listProjectFiles(root, MAX_MANIFEST_FILES, opts);
  if (files.length === 0) return "";
  return [
    `# Project map (${files.length} files, root: ${root})`,
    "# Use find(glob), grep(pattern[, glob]), read_file(path[, start, end]) to explore.",
    ...files,
  ].join("\n");
}

export function createFsBridge(root: string, fsOpts: FsBridgeOptions = {}): FsBridge {
  const opts = commandOptions(fsOpts);
  let rootRealPromise: Promise<string> | undefined;
  let fileListPromise: Promise<string[]> | undefined;

  const rootReal = () => {
    rootRealPromise ??= realpath(root);
    return rootRealPromise;
  };
  const projectFiles = () => {
    fileListPromise ??= fsOpts.initialFiles ? Promise.resolve(fsOpts.initialFiles) : listProjectFiles(root, MAX_MANIFEST_FILES, opts);
    return fileListPromise;
  };
  const formatGrepOutput = ({ lines, truncated }: GrepCommandResult, cap: number) => {
    if (lines.length === 0) return "(no matches)";
    const suffix = truncated ? `\n…[truncated to ${cap} matches]` : "";
    return truncateOutput(`${lines.slice(0, cap).join("\n")}${suffix}`);
  };

  return {
    async readFile(path, start, end) {
      try {
        const abs = await safeRealPath(root, path, await rootReal());
        const st = await stat(abs);
        if (!st.isFile()) return `Error: '${path}' is not a file`;
        if (st.size > MAX_READ_BYTES) return `Error: file '${path}' exceeds the ${MAX_READ_BYTES} byte limit`;
        const text = await readFile(abs, "utf8");
        if (start == null && end == null) return text;
        const lines = text.split("\n");
        const a = Math.max(1, start ?? 1);
        const b = Math.min(lines.length, end ?? lines.length);
        if (b < a) return "";
        return truncateOutput(lines.slice(a - 1, b).join("\n"), MAX_READ_SLICE_CHARS);
      } catch (e) {
        if (isEnoent(e)) return `Error: ${missingFileMessage(path)}`;
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },

    async grep(pattern, glob, maxMatches) {
      const cap = Math.min(Math.max(maxMatches ?? 200, 1), 1000);
      try {
        const args = ["--line-number", "--no-heading", "--color=never"];
        if (glob) args.push("--glob", glob);
        args.push("-e", pattern, ".");
        const result = await grepCommand("rg", args, root, cap, opts);
        return formatGrepOutput(result, cap);
      } catch (e) {
        if (!isEnoent(e)) return `Error: grep failed (${errorMessage(e)})`;
        try {
          const args = ["grep", "-n", "-I", "-e", pattern];
          if (glob) args.push("--", `:(glob)${glob}`);
          const result = await grepCommand("git", args, root, cap, opts);
          return formatGrepOutput(result, cap);
        } catch (e2) {
          return `Error: grep unavailable (${errorMessage(e2)})`;
        }
      }
    },

    async find(glob) {
      try {
        let files = await projectFiles();
        if (glob) {
          const rx = globToRegExp(glob);
          files = files.filter((f) => rx.test(f));
        }
        const truncated = files.length > MAX_FIND_FILES;
        const shown = files.slice(0, MAX_FIND_FILES);
        const suffix = truncated ? `\n…[truncated to ${MAX_FIND_FILES} files]` : "";
        return shown.length ? `${shown.join("\n")}${suffix}` : "(no files)";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
