import type { ExtensionContext } from "@gsd/pi-coding-agent";
import type { InteractiveDeps } from "../core/types.ts";
import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";
import { formatError } from "../util/errors.ts";
import { createTodoFallback } from "./fallback-todo.ts";

async function askViaUi(ctx: ExtensionContext, questions: readonly AskQuestion[]): Promise<AskAnswer[]> {
  if (!ctx.hasUI) throw new Error("ask_user_question requires UI");
  const answers = new Array<AskAnswer>(questions.length);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q) {
      answers[i] = { question: "", selected: [], custom: formatError("malformed question") };
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
    const pick = await ctx.ui.select(`${q.header}: ${q.question}`, [...q.options.map((o) => o.label), "Type something."]);
    if (!pick) answers[i] = { question: q.question, selected: [], custom: formatError("user cancelled") };
    else if (pick === "Type something.") answers[i] = { question: q.question, selected: [], custom: await ctx.ui.input(q.question) ?? "" };
    else answers[i] = { question: q.question, selected: [pick] };
  }
  return answers;
}

export function createPiInteractiveDeps(ctx: ExtensionContext): InteractiveDeps {
  const fallbackTodo = createTodoFallback();
  return Object.freeze({
    onAskUserQuestion: (questions: readonly AskQuestion[]): Promise<AskAnswer[]> => askViaUi(ctx, questions),
    onTodo: (action: string, params: Record<string, unknown>): Promise<string> =>
      Promise.resolve(fallbackTodo(action, params)),
  });
}
