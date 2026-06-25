import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractiveDeps } from "../core/types.ts";
import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
interface Task {
  readonly id: number;
  readonly subject: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly activeForm?: string;
  readonly blockedBy?: readonly number[];
  readonly owner?: string;
}

interface ToolInvoker {
  readonly callTool?: (name: string, params: unknown) => Promise<unknown>;
}

function normalizeAnswers(result: unknown): AskAnswer[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const answers = (result as { readonly answers?: unknown }).answers;
  return Array.isArray(answers) ? answers as AskAnswer[] : undefined;
}

async function askViaUi(ctx: ExtensionContext, questions: readonly AskQuestion[]): Promise<AskAnswer[]> {
  if (!ctx.hasUI) throw new Error("ask_user_question requires UI");
  const answers = new Array<AskAnswer>(questions.length);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q) {
      answers[i] = { question: "", selected: [], custom: "Error: malformed question" };
      continue;
    }
    if (q.multiSelect) {
      const selected: string[] = [];
      while (true) {
        const pick = await ctx.ui.select(`${q.header}: ${q.question}`, [...q.options.map((o) => o.label), "Done"]);
        if (!pick || pick === "Done") break;
        if (!selected.includes(pick)) selected.push(pick);
      }
      answers[i] = { question: q.question, selected };
      continue;
    }
    const pick = await ctx.ui.select(`${q.header}: ${q.question}`, [...q.options.map((o) => o.label), "Type something.", "Chat about this"]);
    if (!pick) answers[i] = { question: q.question, selected: [], custom: "Error: user cancelled" };
    else if (pick === "Type something.") answers[i] = { question: q.question, selected: [], custom: await ctx.ui.input(q.question) ?? "" };
    else if (pick === "Chat about this") answers[i] = { question: q.question, selected: [], custom: "Chat about this" };
    else answers[i] = { question: q.question, selected: [pick] };
  }
  return answers;
}

function taskLines(task: Task): readonly string[] {
  const lines: string[] = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((n) => `#${n}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines;
}

function createTodoFallback(): (action: string, params: Record<string, unknown>) => Promise<string> {
  let nextId = 1;
  let tasks: readonly Task[] = Object.freeze([]);
  const fmt = (task: Task): string => taskLines(task)[0] ?? `#${task.id}`;
  const withPatch = (task: Task, params: Record<string, unknown>): Task => Object.freeze({
    ...task,
    ...(typeof params.subject === "string" ? { subject: params.subject } : {}),
    ...(typeof params.description === "string" ? { description: params.description } : {}),
    ...(params.status === "pending" || params.status === "in_progress" || params.status === "completed" || params.status === "deleted" ? { status: params.status } : {}),
    ...(typeof params.activeForm === "string" ? { activeForm: params.activeForm } : {}),
    ...(Array.isArray(params.blockedBy) ? { blockedBy: Object.freeze(params.blockedBy.filter((n): n is number => typeof n === "number")) } : {}),
    ...(typeof params.owner === "string" ? { owner: params.owner } : {}),
  });

  const apply = (action: string, params: Record<string, unknown>): string => {
    if (action === "clear") {
      const count = tasks.length;
      tasks = Object.freeze([]);
      nextId = 1;
      return `Cleared ${count} task(s).`;
    }
    if (action === "create") {
      const subject = typeof params.subject === "string" && params.subject.trim() ? params.subject.trim() : undefined;
      if (!subject) return "Error: create requires subject";
      const task = withPatch(Object.freeze({ id: nextId, subject, status: "pending" }), params);
      nextId += 1;
      tasks = Object.freeze([...tasks, task]);
      return `Created ${fmt(task)}`;
    }
    if (action === "list") {
      const filter = typeof params.filterStatus === "string" ? params.filterStatus : typeof params.status === "string" ? params.status : undefined;
      const includeDeleted = params.includeDeleted === true;
      const rows = tasks.filter((task) => (includeDeleted || task.status !== "deleted") && (!filter || task.status === filter)).map(fmt);
      return rows.length ? rows.join("\n") : "No tasks.";
    }
    const id = typeof params.id === "number" ? params.id : undefined;
    const task = id !== undefined ? tasks.find((item) => item.id === id) : undefined;
    if (!task) return `Error: task #${id ?? "?"} not found`;
    if (action === "get") return taskLines(task).join("\n");
    if (action === "delete") {
      const deleted = Object.freeze({ ...task, status: "deleted" as const });
      tasks = Object.freeze(tasks.map((item) => item.id === task.id ? deleted : item));
      return `Deleted ${fmt(deleted)}`;
    }
    if (action === "update") {
      const updated = withPatch(task, params);
      tasks = Object.freeze(tasks.map((item) => item.id === task.id ? updated : item));
      return `Updated ${fmt(updated)}`;
    }
    return `Error: unknown todo action '${action}'`;
  };
  return async (action, params) => apply(action, params);
}

export function createPiInteractiveDeps(ctx: ExtensionContext): InteractiveDeps {
  const fallbackTodo = createTodoFallback();
  return Object.freeze({
    onAskUserQuestion: async (questions: readonly AskQuestion[]): Promise<AskAnswer[]> => {
      const callTool = (ctx as unknown as ToolInvoker).callTool;
      if (typeof callTool === "function") {
        try {
          const result = await callTool.call(ctx, "ask_user_question", { questions });
          const answers = normalizeAnswers(result);
          if (answers) return answers;
        } catch {
          // Fall through to native UI fallback when the extension tool is not registered or fails.
        }
      }
      return askViaUi(ctx, questions);
    },
    onTodo: async (action: string, params: Record<string, unknown>): Promise<string> => {
      const callTool = (ctx as unknown as ToolInvoker).callTool;
      if (typeof callTool === "function") {
        try {
          const result = await callTool.call(ctx, "todo", { action, ...params });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch {
          // Fall through to in-process task store when the extension tool is not registered or fails.
        }
      }
      return fallbackTodo(action, params);
    },
  });
}
