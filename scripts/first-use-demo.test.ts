import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_CASES } from "./first-use-demo/fixture";
import { identifyPackagedCli } from "./first-use-demo/identity";
import { asVerifyReport, runFirstUseDemo, MANIFEST_FILENAME } from "./first-use-demo/runner";

const repoRoot = resolve(import.meta.dir, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "semctx-first-use-demo-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const fresh = (name: string) => join(scratch, `${++sequence}-${name}`);

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, verdict: "PASS", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: FIXTURE_CASES.map(c => c.file.relPath), changedSymbols: [], impactedContracts: [],
    impactedInvariants: [], recommendedTests: [], contradictions: [], unknowns: [], findings: [],
    summary: { blockCount: 0, warnCount: 0 }, ...overrides,
  };
}

function fakeCli(options: { setup?: string; setupCode?: number; verify?: string; verifyCode?: number; drift?: boolean } = {}): string {
  const folder = fresh("fake-runtime"); mkdirSync(folder);
  const path = join(folder, "index.js");
  writeFileSync(path, `import { appendFileSync } from 'node:fs';
const cmd = process.argv[2];
if (cmd === '--version') { console.log('0.0.0'); }
else if (cmd === 'setup') { console.log(${JSON.stringify(options.setup ?? '{"setupReady":true}')}); process.exit(${options.setupCode ?? 0}); }
else if (cmd === 'index') { console.log('{}'); }
else if (cmd === 'verify') {
  if (${options.drift ?? false}) appendFileSync(import.meta.path, '\\n// drift');
  console.log(${JSON.stringify(options.verify ?? JSON.stringify(report()))}); process.exit(${options.verifyCode ?? 0});
} else process.exit(9);
`);
  return path;
}

test("three controlled changes produce the actual packaged warning and no fabricated per-file verdict", async () => {
  const runtime = fresh("golden-runtime"); mkdirSync(runtime);
  const cliPath = join(runtime, "index.js");
  // Bun.build can poison the test runner's workspace resolver on POSIX. Keep both
  // the compiler process and its output isolated, as in plugins/plugin-build.test.ts.
  const builder = `
import { join } from "node:path";
import { buildPortableBundle, CLI_BUNDLE_SPEC, INDEX_WORKER_BUNDLE_SPEC, writePortableTypeScriptLibs } from ${JSON.stringify(pathToFileURL(join(repoRoot, "scripts", "build-plugin-runtime.ts")).href)};
const runtime = ${JSON.stringify(runtime)};
await Bun.write(join(runtime, "index.js"), await buildPortableBundle(CLI_BUNDLE_SPEC));
await Bun.write(join(runtime, INDEX_WORKER_BUNDLE_SPEC.name), await buildPortableBundle(INDEX_WORKER_BUNDLE_SPEC));
writePortableTypeScriptLibs(runtime);
`;
  const child = Bun.spawn([process.execPath, "--eval", builder], {
    cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, `isolated demo build failed\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
  const outDir = fresh("golden");
  const outcome = runFirstUseDemo({ cliPath, outDir });
  expect(outcome.status, outcome.detail ?? "").toBe("COMPLETED");
  expect(outcome.verdict).toBe("WARN");
  expect(outcome.commands.map(c => c.label)).toEqual(["version", "setup", "index", "verify-diff"]);
  expect(outcome.commands.every(c => c.code === 0)).toBe(true);
  expect(outcome.cases.map(c => c.observedRules)).toEqual([[], ["contract_changed_without_test"], []]);
  expect(outcome.cases.every(c => c.matchedExpectation)).toBe(true);
  expect(outcome.workingDiffDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(outcome.fixtureHeadCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(outcome.cli.runtimeFiles.some(f => f.path.startsWith("typescript-lib/"))).toBe(true);
  expect(outcome.cli.authenticatedSource).toBe("UNKNOWN");
  expect(outcome.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  const markdown = readFileSync(join(outDir, "report.md"), "utf8");
  expect(markdown).toContain("Global verdict for the combined diff");
  for (const unknown of outcome.unknowns) expect(markdown).toContain(unknown);
  expect(markdown).not.toContain("that PASS");
  expect(JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8")).status).toBe("COMPLETED");
  for (const command of outcome.commands) expect(existsSync(join(outDir, command.stdoutFile))).toBe(true);
}, 120_000);

test("existing output is preserved even with forged ownership, or when empty", () => {
  const cli = fakeCli();
  for (const forged of [false, true]) {
    const outDir = fresh("existing"); mkdirSync(outDir);
    if (forged) writeFileSync(join(outDir, MANIFEST_FILENAME), JSON.stringify({ kind: "semctx-first-use-demo-manifest-v1" }));
    const sentinel = join(outDir, "sentinel"); writeFileSync(sentinel, "keep");
    expect(runFirstUseDemo({ cliPath: cli, outDir }).status).toBe("BLOCKED");
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  }
  const empty = fresh("empty"); mkdirSync(empty);
  expect(runFirstUseDemo({ cliPath: cli, outDir: empty }).status).toBe("BLOCKED");
});

test("linked output and linked ancestor cannot write through outside", () => {
  const outside = fresh("outside"); mkdirSync(outside);
  const link = fresh("link"); symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const cli = fakeCli();
  for (const outDir of [link, join(link, "new-output")]) expect(runFirstUseDemo({ cliPath: cli, outDir }).reason).toBe("INVALID_OUTPUT_PATH");
  expect(existsSync(join(outside, "new-output"))).toBe(false);
});

test("missing and mismatched frozen artifacts write no output", () => {
  const outDir = fresh("missing");
  expect(runFirstUseDemo({ cliPath: fresh("absent.js"), outDir }).reason).toBe("CLI_ARTIFACT_MISSING");
  expect(existsSync(outDir)).toBe(false);
  expect(runFirstUseDemo({ cliPath: fakeCli(), outDir, expectedArtifactDigest: "0".repeat(64) }).reason).toBe("ARTIFACT_DRIFT");
  expect(existsSync(outDir)).toBe(false);
});

test("support libraries are part of runtime identity", () => {
  const cli = fakeCli(); const lib = join(dirname(cli), "typescript-lib"); mkdirSync(lib);
  const before = identifyPackagedCli(cli).runtimeDigest;
  writeFileSync(join(lib, "lib.d.ts"), "declare const x: number;");
  expect(identifyPackagedCli(cli).runtimeDigest).not.toBe(before);
});

test.each([
  ["malformed setup", { setup: "bad json" }, "SETUP_OUTPUT_MALFORMED"],
  ["setup failure", { setupCode: 1 }, "SETUP_CHILD_FAILED"],
  ["not ready", { setup: '{"setupReady":false}' }, "SETUP_NOT_READY"],
  ["empty verify", { verify: "{}" }, "VERIFY_OUTPUT_INCOMPLETE"],
  ["malformed verify", { verify: "bad json" }, "VERIFY_OUTPUT_MALFORMED"],
  ["missing case", { verify: JSON.stringify(report({ changedFiles: ["src/greeting.ts"] })) }, "FIXTURE_DRIFT"],
  ["extra case", { verify: JSON.stringify(report({ changedFiles: [...FIXTURE_CASES.map(c => c.file.relPath), "foreign.ts"] })) }, "FIXTURE_DRIFT"],
  ["unexpected exit", { verifyCode: 2 }, "VERIFY_CHILD_UNEXPECTED_EXIT"],
  ["artifact mutation", { drift: true }, "ARTIFACT_DRIFT"],
] as const)("rejects %s from a real child and persists the blocked outcome", (_name, options, reason) => {
  const outDir = fresh("negative");
  const outcome = runFirstUseDemo({ cliPath: fakeCli(options), outDir });
  expect(outcome.reason).toBe(reason);
  expect(outcome.status).toBe("BLOCKED");
  expect(JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8")).reason).toBe(reason);
}, 30_000);

test("rejects inconsistent versions, verdicts, counts, findings and exit codes", () => {
  for (const invalid of [{ schemaVersion: 2 }, { verdict: "GREEN" }, { verdict: "BLOCK" }, { unknowns: [8] }, { summary: { warnCount: 1, blockCount: 0 } }, { findings: [{}] }, { changedSymbols: [{}] }]) expect(asVerifyReport(report(invalid), 0)).toBeNull();
  expect(asVerifyReport(report(), 3)).toBeNull();
});

test("renders product uncertainty and rejects removed force flag", () => {
  const outDir = fresh("unknown");
  const outcome = runFirstUseDemo({ cliPath: fakeCli({ verify: JSON.stringify(report({ unknowns: ["STALE: test uncertainty"] })) }), outDir });
  expect(outcome.status).toBe("COMPLETED");
  expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("STALE: test uncertainty");
  const child = Bun.spawnSync([process.execPath, "scripts/first-use-demo.ts", "--force"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(new TextDecoder().decode(child.stderr)).toContain("Unknown or incomplete argument");
}, 30_000);
