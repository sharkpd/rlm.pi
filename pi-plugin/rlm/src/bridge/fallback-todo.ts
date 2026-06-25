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

const TODO_STATUSES = Object.freeze(new Set<unknown>(["pending", "in_progress", "completed", "deleted"]));

function isTaskStatus(value: unknown): value is TaskStatus {
  return TODO_STATUSES.has(value);
}

function numericArray(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) ? Object.freeze(value.filter((n): n is number => typeof n === "number")) : undefined;
}

function patchedBlockedBy(task: Task, params: Record<string, unknown>): readonly number[] | undefined {
  const replacement = numericArray(params.blockedBy);
  if (replacement) return replacement;

  let next = task.blockedBy ?? Object.freeze([] as readonly number[]);
  const additions = numericArray(params.addBlockedBy);
  if (additions) next = Object.freeze([...next, ...additions]);

  const removals = numericArray(params.removeBlockedBy);
  if (removals) {
    const removeSet = new Set(removals);
    next = Object.freeze(next.filter((n) => !removeSet.has(n)));
  }
  return next.length ? next : undefined;
}

function taskLines(task: Task): readonly string[] {
  const lines: string[] = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((n) => `#${n}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines;
}

function withPatch(task: Task, params: Record<string, unknown>): Task {
  const blockedBy = patchedBlockedBy(task, params);
  return Object.freeze({
    ...task,
    ...(typeof params.subject === "string" ? { subject: params.subject } : {}),
    ...(typeof params.description === "string" ? { description: params.description } : {}),
    ...(isTaskStatus(params.status) ? { status: params.status } : {}),
    ...(typeof params.activeForm === "string" ? { activeForm: params.activeForm } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    ...(typeof params.owner === "string" ? { owner: params.owner } : {}),
  });
}

export function createTodoFallback(): (action: string, params: Record<string, unknown>) => Promise<string> {
  let nextId = 1;
  let tasks: readonly Task[] = Object.freeze([]);
  const fmt = (task: Task): string => taskLines(task)[0] ?? `#${task.id}`;

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
