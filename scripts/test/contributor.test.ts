import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseContributorArgs, runFullCommand } from "../contributor";
import { runContributorCheck, parseBunTestCount } from "../contributor/check";
import { evaluateBunRuntime, evaluateJsDependencies, evaluatePythonInterpreter, evaluatePythonTool, parseRequirementsQualityPins } from "../contributor/inspect";
import { applyRecipeMutation, runRegressionRecipe, RECIPE_TARGET_TEST_ANCHOR, type RecipeRuntimeDependencies } from "../contributor/regression-recipe";
import { buildContributorCheckReport } from "../contributor/report";

const root = resolve(import.meta.dir, "../..");
test("diagnoses missing, incompatible and failed prerequisites", () => {
  expect(evaluateBunRuntime({ version: "1.3.0", requiredRange: ">=1.4.0" }).status).toBe("incompatible");
  expect(evaluateBunRuntime({ version: "bad", requiredRange: ">=1.4.0" }).status).toBe("unknown");
  expect(evaluateBunRuntime({ version: "1.4.0", requiredRange: "unknown" }).status).toBe("unknown");
  expect(evaluateJsDependencies({ nodeModulesPresent: false, checkedPackages: ["typescript"], missingPackages: ["typescript"] }).status).toBe("absent");
  expect(evaluateJsDependencies({ nodeModulesPresent: true, checkedPackages: ["typescript"], missingPackages: ["typescript"] }).status).toBe("incompatible");
  expect(evaluatePythonInterpreter({ which: null, queryOk: false, rawVersion: null }).status).toBe("absent");
  expect(evaluatePythonInterpreter({ which: "/python", queryOk: false, rawVersion: "Python 3.14.0" }).status).toBe("unknown");
  const base = { id: "ruff", label: "Ruff", requiredVersion: "0.16.5", which: "/ruff", queryOk: true, rawVersion: "ruff 0.16.5" };
  expect(evaluatePythonTool(base).status).toBe("ok");
  expect(evaluatePythonTool({ ...base, which: null }).status).toBe("absent");
  expect(evaluatePythonTool({ ...base, queryOk: false }).status).toBe("unknown");
  expect(evaluatePythonTool({ ...base, rawVersion: "ruff 0.16.1" }).status).toBe("incompatible");
  expect(parseRequirementsQualityPins("# quality\nruff==0.16.5\nzizmor==1.29.0\n")).toEqual({ ruff: "0.16.5", zizmor: "1.29.0" });
});

test("rejects unknown flags and partial full gates before launch", () => {
  expect(parseContributorArgs([])).toEqual({ kind: "inspect", json: false });
  expect(parseContributorArgs(["--json"])).toEqual({ kind: "inspect", json: true });
  for (const args of [["inspect", "--install"], ["check"], ["check", "core", "extra"], ["recipe", "bad"], ["full", "--skip-diff"], ["full", "--bad"]]) expect(() => parseContributorArgs(args)).toThrow();
});

test("unknown or missing test scopes never invoke a process", async () => {
  let calls = 0;
  const deps = { cwd: root, run: async () => { calls++; return { code: 0, output: "" }; }, pathExists: () => false, now: () => 0, log: () => {} };
  expect((await runContributorCheck("unknown", deps)).reasons).toEqual(["SCOPE_UNKNOWN"]);
  expect((await runContributorCheck("core", deps)).reasons).toEqual(["SCOPE_TEST_DIRECTORY_MISSING"]);
  expect(calls).toBe(0);
});

test("targeted checks require actual Bun test output and preserve failures", async () => {
  const invoke = (code: number, output: string) => runContributorCheck("core", { cwd: root, run: async () => ({ code, output }), pathExists: () => true, now: () => 1, log: () => {} });
  expect((await invoke(0, "opened a document")).ok).toBe(false);
  expect((await invoke(0, "Ran 0 tests across 0 files.")).ok).toBe(false);
  expect((await invoke(7, "Ran 2 tests across 1 file.")).exitCode).toBe(7);
  const valid = await invoke(0, "Ran 2 tests across 1 file. [1ms]");
  expect(valid.ok).toBe(true); expect(valid.testsExecuted).toBe(2);
  expect(valid.omits).toContain("typecheck (tsc)");
  expect(valid.covers.some(c => c.includes("src/**"))).toBe(false);
  expect(parseBunTestCount("pretending: Ran 10 tests")).toBeUndefined();
  for (const output of [
    "Ran 42 tests across 1 file.\nRan 0 tests across 1 file.",
    "Ran 0 tests across 1 file.\nRan 42 tests across 1 file.",
    "Ran 42 tests across 1 file.\nRan 9 tests across 1 file.",
  ]) {
    const ambiguous = await invoke(0, output);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.testsExecuted).toBe(0);
    expect(parseBunTestCount(output)).toBeUndefined();
  }
});

test("rejects a delayed inherited-stderr summary after Bun reports zero tests", async () => {
  const witnessDirectory = mkdtempSync(resolve(tmpdir(), "semctx-contributor-summary-"));
  const delayedChild = resolve(witnessDirectory, "delayed-child.ts");
  const noTestsModule = resolve(witnessDirectory, "no-tests.ts");
  try {
    writeFileSync(delayedChild, "await Bun.sleep(200);\nconsole.error(\"Ran 9 tests across 1 file.\");\n");
    writeFileSync(
      noTestsModule,
      `import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(delayedChild)}], { detached: true, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });\nchild.unref();\n`,
    );
    const child = Bun.spawn([process.execPath, "test", noTestsModule], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 10_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(deadline));
    const output = `${stdout}${stderr}`;
    expect(exitCode, output).toBe(0);
    expect(output).toContain("Ran 0 tests");
    expect(output).toContain("Ran 9 tests across 1 file.");
    expect(parseBunTestCount(output)).toBeUndefined();
  } finally {
    rmSync(witnessDirectory, { recursive: true, force: true });
  }
}, 15_000);

test("full forwards canonical argv and exact failure; empty success remains incomplete", async () => {
  const seen: string[][] = [];
  const code = await runFullCommand(["--base", "origin/main"], false, async argv => { seen.push([...argv]); return { code: 7, output: "" }; });
  expect(code).toBe(7);
  expect(seen).toEqual([[process.execPath, "scripts/verify-pr.ts", "--base", "origin/main"]]);
  expect(await runFullCommand([], false, async () => ({ code: 0, output: "" }))).toBe(1);
  expect(await runFullCommand([], false, async () => ({ code: 0, output: "[verify:pr] PASS  all checks\n" }))).toBe(0);
});

test("regression recipe preserves red/green integrity and cleans up failed setup", async () => {
  const source = readFileSync(resolve(root, "packages/core/src/ids.ts"), "utf8");
  expect(applyRecipeMutation(source)).not.toBe(source);
  expect(() => applyRecipeMutation("drift")).toThrow("anchor");
  const goodRed = `${RECIPE_TARGET_TEST_ANCHOR}\nExpected: "sym:function:src/a.ts:Outer.run"\nReceived: "sym:function:src/a.ts:Outer#run"\nRan 1 test across 1 file.`;
  for (const [redCode, redOutput, greenCode, greenOutput, expected] of [
    [0, goodRed, 0, "Ran 1 test across 1 file.", "RECIPE_RED_PHASE_DID_NOT_FAIL"],
    [1, "import error", 0, "Ran 1 test across 1 file.", "RECIPE_RED_PHASE_WRONG_FAILURE"],
    [1, goodRed, 1, "Ran 1 test across 1 file.", "RECIPE_GREEN_PHASE_FAILED"],
    [1, goodRed, 0, "", "RECIPE_GREEN_PHASE_NO_OUTPUT"],
  ] as const) {
    let removed = false; let runs = 0;
    const deps: RecipeRuntimeDependencies = { repositoryRoot: root, readTextFile: () => source, makeTemporaryDirectory: () => "/owned", makeDirectory: () => {}, writeTextFile: () => {}, removeDirectory: () => { removed = true; }, joinPath: (...p) => p.join("/"), run: async () => runs++ === 0 ? { code: redCode, output: redOutput } : { code: greenCode, output: greenOutput }, now: () => 1, log: () => {} };
    expect((await runRegressionRecipe(deps)).reasons).toContain(expected); expect(removed).toBe(true);
    removed = false;
    let setupFailed = false;
    try { await runRegressionRecipe({ ...deps, readTextFile: () => { throw new Error("missing source"); } }); }
    catch (error) { setupFailed = true; expect(String(error)).toContain("missing source"); }
    expect(setupFailed).toBe(true);
    expect(removed).toBe(true);
  }
});

test("machine report rejects non-finite durations", () => {
  expect(() => buildContributorCheckReport({ command: "check", classification: "targeted", argv: [], scope: "core", covers: [], omits: [], ok: true, exitCode: 0, durationMs: NaN, reasons: [], prerequisites: [] })).toThrow("finite");
});

test("real targeted test and real red/green recipe produce parseable local JSON", () => {
  for (const args of [["check", "core"], ["recipe"]]) {
    const child = Bun.spawnSync([process.execPath, "scripts/contributor.ts", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(result.verification).toBe("incomplete"); expect(result.humanTime).toBe("NOT_MEASURED");
    expect(result.toolVersions.bun).toBe(Bun.version); expect(result.durationMs).toBeGreaterThanOrEqual(0);
    if (args[0] === "recipe") {
      expect(result.recipe.red.exitCode).toBe(1); expect(result.recipe.green.exitCode).toBe(0);
      expect(result.recipe.red.testsExecuted).toBe(1); expect(result.recipe.green.testsExecuted).toBe(1);
      expect(existsSync(result.recipe.witnessDirectory)).toBe(false);
    }
  }
}, 90_000);
