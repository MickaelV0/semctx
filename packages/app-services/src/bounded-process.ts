import { runProcessWithinBudget as spawnWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";

export const DEFAULT_PREFLIGHT_BUDGET_MS = 15_000;
export const MIN_PREFLIGHT_BUDGET_MS = 1_000;
export const MAX_PREFLIGHT_BUDGET_MS = 600_000;

export type BoundedProcessOutcome =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number };

export interface BoundedProcessOptions {
  cwd: string;
  budgetMs: number;
  env?: Record<string, string | undefined>;
}

export function isValidPreflightBudget(budgetMs: number): boolean {
  return Number.isSafeInteger(budgetMs) && budgetMs >= MIN_PREFLIGHT_BUDGET_MS && budgetMs <= MAX_PREFLIGHT_BUDGET_MS;
}

export async function runProcessWithinBudget(argv: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessOutcome> {
  return await spawnWithinBudget(argv, options);
}
