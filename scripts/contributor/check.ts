/**
 * The explicit "check <scope>" operation (ADR 0022).
 *
 * A scope's success proves only the real `bun test` invocation it names — never full-gate
 * completeness. Two failure modes get equal weight here: the child process failing, and the
 * child process succeeding while proving nothing (no test actually ran). The latter is the
 * "document opening / empty no-op" case ADR 0022 names explicitly; a zero exit code alone is
 * never accepted as evidence.
 */

import { CONTRIBUTOR_CHECK_SCOPES, findContributorScope, type ContributorScope } from "./scopes";

export { CONTRIBUTOR_CHECK_SCOPES, findContributorScope };
export type { ContributorScope };

export type CheckReason =
  | "SCOPE_UNKNOWN"
  | "SCOPE_TEST_DIRECTORY_MISSING"
  | "SCOPE_COMMAND_FAILED"
  | "SCOPE_PRODUCED_NO_TEST_OUTPUT";

export interface CheckOutcome {
  readonly scope: string | null;
  readonly argv: readonly string[];
  readonly covers: readonly string[];
  readonly omits: readonly string[];
  readonly ran: boolean;
  readonly testsExecuted: number | null;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly reasons: readonly CheckReason[];
  readonly ok: boolean;
}

export interface CapturedCommand {
  readonly code: number;
  readonly output: string;
}

export type CapturingCommandRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<CapturedCommand>;

export interface RunContributorCheckDependencies {
  readonly cwd: string;
  readonly run: CapturingCommandRunner;
  readonly pathExists: (path: string) => boolean;
  /** A monotonic clock, e.g. `performance.now`. Never wall-clock time. */
  readonly now: () => number;
  readonly log: (message: string) => void;
}

/** Bun's own test-summary line, e.g. "Ran 12 tests across 3 files. [50.00ms]". */
export function parseBunTestCount(output: string): number | undefined {
  const matches = [...Bun.stripANSI(output).matchAll(/^Ran\s+(\d+)\s+tests? across \d+ files?\./gm)];
  const count = matches.at(-1)?.[1];
  if (count === undefined) return undefined;
  const parsed = Number.parseInt(count, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function unknownScopeOutcome(): CheckOutcome {
  return {
    scope: null,
    argv: [],
    covers: [],
    omits: [],
    ran: false,
    testsExecuted: null,
    durationMs: 0,
    exitCode: 2,
    reasons: ["SCOPE_UNKNOWN"],
    ok: false,
  };
}

function missingDirectoryOutcome(scope: ContributorScope): CheckOutcome {
  return {
    scope: scope.name,
    argv: scope.argv,
    covers: scope.covers,
    omits: scope.omits,
    ran: false,
    testsExecuted: null,
    durationMs: 0,
    exitCode: 1,
    reasons: ["SCOPE_TEST_DIRECTORY_MISSING"],
    ok: false,
  };
}

export async function runContributorCheck(
  scopeName: string,
  deps: RunContributorCheckDependencies,
): Promise<CheckOutcome> {
  const scope = findContributorScope(scopeName);
  if (scope === undefined) {
    deps.log(
      `[contributor] UNKNOWN scope "${scopeName}" — an unknown or cross-cutting area requires the full gate: bun run verify:pr`,
    );
    return unknownScopeOutcome();
  }

  deps.log(`[contributor] scope: ${scope.name} — ${scope.description}`);
  deps.log(`[contributor] covers: ${scope.covers.join(", ")}`);
  deps.log(`[contributor] omits (still requires bun run verify:pr before a PR): ${scope.omits.join(", ")}`);
  deps.log(`[contributor] argv: ${scope.argv.join(" ")}`);

  if (!deps.pathExists(scope.testDirectory)) {
    deps.log(`[contributor] FAIL  required test directory is missing: ${scope.testDirectory}`);
    return missingDirectoryOutcome(scope);
  }

  const started = deps.now();
  const { code, output } = await deps.run(scope.argv, deps.cwd);
  const durationMs = deps.now() - started;
  deps.log(output);

  const reasons: CheckReason[] = [];
  if (code !== 0) reasons.push("SCOPE_COMMAND_FAILED");
  const testsExecuted = parseBunTestCount(output);
  if (testsExecuted === undefined || testsExecuted === 0) reasons.push("SCOPE_PRODUCED_NO_TEST_OUTPUT");

  const ok = reasons.length === 0;
  deps.log(
    ok
      ? `[contributor] PASS  ${scope.name} (${String(testsExecuted)} tests, ${durationMs.toFixed(1)}ms) — targeted only, not a substitute for verify:pr`
      : `[contributor] FAIL  ${scope.name}: ${reasons.join(", ")}`,
  );

  return {
    scope: scope.name,
    argv: scope.argv,
    covers: scope.covers,
    omits: scope.omits,
    ran: true,
    testsExecuted: testsExecuted ?? 0,
    durationMs,
    exitCode: ok ? 0 : code !== 0 ? code : 1,
    reasons,
    ok,
  };
}
