/** Shared unsubscribe lifecycle for classes that attach to RlmEmitter events. */

import { errorMessage } from "../util/errors.ts";

export abstract class EmitterListener {
  private readonly unsubs: (() => void)[] = [];

  protected track(unsub: () => void): void {
    this.unsubs.push(unsub);
  }

  protected trackAll(unsubs: readonly (() => void)[]): void {
    for (const unsub of unsubs) this.track(unsub);
  }

  /** Detach all registered listeners. Safe to call more than once. */
  dispose(): void {
    const unsubs = this.unsubs.splice(0);
    for (const unsub of unsubs) {
      try { unsub(); }
      catch (error) { console.warn(`[rlm] listener cleanup failed: ${errorMessage(error)}`); }
    }
  }
}
