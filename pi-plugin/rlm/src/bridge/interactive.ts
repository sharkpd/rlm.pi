import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";

export interface InteractiveBridgeOpts {
  onAskUserQuestion?: (questions: readonly AskQuestion[]) => Promise<AskAnswer[]>;
  onTodo?: (action: string, params: Record<string, unknown>) => Promise<string>;
  onTodoRow?: (action: string, params: Record<string, unknown>, result: string) => void;
  emitter?: RlmEmitter;
  depth: number;
  parentId?: string;
}

export function buildInteractiveHandlers(opts: InteractiveBridgeOpts): {
  askUserQuestion: SubLlmHandlers["askUserQuestion"];
  todo: SubLlmHandlers["todo"];
} {
  return {
    async askUserQuestion(questions, depth) {
      if (depth > 0) return questions.map((q) => ({
        question: q.question,
        selected: [],
        custom: "Error: ask_user_question not available inside rlm_query sub-calls",
      }));

      const id = opts.emitter?.emitSubcallCreated({
        kind: "tool", parentId: opts.parentId,
        label: "ask_user_question",
        args: `${questions.length} question(s)`,
        depth,
      });
      try {
        const cb = opts.onAskUserQuestion;
        if (!cb) throw new Error("ask_user_question not configured (no onAskUserQuestion callback)");
        const answers = await cb(questions);
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "done" });
        return answers;
      } catch (err) {
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
        throw err;
      }
    },

    async todo(action, params, depth) {
      const id = opts.emitter?.emitSubcallCreated({
        kind: "tool", parentId: opts.parentId,
        label: `todo:${action}`,
        args: params.subject ? String(params.subject) : String(params.id ?? ""),
        depth,
      });
      try {
        const cb = opts.onTodo;
        if (!cb) throw new Error("todo not configured (no onTodo callback)");
        const result = await cb(action, params);
        opts.onTodoRow?.(action, params, result);
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "done", resultPreview: result.slice(0, 80) });
        return result;
      } catch (err) {
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
        throw err;
      }
    },
  };
}
