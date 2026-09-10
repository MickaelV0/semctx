/**
 * The documented core-package regression recipe (ADR 0022): a real red → fix → green cycle,
 * bound to one existing function and its existing test, run entirely inside a throwaway temporary
 * witness directory. It never edits a contributor's actual source tree — the mutation is applied
 * to, and reverted on, a copy made under the OS temp directory only.
 *
 * The target is `symbolId` in `packages/core/src/ids.ts`, exercised by its existing test in
 * `packages/core/test/ids.test.ts` ("carries no source line…"). The break is a genuine one-token
 * change to the function's own logic (the scope/name join separator), so the resulting test
 * failure is a real assertion mismatch on that test — never an unrelated thrown error standing in
 * for "red".
 */

import { parseBunTestCount } from "./check";

export const RECIPE_TARGET_FUNCTION = "symbolId (packages/core/src/ids.ts)";
export const RECIPE_TARGET_TEST =
  'packages/core/test/ids.test.ts — "carries no source line: a harmless insertion above a declaration cannot change it"';
export const RECIPE_TARGET_TEST_ANCHOR = "carries no source line";

const RECIPE_SOURCE_PATH = "packages/core/src/ids.ts";
const RECIPE_TEST_PATH = "packages/core/test/ids.test.ts";

const RECIPE_INTACT_ANCHOR =
  'return `sym:${kind}:${normalizePath(relPath)}:${[...scope, name].join(".")}`;';
const RECIPE_BROKEN_ANCHOR =
  'return `sym:${kind}:${normalizePath(relPath)}:${[...scope, name].join("#")}`;';

/**
 * A genuine one-token break in `symbolId`'s own join separator. Throws rather than silently
 * mutating nothing when the anchor is not found, because a recipe that reports "red" without
 * having changed anything is exactly the fake failure ADR 0022 forbids.
 */
export function applyRecipeMutation(source: string): string {
  if (!source.includes(RECIPE_INTACT_ANCHOR)) {
    throw new Error(
      `regression recipe anchor not found in ${RECIPE_SOURCE_PATH} — the source has drifted; ` +
        "update scripts/contributor/regression-recipe.ts to match its current text.",
    );
  }
  return source.replace(RECIPE_INTACT_ANCHOR, RECIPE_BROKEN_ANCHOR);
}

export function isRecipeMutationApplied(source: string): boolean {
  return source.includes(RECIPE_BROKEN_ANCHOR) && !source.includes(RECIPE_INTACT_ANCHOR);
}

export type RecipeReason =
  | "RECIPE_RED_PHASE_DID_NOT_FAIL"
  | "RECIPE_RED_PHASE_WRONG_FAILURE"
  | "RECIPE_GREEN_PHASE_FAILED"
  | "RECIPE_GREEN_PHASE_NO_OUTPUT";

export interface RecipePhaseResult {
  readonly label: "red" | "green";
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly testsExecuted: number | undefined;
}

export interface RecipeOutcome {
  readonly witnessDirectory: string;
  readonly targetFunction: string;
  readonly targetTest: string;
  readonly setupDurationMs: number;
  readonly red: RecipePhaseResult;
  readonly green: RecipePhaseResult;
  readonly ok: boolean;
  readonly reasons: readonly RecipeReason[];
}

export interface RecipeCapturedCommand {
  readonly code: number;
  readonly output: string;
}

export interface RecipeRuntimeDependencies {
  readonly repositoryRoot: string;
  readTextFile(path: string): string;
  /** Creates a fresh, empty temporary directory and returns its absolute path. */
  makeTemporaryDirectory(): string;
  makeDirectory(path: string): void;
  writeTextFile(path: string, contents: string): void;
  removeDirectory(path: string): void;
  joinPath(...segments: string[]): string;
  run(argv: readonly string[], cwd: string): Promise<RecipeCapturedCommand>;
  /** A monotonic clock, e.g. `performance.now`. */
  now(): number;
  log(message: string): void;
}

/** Bun's own test-summary line, e.g. "Ran 12 tests across 3 files. [50.00ms]". */
const parseTestCount = parseBunTestCount;

interface PhaseOutcome {
  readonly phase: RecipePhaseResult;
  readonly output: string;
}

async function runPhase(
  deps: RecipeRuntimeDependencies,
  label: "red" | "green",
  cwd: string,
  argv: readonly string[],
): Promise<PhaseOutcome> {
  const started = deps.now();
  const { code, output } = await deps.run(argv, cwd);
  const durationMs = deps.now() - started;
  deps.log(output);
  return { phase: { label, argv, exitCode: code, durationMs, testsExecuted: parseTestCount(output) }, output };
}

/**
 * Run the full setup → red → green cycle against a throwaway copy of the real source and test.
 * Cleans up the witness directory itself once the cycle completes, whether it passed or not.
 */
export async function runRegressionRecipe(deps: RecipeRuntimeDependencies): Promise<RecipeOutcome> {
  const setupStarted = deps.now();
  const witnessDirectory = deps.makeTemporaryDirectory();
  try {
  const srcDirectory = deps.joinPath(witnessDirectory, "src");
  const testDirectory = deps.joinPath(witnessDirectory, "test");
  deps.makeDirectory(srcDirectory);
  deps.makeDirectory(testDirectory);

  const originalSource = deps.readTextFile(deps.joinPath(deps.repositoryRoot, RECIPE_SOURCE_PATH));
  const testSource = deps.readTextFile(deps.joinPath(deps.repositoryRoot, RECIPE_TEST_PATH));
  const sourcePath = deps.joinPath(srcDirectory, "ids.ts");
  const testPath = deps.joinPath(testDirectory, "ids.test.ts");
  deps.writeTextFile(sourcePath, originalSource);
  deps.writeTextFile(testPath, testSource);
  const setupDurationMs = deps.now() - setupStarted;

  const argv = [process.execPath, "test", "test/ids.test.ts", "--test-name-pattern", RECIPE_TARGET_TEST_ANCHOR];

    deps.writeTextFile(sourcePath, applyRecipeMutation(originalSource));
    const red = await runPhase(deps, "red", witnessDirectory, argv);

    deps.writeTextFile(sourcePath, originalSource);
    const green = await runPhase(deps, "green", witnessDirectory, argv);

    const reasons: RecipeReason[] = [];
    if (red.phase.exitCode === 0) {
      reasons.push("RECIPE_RED_PHASE_DID_NOT_FAIL");
    } else if (red.phase.testsExecuted !== 1 || !Bun.stripANSI(red.output).includes(RECIPE_TARGET_TEST_ANCHOR) || !Bun.stripANSI(red.output).includes('Expected: "sym:function:src/a.ts:Outer.run"') || !Bun.stripANSI(red.output).includes('Received: "sym:function:src/a.ts:Outer#run"')) {
      // A generic crash (import error, syntax error) fails the whole file without ever naming the
      // target test — that is a broken recipe, not a demonstrated regression.
      reasons.push("RECIPE_RED_PHASE_WRONG_FAILURE");
    }
    if (green.phase.exitCode !== 0) {
      reasons.push("RECIPE_GREEN_PHASE_FAILED");
    } else if (green.phase.testsExecuted === undefined || green.phase.testsExecuted === 0) {
      reasons.push("RECIPE_GREEN_PHASE_NO_OUTPUT");
    }

    return {
      witnessDirectory,
      targetFunction: RECIPE_TARGET_FUNCTION,
      targetTest: RECIPE_TARGET_TEST,
      setupDurationMs,
      red: red.phase,
      green: green.phase,
      ok: reasons.length === 0,
      reasons,
    };
  } finally {
    deps.removeDirectory(witnessDirectory);
  }
}
