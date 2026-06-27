/**
 * Editing root prompt for `propose_edits`.
 *
 * The RLM paper (Algorithm 1) requires the root model to invoke the sub-LLM
 * programmatically from within the REPL — the negotiation loop runs INSIDE one
 * engine run via `llm_query`, not as separate TypeScript-orchestrated runs.
 *
 * This single prompt instructs the model to drive a generate→validate→revise
 * loop using `llm_query`, then return the final diff through the `answer`
 * object (which the engine surfaces as `RlmResult.answer`).
 */

export function buildEditingRootPrompt(instruction: string): string {
  return [
    "# Task",
    instruction,
    "",
    "# How to work",
    "The file to edit (or create) is described in the `context` variable — read it with Python.",
    "If the context says '(new file — does not exist yet)', produce a diff that adds all lines",
    "(every line is a `+` addition with `@@ -0,0 +1,N @@`); use the actual filename in the header.",
    "To reach a high-quality result, run a generate→validate→revise loop using",
    "`llm_query` inside this REPL:",
    "",
    "1. GENERATE — call `llm_query` asking for a minimal unified diff for the task,",
    "   passing the file content. Keep only the ```diff``` block from its reply.",
    "2. VALIDATE — call `llm_query` with a strict reviewer prompt and the candidate",
    "   diff. The reviewer must reply either `APPROVED` or",
    "   `ISSUES: <concise bulleted list>`. Be strict — an incomplete diff is NOT approved.",
    "3. REVISE — on ISSUES, call `llm_query` to produce a corrected diff that addresses",
    "   every issue, then validate again.",
    "4. Repeat steps 2-3 for at most 3 rounds total.",
    "",
    "# Rules",
    "- Smallest possible change that satisfies the task.",
    "- No reformatting unless the task requires it.",
    "- The diff must be a valid unified diff with EXACTLY this header format (filename required):",
    "    --- a/<filename>",
    "    +++ b/<filename>",
    "  followed by `@@` hunk markers. Never write `---` on a line by itself.",
    "",
    "# Finishing",
    "When the reviewer approves the diff (or you reach 3 rounds), set:",
    "  answer['content'] = <the final raw unified diff>",
    "  answer['ready'] = True",
    "The content MUST be the raw unified diff and nothing else — no markdown fence,",
    "no explanation.",
  ].join("\n");
}
