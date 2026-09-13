import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_FILENAME, runContinuityDemo } from "./continuity-demo/runner";

const repoRoot = resolve(import.meta.dir, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "semctx-continuity-demo-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const fresh = (name: string) => join(scratch, `${++sequence}-${name}`);
const freshOut = (name: string) => fresh(name);

/**
 * Build the real packaged CLI once, in an isolated child process (Bun.build cannot run inside
 * `bun test` — see plugins/plugin-build.test.ts), and reuse it for every test in this file. This
 * is the same isolated-child `buildPortableBundle` pattern first-use-demo.test.ts uses, so the
 * "packaged" claim here is a real built bundle, not `apps/cli/src/index.ts` source.
 */
let packagedCliPromise: Promise<string> | undefined;
function packagedCli(): Promise<string> {
  packagedCliPromise ??= buildPackagedCliOnce();
  return packagedCliPromise;
}
async function buildPackagedCliOnce(): Promise<string> {
  const runtime = fresh("packaged-cli-runtime");
  mkdirSync(runtime);
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
  if (exitCode !== 0) {
    throw new Error(`isolated demo build failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return join(runtime, "index.js");
}

type WrapperMutation =
  | "wrong-plan-delete"
  | "wrong-plan-statement"
  | "wrong-plan-rollback"
  | "wrong-diff-refs"
  | "wrong-current-head"
  | "wrong-current-repository"
  | "final-manifest-write-error"
  | "final-report-write-error"
  | "wrong-capsule-reconciliation"
  | "wrong-realized-verdict"
  | "wrong-reconcile-identity"
  | "wrong-historical-identity"
  | "raw-output-write-error"
  | "task-id-only"
  | "report-null"
  | "malformed-json"
  | "wrong-diff-status"
  | "wrong-resume-reason"
  | "corrupt-capsule-bytes"
  | "runtime-drift"
  | "link-source-after-mutation";

/**
 * A real child wrapper around the packaged CLI (never a from-scratch fake): it always spawns the
 * real bundle for every command, and for exactly one targeted, matching invocation it alters one
 * result before printing it. Every non-targeted command, and every non-matching occurrence,
 * passes the real CLI's own stdout/stderr/exit through byte-for-byte.
 */
function wrapperCli(
  realCliPath: string,
  options: {
    targetCommand: "explain" | "resume-handoff" | "index" | "frame-task" | "task-create" | "plan-change" | "reconcile-diff" | "capture";
    phase?: "before" | "after";
    mutation: WrapperMutation;
  },
): string {
  const folder = fresh("wrapper-cli");
  mkdirSync(folder);
  const path = join(folder, "wrapper.mjs");
  // Kept outside `folder`: `identifyPackagedCli` scans the directory containing the CLI path for
  // its runtime digest, and this counter file is mutated during the run.
  const stateDir = fresh("wrapper-cli-state");
  mkdirSync(stateDir);
  const counterPath = join(stateDir, "explain-count.json");
  const continuationModuleHref = pathToFileURL(
    join(repoRoot, "packages", "control-model", "src", "control-continuation.ts"),
  ).href;
  const reconciliationModuleHref = pathToFileURL(join(repoRoot, "packages", "control-model", "src", "reconciliation.ts")).href;
  const handoffModuleHref = pathToFileURL(join(repoRoot, "packages", "control-model", "src", "control-handoff.ts")).href;
  const planningCanonicalHref = pathToFileURL(join(repoRoot, "packages", "control-model", "src", "task-envelope-canonical.ts")).href;
  const planningSchemaHref = pathToFileURL(join(repoRoot, "packages", "control-model", "src", "task-envelope-schemas.ts")).href;
  writeFileSync(path, `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const realCli = ${JSON.stringify(realCliPath)};
const args = process.argv.slice(2);
const targetCommand = ${JSON.stringify(options.targetCommand)};
const phase = ${JSON.stringify(options.phase ?? null)};
const mutation = ${JSON.stringify(options.mutation)};
const counterPath = ${JSON.stringify(counterPath)};

function rootArg() {
  const index = args.indexOf("--root");
  return index === -1 ? process.cwd() : args[index + 1];
}
function hashArg() {
  const flagIndex = args.indexOf("--hash");
  if (flagIndex !== -1) return args[flagIndex + 1];
  // resume-handoff takes the capsule hash as a positional argument, not a --hash flag.
  const resumeIndex = args.indexOf("resume-handoff");
  return resumeIndex === -1 ? null : args[resumeIndex + 1];
}
function isTargetCommand() {
  if (targetCommand === "explain") return args.includes("handoff") && args.includes("explain");
  if (targetCommand === "resume-handoff") return args.includes("resume-handoff");
  if (targetCommand === "frame-task") return args.includes("frame-task");
  if (targetCommand === "plan-change") return args.includes("plan-change");
  if (targetCommand === "task-create") return args[0] === "task" && args[1] === "create";
  if (targetCommand === "reconcile-diff") return args.includes("reconcile-diff");
  if (targetCommand === "capture") return args[0] === "control" && args[1] === "handoff" && args[2] !== "explain";
  return args.includes("index");
}
function explainOccurrence() {
  const previous = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
  const next = previous + 1;
  writeFileSync(counterPath, String(next), "utf8");
  return next;
}

let matches = isTargetCommand();
if (matches && targetCommand === "explain") {
  const occurrence = explainOccurrence();
  matches = occurrence === (phase === "before" ? 1 : 2);
}

const child = spawnSync(process.execPath, [realCli, ...args], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
let stdout = child.stdout ?? "";
const stderr = child.stderr ?? "";
let code = child.status;

if (matches && ["wrong-plan-delete", "wrong-plan-statement", "wrong-plan-rollback"].includes(mutation)) {
  const parsed = JSON.parse(stdout);
  const { computeSemanticChangeSetV1Hash, computePlanningBundleV1Hash } = await import(${JSON.stringify(planningCanonicalHref)});
  const { PlanningBundleV1Schema } = await import(${JSON.stringify(planningSchemaHref)});
  if (mutation === "wrong-plan-delete") {
    const edit = parsed.semanticChangeSet.repositoryEditExpectations[0];
    edit.kind = "delete";
    edit.oldPath = edit.path;
    delete edit.path;
  } else if (mutation === "wrong-plan-statement") {
    parsed.semanticChangeSet.semanticExpectations[0].statement = "Delete the capacity implementation.";
  } else {
    parsed.semanticChangeSet.rollbackDescription = "Keep the changed implementation.";
  }
  parsed.semanticChangeSet.changeSetHash = computeSemanticChangeSetV1Hash(parsed.semanticChangeSet);
  parsed.bundleHash = computePlanningBundleV1Hash(parsed);
  stdout = JSON.stringify(PlanningBundleV1Schema.parse(parsed));
} else if (matches && ["wrong-diff-refs", "wrong-current-head", "wrong-current-repository"].includes(mutation)) {
  const parsed = JSON.parse(stdout);
  const { computeControlContinuationReportV1Hash, ControlContinuationExplainResultV1Schema } = await import(${JSON.stringify(continuationModuleHref)});
  if (mutation === "wrong-diff-refs") {
    const diff = parsed.report.dependencies.find((dependency) => dependency.dependencyKind === "diff");
    diff.baselineRef = parsed.report.historicalSource.observedWorkingDiffHash;
    diff.currentRef = diff.baselineRef;
  } else if (mutation === "wrong-current-head") {
    parsed.report.currentCapture.headCommit = "f".repeat(40);
  } else {
    parsed.report.currentCapture.repositoryIdentity = "repo:other";
  }
  parsed.report.reportHash = computeControlContinuationReportV1Hash(parsed.report);
  stdout = JSON.stringify(ControlContinuationExplainResultV1Schema.parse(parsed));
} else if (matches && mutation === "wrong-capsule-reconciliation") {
  const parsed = JSON.parse(stdout);
  const { computeControlHandoffCapsuleV2Hash, ControlHandoffRecordV2Schema, ControlHandoffCaptureResultV2Schema } = await import(${JSON.stringify(handoffModuleHref)});
  const { serializeControlReport } = await import(${JSON.stringify(reconciliationModuleHref)});
  const directory = join(rootArg(), ".semctx", "working", "handoffs", "v2");
  const stored = JSON.parse(readFileSync(join(directory, parsed.capsule.capsuleHash.slice("sha256:".length) + ".json"), "utf8"));
  parsed.capsule.seals.reconciliationReportHash = "sha256:" + "f".repeat(64);
  parsed.capsule.capsuleHash = computeControlHandoffCapsuleV2Hash(parsed.capsule);
  stored.capsule = parsed.capsule;
  writeFileSync(join(directory, parsed.capsule.capsuleHash.slice("sha256:".length) + ".json"), serializeControlReport(ControlHandoffRecordV2Schema.parse(stored)));
  stdout = JSON.stringify(ControlHandoffCaptureResultV2Schema.parse(parsed));
} else if (matches && mutation === "wrong-realized-verdict") {
  const parsed = JSON.parse(stdout);
  const { computeReconcileDiffReportV1Hash, ReconcileDiffReportV1Schema } = await import(${JSON.stringify(reconciliationModuleHref)});
  parsed.terminalStatus = "REALIZED";
  parsed.primaryReason = null;
  parsed.reasonCodes = [];
  parsed.missingPlannedEditIds = [];
  parsed.requiredPlannedEditIds = [];
  parsed.requiredRoundTripExpectationIds = [];
  parsed.requiredEvidenceRequirementIds = [];
  parsed.secondaryInsufficiencies = [];
  parsed.reportHash = computeReconcileDiffReportV1Hash(parsed);
  stdout = JSON.stringify(ReconcileDiffReportV1Schema.parse(parsed));
  code = 0;
} else if (matches && mutation === "wrong-reconcile-identity") {
  const parsed = JSON.parse(stdout);
  const { computeReconcileDiffReportV1Hash, ReconcileDiffReportV1Schema } = await import(${JSON.stringify(reconciliationModuleHref)});
  parsed.changeSetHash = "sha256:" + "f".repeat(64);
  parsed.reportHash = computeReconcileDiffReportV1Hash(parsed);
  stdout = JSON.stringify(ReconcileDiffReportV1Schema.parse(parsed));
} else if (matches && mutation === "wrong-historical-identity") {
  const parsed = JSON.parse(stdout);
  const { computeControlContinuationReportV1Hash, ControlContinuationExplainResultV1Schema } = await import(${JSON.stringify(continuationModuleHref)});
  parsed.report.historicalSource.planningBundleHash = "sha256:" + "f".repeat(64);
  parsed.report.reportHash = computeControlContinuationReportV1Hash(parsed.report);
  stdout = JSON.stringify(ControlContinuationExplainResultV1Schema.parse(parsed));
} else if (matches && mutation === "raw-output-write-error") {
  mkdirSync(join(rootArg(), "..", "raw", "control-handoff-explain-after.stdout.txt"));
} else if (matches && mutation === "final-report-write-error") {
  mkdirSync(join(rootArg(), "..", "report.md"));
} else if (matches && mutation === "final-manifest-write-error") {
  mkdirSync(join(rootArg(), "..", ${JSON.stringify(MANIFEST_FILENAME)}));
} else if (matches && mutation === "task-id-only") {
  stdout = JSON.stringify({ id: JSON.parse(stdout).id });
} else if (matches && mutation === "corrupt-capsule-bytes") {
  const hash = hashArg();
  if (hash !== null) {
    const capsulePath = join(rootArg(), ".semctx", "working", "handoffs", "v2", hash.slice("sha256:".length) + ".json");
    if (existsSync(capsulePath)) appendFileSync(capsulePath, "\\n// corrupted after capture by a hostile test wrapper");
  }
} else if (matches && (mutation === "report-null" || mutation === "wrong-diff-status" || mutation === "wrong-resume-reason")) {
  try {
    const parsed = JSON.parse(stdout);
    if (mutation === "report-null") {
      parsed.report = null;
    } else if (mutation === "wrong-diff-status" && parsed.report !== null) {
      const dependency = parsed.report.dependencies.find((d) => d.dependencyKind === "diff");
      if (dependency !== undefined) {
        dependency.status = "UNKNOWN";
        dependency.closedReason = "DEPENDENCY_UNVERIFIED";
        const { computeControlContinuationReportV1Hash } = await import(${JSON.stringify(continuationModuleHref)});
        parsed.report.reportHash = computeControlContinuationReportV1Hash(parsed.report);
      }
    } else if (mutation === "wrong-resume-reason" && Array.isArray(parsed.reasonCodes) && parsed.reasonCodes.includes("HANDOFF_DIFF_STALE")) {
      parsed.reasonCodes = ["HANDOFF_HEAD_STALE"];
    }
    stdout = JSON.stringify(parsed);
  } catch { /* leave stdout as-is: the runner must reject malformed output on its own */ }
} else if (matches && mutation === "malformed-json") {
  stdout = "not-json-output";
} else if (matches && mutation === "runtime-drift") {
  appendFileSync(import.meta.path, "\\n// runtime drift injected by a hostile test wrapper");
} else if (matches && mutation === "link-source-after-mutation") {
  const root = rootArg();
  const srcDir = join(root, "src");
  const elsewhere = join(root, "src-elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "capacity.ts"), readFileSync(join(srcDir, "capacity.ts"), "utf8"));
  rmSync(srcDir, { recursive: true, force: true });
  symlinkSync(elsewhere, srcDir, process.platform === "win32" ? "junction" : "dir");
}

process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(code === null ? 1 : code);
`, "utf8");
  return path;
}

describe("continuity demo runner (real packaged CLI child processes)", () => {
  it(
    "completes the full task -> plan -> reconcile -> capture -> stale -> refused-resume -> restore journey "
      + "against the real packaged CLI",
    async () => {
      const cliPath = await packagedCli();
      const outDir = freshOut("journey");
      const outcome = runContinuityDemo({ cliPath, outDir });

      expect(outcome.status, JSON.stringify(outcome, null, 2)).toBe("COMPLETED");
      expect(outcome.reason).toBeNull();
      expect(outcome.fixtureHeadCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(outcome.discoveredCoordinateId).toMatch(/^repo:.+$/);
      expect(outcome.discoveredRepositoryPath).toBe("src/capacity.ts");
      expect(outcome.discoveryEvidenceId).toMatch(/^manual-discovery:sha256:[a-f0-9]{64}$/);
      expect(outcome.taskFrameId).not.toBeNull();
      expect(outcome.changeId).toBe("change.continuity-demo-capacity");

      // No repository edit is ever performed, so the honest initial verdict is not REALIZED.
      expect(outcome.initialReconciliation).not.toBeNull();
      expect(outcome.initialReconciliation!.terminalStatus).not.toBe("REALIZED");
      expect(outcome.initialReconciliation!.primaryReason).toBe("MISSING_PLANNED_EDIT");

      expect(outcome.capsuleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(outcome.gateAdmission).toBe("NOT_EVALUATED");
      expect(outcome.executionAuthority).toBe("none");
      expect(outcome.independentUserPilot).toBe("NOT_MEASURED");
      expect(outcome.explainBeforeMutation).toEqual({ status: "EXPLAINED", diffStatus: "APPLICABLE", diffClosedReason: "MATCH" });
      expect(outcome.explainAfterMutation).toEqual({ status: "EXPLAINED", diffStatus: "STALE", diffClosedReason: "CHANGED" });
      expect(outcome.resumeAfterMutation!.status).toBe("REFUSED");
      expect(outcome.resumeAfterMutation!.reasonCodes).toEqual(["HANDOFF_DIFF_STALE"]);

      expect(outcome.sourceBytesRestored).toBe(true);
      expect(outcome.sourceRestoreError).toBeNull();
      expect(outcome.capsuleBytesUnchangedAcrossMutation).toBe(true);

      expect(outcome.fixtureFiles.map((f) => f.relPath).sort()).toEqual(["package.json", "src/capacity.ts", "tsconfig.json"]);
      for (const file of outcome.fixtureFiles) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(join(outDir, "fixture", "src", "capacity.ts"))).toBe(true);
      expect(existsSync(join(outDir, "inputs", "capture.json"))).toBe(true);

      const commandLabels = outcome.commands.map((c) => c.label);
      expect(commandLabels).toEqual([
        "fixture-git-init",
        "init",
        "semantic-init",
        "change-open",
        "fixture-git-add",
        "fixture-git-commit",
        "fixture-git-rev-parse-head",
        "index",
        "inspect",
        "task-create",
        "control-frame-task",
        "control-plan-change",
        "control-reconcile-diff",
        "control-handoff-capture",
        "control-handoff-explain-before",
        "control-handoff-explain-after",
        "control-resume-handoff",
      ]);
      for (const command of outcome.commands) {
        expect(existsSync(join(outDir, command.stdoutFile))).toBe(true);
        expect(existsSync(join(outDir, command.stderrFile))).toBe(true);
        expect(command.cwd).toBe(join(outDir, "fixture"));
      }
      // Only the initial reconcile-diff and the final refused resume are expected to fail.
      const nonZero = outcome.commands.filter((c) => c.code !== 0).map((c) => c.label);
      expect(nonZero).toEqual(["control-reconcile-diff", "control-resume-handoff"]);

      expect(existsSync(join(outDir, MANIFEST_FILENAME))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8"));
      expect(manifest.kind).toBe("semctx-continuity-demo-manifest-v1");
      expect(manifest.status).toBe("COMPLETED");
      expect(existsSync(join(outDir, "report.md"))).toBe(true);
      const report = readFileSync(join(outDir, "report.md"), "utf8");
      expect(report).toContain("# semctx continuity demo");
      expect(report).toContain("COMPLETED");
      expect(report).toContain("NOT_MEASURED");
    },
    120_000,
  );

  it("blocks on a missing CLI artifact without writing any manifest", () => {
    const outDir = freshOut("missing-cli");
    const outcome = runContinuityDemo({ cliPath: join(scratch, "does-not-exist.js"), outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("CLI_ARTIFACT_MISSING");
    expect(outcome.commands).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses an existing, non-empty output destination", async () => {
    const cliPath = await packagedCli();
    const outDir = freshOut("existing");
    mkdirSync(outDir, { recursive: true });
    const outcome = runContinuityDemo({ cliPath, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("OUTPUT_EXISTS_NOT_EMPTY");
  });

  it("preserves existing output even with a forged manifest, or when empty", async () => {
    const cliPath = await packagedCli();
    for (const forged of [false, true]) {
      const outDir = freshOut("existing-forged");
      mkdirSync(outDir, { recursive: true });
      if (forged) writeFileSync(join(outDir, MANIFEST_FILENAME), JSON.stringify({ kind: "semctx-continuity-demo-manifest-v1" }));
      const sentinel = join(outDir, "sentinel");
      writeFileSync(sentinel, "keep");
      expect(runContinuityDemo({ cliPath, outDir }).status).toBe("BLOCKED");
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
    }
  });

  it("refuses a linked output destination and a linked ancestor", async () => {
    const cliPath = await packagedCli();
    const outside = freshOut("outside");
    mkdirSync(outside);
    const link = freshOut("link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    for (const outDir of [link, join(link, "new-output")]) {
      expect(runContinuityDemo({ cliPath, outDir }).reason).toBe("INVALID_OUTPUT_PATH");
    }
    expect(existsSync(join(outside, "new-output"))).toBe(false);
  });

  it("incomplete task identity output cannot complete", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "task-create", mutation: "task-id-only" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("incomplete-task") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("TASK_CREATE_CHILD_FAILED");
  }, 60_000);

  it("malformed framing output cannot complete", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "frame-task", mutation: "malformed-json" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("malformed-frame") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("FRAME_TASK_CHILD_FAILED");
  }, 60_000);

  it("a schema-valid reconciliation from another change set cannot complete", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "reconcile-diff", mutation: "wrong-reconcile-identity" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("wrong-reconcile-identity") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("RECONCILE_IDENTITY_MISMATCH");
  }, 60_000);

  it("a schema-valid capsule from another reconciliation cannot complete", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "capture", mutation: "wrong-capsule-reconciliation" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("wrong-capsule-reconciliation") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("CAPTURE_CHILD_FAILED");
  }, 60_000);

  it("an identity-correct realized verdict cannot hide the unperformed edit", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "reconcile-diff", mutation: "wrong-realized-verdict" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("wrong-realized-verdict") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("RECONCILE_VERDICT_UNEXPECTED");
  }, 120_000);

  it("a schema-valid explanation with another history cannot complete", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "explain", phase: "before", mutation: "wrong-historical-identity" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("wrong-history") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("EXPLAIN_CHILD_FAILED");
  }, 60_000);

  it("a final report write failure cannot leave a completed manifest", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "resume-handoff", mutation: "final-report-write-error" });
    const outDir = freshOut("final-report-write");
    let outcome: ReturnType<typeof runContinuityDemo> | undefined;
    let caught: unknown;
    try {
      outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    } catch (error) {
      caught = error;
    }
    const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8"));
    expect(manifest.status).toBe("BLOCKED");
    expect(manifest.reason).toBe("RUN_FAILED");
    expect(manifest.sourceBytesRestored).toBe(true);
    expect(manifest.capsuleBytesUnchangedAcrossMutation).toBe(true);
    expect(caught).toBeUndefined();
    expect(outcome?.status).toBe("BLOCKED");
  }, 60_000);

  it("a final manifest write failure retains a blocked report and outcome", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "resume-handoff", mutation: "final-manifest-write-error" });
    const outDir = freshOut("final-manifest-write");
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("RUN_FAILED");
    expect(outcome.sourceBytesRestored).toBe(true);
    expect(outcome.capsuleBytesUnchangedAcrossMutation).toBe(true);
    expect(readFileSync(join(outDir, "report.md"), "utf8")).toContain("Status: **BLOCKED** (RUN_FAILED)");
  }, 60_000);

  it("a thrown output write after mutation preserves final restoration facts", async () => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "explain", phase: "after", mutation: "raw-output-write-error" });
    const outDir = freshOut("thrown-output-write");
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("RUN_FAILED");
    expect(outcome.sourceBytesRestored).toBe(true);
    expect(outcome.capsuleBytesUnchangedAcrossMutation).toBe(true);
    expect(readFileSync(join(outDir, "fixture", "src", "capacity.ts"), "utf8"))
      .toBe("export function capacityRemaining(total: number, used: number): number {\n  return total - used;\n}\n");
    const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8"));
    expect(manifest.reason).toBe("RUN_FAILED");
    expect(manifest.sourceBytesRestored).toBe(true);
    expect(manifest.capsuleBytesUnchangedAcrossMutation).toBe(true);
  }, 60_000);

  it("an absent explain report cannot complete", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "explain", phase: "before", mutation: "report-null" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("explain-report-null") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("EXPLAIN_CHILD_FAILED");
  }, 60_000);

  it("a malformed explain result cannot complete", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "explain", phase: "before", mutation: "malformed-json" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("explain-malformed") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("EXPLAIN_CHILD_FAILED");
  }, 60_000);

  it.each([
    ["wrong-diff-refs", "EXPLAIN_DEPENDENCY_UNEXPECTED"],
    ["wrong-current-head", "EXPLAIN_CHILD_FAILED"],
    ["wrong-current-repository", "EXPLAIN_CHILD_FAILED"],
  ] as const)("an incoherent current explanation (%s) cannot complete", async (mutation, reason) => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "explain", phase: "after", mutation });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut(mutation) });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe(reason);
    expect(outcome.sourceBytesRestored).toBe(true);
  }, 60_000);

  it.each(["wrong-plan-delete", "wrong-plan-statement", "wrong-plan-rollback"] as const)("refuses a substituted planner request (%s)", async (mutation) => {
    const wrapper = wrapperCli(await packagedCli(), { targetCommand: "plan-change", mutation });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut(mutation) });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("PLAN_CHANGE_CHILD_FAILED");
    expect(outcome.commands.find(command => command.label === "control-plan-change")?.code).toBe(0);
    expect(outcome.commands.some(command => command.label === "control-reconcile-diff")).toBe(false);
  }, 120_000);

  it("a schema-valid but wrong-state explain result cannot complete", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "explain", phase: "before", mutation: "wrong-diff-status" });
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir: freshOut("explain-wrong-state") });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("EXPLAIN_DEPENDENCY_UNEXPECTED");
  }, 60_000);

  it(
    "a wrong resume reason cannot count as a stale refusal, and the mutated source is still restored",
    async () => {
      const realCli = await packagedCli();
      const wrapper = wrapperCli(realCli, { targetCommand: "resume-handoff", mutation: "wrong-resume-reason" });
      const outDir = freshOut("resume-wrong-reason");
      const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
      expect(outcome.status).toBe("BLOCKED");
      expect(outcome.reason).toBe("RESUME_NOT_REFUSED");
      // The block happens after the source mutation step: restoration must still be honest.
      expect(outcome.sourceBytesRestored).toBe(true);
      expect(readFileSync(join(outDir, "fixture", "src", "capacity.ts"), "utf8")).not.toContain("intentionally mutated");

      const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8"));
      expect(manifest.status).toBe("BLOCKED");
      expect(manifest.reason).toBe("RESUME_NOT_REFUSED");
      expect(manifest.sourceBytesRestored).toBe(true);
      const resumeCommand = outcome.commands.find((c) => c.label === "control-resume-handoff")!;
      expect(readFileSync(join(outDir, resumeCommand.stdoutFile), "utf8")).toContain("HANDOFF_HEAD_STALE");
    },
    60_000,
  );

  it(
    "capsule bytes tampered with during explain are detected as unchanged==false, "
      + "whatever later step the resulting corruption blocks on",
    async () => {
      const realCli = await packagedCli();
      const wrapper = wrapperCli(realCli, { targetCommand: "explain", phase: "after", mutation: "corrupt-capsule-bytes" });
      const outDir = freshOut("capsule-tampered-during-explain");
      const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
      // The real explain-after result was already observed and checked before the tamper landed.
      expect(outcome.explainAfterMutation).toEqual({ status: "EXPLAINED", diffStatus: "STALE", diffClosedReason: "CHANGED" });
      // Whether the corrupted-on-disk capsule later also breaks resume-handoff's own read is not
      // asserted here: the safety invariant this test proves is that the immutability check itself
      // never claims the bytes were unchanged, no matter what later blocks the run.
      expect(outcome.status).toBe("BLOCKED");
      expect(outcome.capsuleBytesUnchangedAcrossMutation).toBe(false);
    },
    60_000,
  );

  it("capsule bytes tampered with after the journey completes cannot pass as unchanged", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "resume-handoff", mutation: "corrupt-capsule-bytes" });
    const outDir = freshOut("capsule-tampered");
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("CAPSULE_BYTES_CHANGED");
    expect(outcome.capsuleBytesUnchangedAcrossMutation).toBe(false);
    // The real resume-handoff still ran and refused correctly before the tamper was recorded.
    expect(outcome.resumeAfterMutation).toEqual({ status: "REFUSED", reasonCodes: ["HANDOFF_DIFF_STALE"] });
    expect(outcome.sourceBytesRestored).toBe(true);
  }, 60_000);

  it("runtime artifact drift during execution refuses success, even after an otherwise-honest journey", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "index", mutation: "runtime-drift" });
    const outDir = freshOut("runtime-drift");
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("ARTIFACT_DRIFT");
    // The journey itself still ran honestly up to the drift check at the very end.
    expect(outcome.resumeAfterMutation).toEqual({ status: "REFUSED", reasonCodes: ["HANDOFF_DIFF_STALE"] });
    expect(outcome.sourceBytesRestored).toBe(true);
  }, 60_000);

  it("a linked source directory is never followed during restoration after a blocked mutation", async () => {
    const realCli = await packagedCli();
    const wrapper = wrapperCli(realCli, { targetCommand: "resume-handoff", mutation: "link-source-after-mutation" });
    const outDir = freshOut("linked-source-restore");
    const outcome = runContinuityDemo({ cliPath: wrapper, outDir });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reason).toBe("FIXTURE_LINK_REFUSED");
    expect(outcome.sourceBytesRestored).toBe(false);
    // The runner must never write through the link: the swapped-in directory keeps the mutated
    // (unrestored) bytes it had at the moment the link replaced the source directory.
    expect(readFileSync(join(outDir, "fixture", "src-elsewhere", "capacity.ts"), "utf8")).toContain("intentionally mutated");
  }, 60_000);
});
