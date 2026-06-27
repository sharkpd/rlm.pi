/** Shared guards for inherited recursive-call resource limits. */

import { formatError } from "../util/errors.ts";

export interface RemainingResources {
  readonly budgetUsd?: number;
  readonly timeoutMs?: number;
}

export function checkResourceLimits(resources: RemainingResources): string | undefined {
  if (resources.budgetUsd !== undefined && resources.budgetUsd <= 0) return formatError("budget exhausted");
  if (resources.timeoutMs !== undefined && resources.timeoutMs <= 0) return formatError("timeout exhausted");
  return undefined;
}
