/** Footer status line for an active RLM run (complements the tree widget above the editor). */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const KEY = "rlm";

export function clearRlmStatus(ui: ExtensionUIContext): void {
  ui.setStatus(KEY, undefined);
}
