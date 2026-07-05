import type { ProposedEdit } from "../sandbox/protocol.ts";

export class EditRegistry {
  private readonly edits = new Map<string, ProposedEdit>();

  registerAll(edits: readonly ProposedEdit[] | undefined): void {
    if (edits === undefined) return;
    for (const edit of edits) this.edits.set(edit.id, edit);
  }

  get(id: string): ProposedEdit | undefined {
    return this.edits.get(id);
  }

  delete(id: string): boolean {
    return this.edits.delete(id);
  }

  clear(): void {
    this.edits.clear();
  }
}
