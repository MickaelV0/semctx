/**
 * The continuity demo runner (ADR 0027 / HOK-641). Runs the real packaged semctx CLI through a
 * disposable fixture repository to exercise task -> frame -> plan -> reconcile -> capture ->
 * explain -> stale -> refused-resume -> restore, and records raw evidence plus a JSON manifest.
 *
 * Every TaskFrame, envelope, PlanningBundle, reconciliation report and handoff capsule below is
 * produced by a real child-process invocation of the packaged CLI; none is fabricated here. The
 * goal and change contract authored into the fixture are example semantic content owned by this
 * demo only, never real-project intent. Control reports use the public control-model schemas;
 * task identity is checked against the task requested by this fixture and the resulting envelope.
 */

import { dirname, join, relative, resolve } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  ControlHandoffCaptureResultV2Schema,
  ControlHandoffRecordV2Schema,
  ControlHandoffResumeResultV2Schema,
  PlanningBundleV1Schema,
  ReconcileDiffReportV1Schema,
  Sha256HashSchema,
  TaskEnvelopeV1Schema,
  WorkspaceBaselineSnapshotV1Schema,
  type ControlHandoffCapsuleV2,
} from "@semantic-context/control-model";
import { ControlContinuationExplainResultV1Schema } from "../../packages/control-model/src/control-continuation-public";
import { identifyPackagedCli, sha256Hex, type PackagedCliIdentity } from "../first-use-demo/identity";
import { runGit, runPackagedCli, type ChildOutcome } from "../first-use-demo/process";
import { renderContinuityReport } from "./report";

export const MANIFEST_FILENAME = "continuity-demo-manifest.json";
export const MANIFEST_KIND = "semctx-continuity-demo-manifest-v1";

const GOAL_ID = "goal.continuity-demo-capacity";
const CHANGE_ID = "change.continuity-demo-capacity";
const EXPECTATION_ID = "expectation.continuity-demo-capacity";
const EDIT_ID = "edit.continuity-demo-capacity";
const GOAL_STATEMENT = "Capacity behavior remains explicit.";
const CHANGE_STATEMENT = "Adjust capacity behavior.";
const TASK_TEXT = "Adjust capacity behavior.";
const SOURCE_REL_PATH = "src/capacity.ts";
const DISCOVERY_SYMBOL = "capacityRemaining";

const PACKAGE_JSON = `{
  "name": "semctx-continuity-demo-fixture",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Disposable, fixture-authored repository for the semctx continuity demo (ADR 0027 / HOK-641)."
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
`;

const SOURCE_BASE = `export function capacityRemaining(total: number, used: number): number {
  return total - used;
}
`;

const GOAL_SEM = `goal ${GOAL_ID}
  statement: ${GOAL_STATEMENT}
  status: declared
  provenance: author
  appliesAtLevel: 2
`;

export type ContinuityBlockReason =
  | "CLI_ARTIFACT_MISSING"
  | "ARTIFACT_DRIFT"
  | "INVALID_OUTPUT_PATH"
  | "OUTPUT_EXISTS_NOT_EMPTY"
  | "FIXTURE_GIT_FAILED"
  | "FIXTURE_LINK_REFUSED"
  | "INIT_CHILD_FAILED"
  | "SEMANTIC_INIT_CHILD_FAILED"
  | "CHANGE_OPEN_CHILD_FAILED"
  | "INDEX_CHILD_FAILED"
  | "DISCOVERY_CHILD_FAILED"
  | "DISCOVERY_EMPTY"
  | "TASK_CREATE_CHILD_FAILED"
  | "FRAME_TASK_CHILD_FAILED"
  | "PLAN_CHANGE_CHILD_FAILED"
  | "RECONCILE_UNRECOGNIZABLE"
  | "RECONCILE_IDENTITY_MISMATCH"
  | "RECONCILE_VERDICT_UNEXPECTED"
  | "CAPTURE_CHILD_FAILED"
  | "CAPSULE_HASH_INVALID"
  | "CAPSULE_FILE_MISSING"
  | "EXPLAIN_CHILD_FAILED"
  | "EXPLAIN_DEPENDENCY_UNEXPECTED"
  | "RESUME_NOT_REFUSED"
  | "SOURCE_RESTORE_FAILED"
  | "RUN_FAILED"
  | "CAPSULE_BYTES_CHANGED";

export interface RecordedCommand {
  label: string;
  argv: readonly string[];
  cwd: string;
  code: number | null;
  signal: string | null;
  durationMs: number;
  stdoutFile: string;
  stdoutDigest: string;
  stderrFile: string;
  stderrDigest: string;
}

export interface FixtureFileRecord {
  relPath: string;
  sha256: string;
}

export interface ContinuityDemoOutcome {
  status: "COMPLETED" | "BLOCKED";
  reason: ContinuityBlockReason | null;
  detail: string | null;
  createdAt: string;
  outDir: string;
  cli: PackagedCliIdentity;
  fixtureHeadCommit: string | null;
  fixtureFiles: readonly FixtureFileRecord[];
  commands: RecordedCommand[];
  goalId: string;
  changeId: string | null;
  taskFrameId: string | null;
  discoveredCoordinateId: string | null;
  discoveredRepositoryPath: string | null;
  discoveryEvidenceId: string | null;
  /** The raw initial reconciliation, taken before any edit exists. Never relabeled as success. */
  initialReconciliation: { terminalStatus: string; primaryReason: string | null } | null;
  capsuleHash: string | null;
  /** Carried from the validated Control Continuation report; never fabricated. */
  gateAdmission: "NOT_EVALUATED" | null;
  /** Carried from the validated PlanningBundle; never fabricated. */
  executionAuthority: "none" | null;
  /** This demo never runs a human pilot; the claim is a fixed fact, not a measurement. */
  independentUserPilot: "NOT_MEASURED";
  explainBeforeMutation: { status: string; diffStatus: string | null; diffClosedReason: string | null } | null;
  explainAfterMutation: { status: string; diffStatus: string | null; diffClosedReason: string | null } | null;
  resumeAfterMutation: { status: string; reasonCodes: string[] } | null;
  sourceBytesRestored: boolean | null;
  sourceRestoreError: string | null;
  capsuleBytesUnchangedAcrossMutation: boolean | null;
}

export interface RunContinuityDemoOptions {
  cliPath: string;
  outDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

interface PreparedOutput {
  ok: boolean;
  reason?: ContinuityBlockReason;
  detail?: string;
}

/** Reserve a new destination without trusting a previous manifest as deletion authority. */
function prepareOutputDir(outDir: string): PreparedOutput {
  for (let cursor = outDir;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return { ok: false, reason: "INVALID_OUTPUT_PATH", detail: "Output and its ancestors must not be symbolic links or junctions." };
    if (cursor === outDir && stat !== undefined) return { ok: false, reason: "OUTPUT_EXISTS_NOT_EMPTY", detail: "Choose a new output directory; existing destinations are preserved." };
    if (cursor === dirname(cursor)) break;
  }
  try {
    mkdirSync(dirname(outDir), { recursive: true });
    mkdirSync(outDir);
    return { ok: true };
  } catch {
    return { ok: false, reason: "INVALID_OUTPUT_PATH", detail: "Could not create the new output directory." };
  }
}

/** Walk from `target` up to (and including) `root`, refusing the first symbolic link found. */
function firstSymlinkInPath(root: string, target: string): string | null {
  let cursor = target;
  for (;;) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return cursor;
    if (cursor === root) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function fixtureFileRecord(fixtureDir: string, absPath: string): FixtureFileRecord {
  return {
    relPath: relative(fixtureDir, absPath).replaceAll("\\", "/"),
    sha256: sha256Hex(readFileSync(absPath)),
  };
}

function writeRaw(outDir: string, name: string, content: string): { file: string; digest: string } {
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const path = join(rawDir, name);
  writeFileSync(path, content, "utf8");
  return { file: join("raw", name), digest: sha256Hex(readFileSync(path)) };
}

function recordCommand(outDir: string, label: string, outcome: ChildOutcome): RecordedCommand {
  const stdout = writeRaw(outDir, `${label}.stdout.txt`, outcome.stdout);
  const stderr = writeRaw(outDir, `${label}.stderr.txt`, outcome.stderr);
  return {
    label,
    argv: outcome.argv,
    cwd: outcome.cwd,
    code: outcome.code,
    signal: outcome.signal,
    durationMs: outcome.durationMs,
    stdoutFile: stdout.file,
    stdoutDigest: stdout.digest,
    stderrFile: stderr.file,
    stderrDigest: stderr.digest,
  };
}

function writeInput(inputsDir: string, name: string, value: unknown): string {
  const path = join(inputsDir, name);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

/** Write the rendered report next to the manifest. Only called once `outDir` is safe to write into. */
function finish(outcome: ContinuityDemoOutcome): ContinuityDemoOutcome {
  function recordFailure(artifact: string, error: unknown): void {
    outcome.status = "BLOCKED";
    outcome.reason ??= "RUN_FAILED";
    const detail = `${artifact} could not be written: ${error instanceof Error ? error.message : String(error)}`;
    outcome.detail = outcome.detail === null ? detail : `${outcome.detail} | ${detail}`;
  }

  const reportPath = join(outcome.outDir, "report.md");
  let reportWritten = false;
  try {
    writeFileSync(reportPath, renderContinuityReport(outcome), { encoding: "utf8", flag: "wx" });
    reportWritten = true;
  } catch (error) {
    recordFailure("Report", error);
  }
  try {
    writeFileSync(join(outcome.outDir, MANIFEST_FILENAME), `${JSON.stringify({ kind: MANIFEST_KIND, ...outcome }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    recordFailure("Manifest", error);
    if (reportWritten) {
      try {
        writeFileSync(reportPath, renderContinuityReport(outcome), "utf8");
      } catch (reportError) {
        recordFailure("Blocked report", reportError);
      }
    }
  }
  return outcome;
}

type ExplainCheck =
  | {
      ok: true;
      summary: { status: string; diffStatus: string | null; diffClosedReason: string | null };
      gateAdmission: "NOT_EVALUATED";
    }
  | { ok: false; reason: ContinuityBlockReason; detail: string };

/** Validate one `control handoff explain` result against its public schema and its expected diff state. */
function checkExplainResult(
  child: ChildOutcome,
  capsule: ControlHandoffCapsuleV2,
  expectedDiffStatus: "APPLICABLE" | "STALE",
  expectedDiffClosedReason: string,
): ExplainCheck {
  const json = parseJsonRecord(child.stdout);
  const parsed = json !== null ? ControlContinuationExplainResultV1Schema.safeParse(json) : null;
  if (child.code !== 0 || parsed === null || !parsed.success || parsed.data.status !== "EXPLAINED" || parsed.data.report === null) {
    return {
      ok: false,
      reason: "EXPLAIN_CHILD_FAILED",
      detail: `"semctx control handoff explain --json" did not return a valid EXPLAINED result (exit ${child.code}).`,
    };
  }
  const report = parsed.data.report;
  const history = report.historicalSource;
  if (report.requestedCapsuleHash !== capsule.capsuleHash
    || history.repositoryIdentity !== capsule.repositoryIdentity
    || history.observedCommit !== capsule.observedCommit
    || history.observedWorkingDiffHash !== capsule.observedWorkingDiffHash
    || history.planningCommit !== capsule.planningCommit
    || history.planningBundleHash !== capsule.planningBundleHash
    || history.envelopeHash !== capsule.envelopeHash
    || history.changeSetHash !== capsule.changeSetHash
    || history.baselineFreshnessSealHash !== capsule.seals.baselineFreshnessSeal) {
    return {
      ok: false,
      reason: "EXPLAIN_CHILD_FAILED",
      detail: "explain result does not preserve the captured capsule's historical identities.",
    };
  }
  const current = report.currentCapture;
  if (current.repositoryIdentity !== capsule.repositoryIdentity || current.headCommit !== capsule.observedCommit) {
    return { ok: false, reason: "EXPLAIN_CHILD_FAILED", detail: "explain current capture does not describe the same fixture repository and commit." };
  }
  const diffBindings = report.dependencies.filter((dependency) => dependency.dependencyKind === "diff"
    && dependency.obligation === "working_diff_binding" && dependency.scope === "repository");
  const diff = diffBindings.length === 1 ? diffBindings[0]! : null;
  const summary = { status: parsed.data.status, diffStatus: diff?.status ?? null, diffClosedReason: diff?.closedReason ?? null };
  if (diff === null || diff.status !== expectedDiffStatus || diff.closedReason !== expectedDiffClosedReason) {
    return {
      ok: false,
      reason: "EXPLAIN_DEPENDENCY_UNEXPECTED",
      detail: `expected diff dependency ${expectedDiffStatus}/${expectedDiffClosedReason}, observed `
        + `${diff?.status ?? "MISSING"}/${diff?.closedReason ?? "MISSING"}.`,
    };
  }
  if (diff.baselineRef !== capsule.observedWorkingDiffHash || current.workingDiffHash === null
    || diff.currentRef !== current.workingDiffHash
    || (expectedDiffStatus === "APPLICABLE") !== (current.workingDiffHash === capsule.observedWorkingDiffHash)) {
    return { ok: false, reason: "EXPLAIN_DEPENDENCY_UNEXPECTED", detail: "diff references do not preserve the captured and current working-tree identities or their expected relation." };
  }
  return { ok: true, summary, gateAdmission: report.gateAdmission };
}

export function runContinuityDemo(options: RunContinuityDemoOptions): ContinuityDemoOutcome {
  const createdAt = new Date().toISOString();
  const outDir = resolve(options.outDir);
  const cliPath = resolve(options.cliPath);
  const cli = identifyPackagedCli(cliPath);
  const commands: RecordedCommand[] = [];

  const outcome: ContinuityDemoOutcome = {
    status: "BLOCKED",
    reason: null,
    detail: null,
    createdAt,
    outDir,
    cli,
    fixtureHeadCommit: null,
    fixtureFiles: [],
    commands,
    goalId: GOAL_ID,
    changeId: null,
    taskFrameId: null,
    discoveredCoordinateId: null,
    discoveredRepositoryPath: null,
    discoveryEvidenceId: null,
    initialReconciliation: null,
    capsuleHash: null,
    gateAdmission: null,
    executionAuthority: null,
    independentUserPilot: "NOT_MEASURED",
    explainBeforeMutation: null,
    explainAfterMutation: null,
    resumeAfterMutation: null,
    sourceBytesRestored: null,
    sourceRestoreError: null,
    capsuleBytesUnchangedAcrossMutation: null,
  };

  // Before `outDir` is known safe to write into, an early block never touches the filesystem.
  function blockedEarly(reason: ContinuityBlockReason, detail: string): ContinuityDemoOutcome {
    outcome.status = "BLOCKED";
    outcome.reason = reason;
    outcome.detail = detail;
    return outcome;
  }

  if (!cli.cli.present) return blockedEarly("CLI_ARTIFACT_MISSING", `No file at "${cliPath}".`);

  const prepared = prepareOutputDir(outDir);
  if (!prepared.ok) return blockedEarly(prepared.reason!, prepared.detail!);

  // Fixture and JSON inputs live under the caller's own `--out` directory so they survive the
  // run for reproducibility and readback, instead of a global temp directory this demo deletes.
  const fixtureDir = join(outDir, "fixture");
  const inputsDir = join(outDir, "inputs");
  mkdirSync(fixtureDir);
  mkdirSync(inputsDir);
  const sourcePath = join(fixtureDir, SOURCE_REL_PATH);

  let originalSource: string | null = null;
  let sourceMutated = false;
  const capsuleObservation: { path: string | null; bytesBeforeMutation: Buffer | null } = {
    path: null,
    bytesBeforeMutation: null,
  };

  function block(reason: ContinuityBlockReason, detail: string): void {
    outcome.status = "BLOCKED";
    outcome.reason = reason;
    outcome.detail = detail;
  }

  /** Retain the earliest failure while still recording a later safety-invariant break. */
  function recordSafetyViolation(reason: ContinuityBlockReason, detail: string): void {
    if (outcome.reason === null) {
      outcome.status = "BLOCKED";
      outcome.reason = reason;
      outcome.detail = detail;
      return;
    }
    outcome.detail = outcome.detail === null ? detail : `${outcome.detail} | ${detail}`;
  }

  function refuseIfLinked(target: string): boolean {
    const linked = firstSymlinkInPath(fixtureDir, target);
    if (linked === null) return false;
    block("FIXTURE_LINK_REFUSED", `refusing a symbolic link on the fixture path: "${linked}".`);
    return true;
  }

  function step(): void {
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(join(fixtureDir, "package.json"), PACKAGE_JSON, "utf8");
    writeFileSync(join(fixtureDir, "tsconfig.json"), TSCONFIG_JSON, "utf8");
    writeFileSync(sourcePath, SOURCE_BASE, "utf8");
    outcome.fixtureFiles = [join(fixtureDir, "package.json"), join(fixtureDir, "tsconfig.json"), sourcePath]
      .map((path) => fixtureFileRecord(fixtureDir, path));

    const gitInit = runGit(["init", "-q"], fixtureDir);
    commands.push(recordCommand(outDir, "fixture-git-init", gitInit));
    if (gitInit.code !== 0) return block("FIXTURE_GIT_FAILED", `git init failed: ${gitInit.stderr.trim()}`);

    const init = runPackagedCli(cliPath, ["init", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "init", init));
    if (init.code !== 0) return block("INIT_CHILD_FAILED", `"semctx init --json" exited ${init.code}.`);

    const semanticInit = runPackagedCli(cliPath, ["semantic", "init", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "semantic-init", semanticInit));
    if (semanticInit.code !== 0) return block("SEMANTIC_INIT_CHILD_FAILED", `"semctx semantic init --json" exited ${semanticInit.code}.`);

    // Fixture-authored example semantic content, materialized directly: there is no CLI
    // subcommand that authors a goal, and this is not real-project intent.
    const semanticDir = join(fixtureDir, ".semctx", "semantic");
    if (refuseIfLinked(semanticDir)) return;
    mkdirSync(semanticDir, { recursive: true });
    writeFileSync(join(semanticDir, "continuity-demo.sem"), GOAL_SEM, "utf8");

    const changeOpen = runPackagedCli(
      cliPath,
      ["change", "open", CHANGE_ID, "--statement", CHANGE_STATEMENT, "--draft", "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "change-open", changeOpen));
    if (changeOpen.code !== 0) return block("CHANGE_OPEN_CHILD_FAILED", `"semctx change open --json" exited ${changeOpen.code}.`);
    outcome.changeId = CHANGE_ID;

    const gitAdd = runGit(["add", "-A"], fixtureDir);
    commands.push(recordCommand(outDir, "fixture-git-add", gitAdd));
    if (gitAdd.code !== 0) return block("FIXTURE_GIT_FAILED", `git add failed: ${gitAdd.stderr.trim()}`);
    const gitCommit = runGit(
      ["-c", "user.name=Semctx Continuity Demo", "-c", "user.email=semctx-continuity-demo@example.invalid", "commit", "-q", "-m", "base fixture"],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "fixture-git-commit", gitCommit));
    if (gitCommit.code !== 0) return block("FIXTURE_GIT_FAILED", `git commit failed: ${gitCommit.stderr.trim()}`);
    const headCommit = runGit(["rev-parse", "HEAD"], fixtureDir);
    commands.push(recordCommand(outDir, "fixture-git-rev-parse-head", headCommit));
    const fixtureHeadCommit = headCommit.stdout.trim();
    if (headCommit.code !== 0 || !/^[0-9a-f]{40}$/.test(fixtureHeadCommit)) {
      return block("FIXTURE_GIT_FAILED", "Could not record the fixture repository's complete Git HEAD identity.");
    }
    outcome.fixtureHeadCommit = fixtureHeadCommit;

    const index = runPackagedCli(cliPath, ["index", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "index", index));
    const indexJson = parseJsonRecord(index.stdout);
    if (index.code !== 0 || indexJson?.["indexed"] !== true) {
      return block("INDEX_CHILD_FAILED", `"semctx index --json" did not report indexed:true (exit ${index.code}).`);
    }

    const inspect = runPackagedCli(cliPath, ["inspect", "symbol", DISCOVERY_SYMBOL, "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "inspect", inspect));
    if (inspect.code !== 0) return block("DISCOVERY_CHILD_FAILED", `"semctx inspect symbol ${DISCOVERY_SYMBOL} --json" exited ${inspect.code}.`);
    const inspectJson = parseJsonRecord(inspect.stdout);
    const matchedNodes = inspectJson !== null && Array.isArray(inspectJson["matchedNodes"]) ? inspectJson["matchedNodes"] : [];
    const node = matchedNodes
      .map(asRecord)
      .find((candidate): candidate is Record<string, unknown> =>
        candidate !== null
        && typeof candidate["id"] === "string"
        && typeof candidate["filePath"] === "string"
        && (candidate["filePath"] as string).replaceAll("\\", "/") === SOURCE_REL_PATH);
    if (node === undefined) return block("DISCOVERY_EMPTY", `no matched node for symbol "${DISCOVERY_SYMBOL}" bound to "${SOURCE_REL_PATH}".`);
    const coordinateId = `repo:${node["id"] as string}`;
    const repositoryPath = (node["filePath"] as string).replaceAll("\\", "/");
    const evidenceId = `manual-discovery:sha256:${sha256Hex(inspect.stdout)}`;
    outcome.discoveredCoordinateId = coordinateId;
    outcome.discoveredRepositoryPath = repositoryPath;
    outcome.discoveryEvidenceId = evidenceId;

    const taskCreate = runPackagedCli(
      cliPath,
      ["task", "create", "--text", TASK_TEXT, "--mode", "feature", "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "task-create", taskCreate));
    const taskJson = parseJsonRecord(taskCreate.stdout);
    const taskFrameId = taskJson !== null && typeof taskJson["id"] === "string" ? taskJson["id"] : null;
    if (taskCreate.code !== 0 || taskFrameId === null || taskFrameId.trim().length === 0
      || taskJson?.["rawTask"] !== TASK_TEXT || taskJson["mode"] !== "feature"
      || typeof taskJson["createdAt"] !== "string") {
      return block("TASK_CREATE_CHILD_FAILED", `"semctx task create --json" did not return the requested task identity (exit ${taskCreate.code}).`);
    }
    outcome.taskFrameId = taskFrameId;

    const discovery = {
      coordinateId,
      repositoryPath,
      evidenceId,
      evidenceProvenance: "manual_discovery" as const,
      scope: { kind: "file" as const, path: repositoryPath },
    };

    const framingFile = writeInput(inputsDir, "framing.json", { explicitDiscoveries: [discovery] });
    const frameTask = runPackagedCli(
      cliPath,
      ["control", "frame-task", CHANGE_ID, "--task-id", taskFrameId, "--input", framingFile, "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "control-frame-task", frameTask));
    const framing = parseJsonRecord(frameTask.stdout);
    const frameParsed = TaskEnvelopeV1Schema.safeParse(framing?.["envelope"]);
    const framedBaseline = WorkspaceBaselineSnapshotV1Schema.safeParse(framing?.["baseline"]);
    if (frameTask.code !== 0 || framing?.["schemaVersion"] !== 1
      || framing["kind"] !== "prepared_task_envelope" || framing["certifying"] !== false
      || Object.keys(framing).length !== 5 || !frameParsed.success || !framedBaseline.success
      || frameParsed.data.taskFrameSnapshot.taskFrameId !== taskFrameId
      || frameParsed.data.taskFrameSnapshot.rawTaskDigest !== `sha256:${sha256Hex(TASK_TEXT)}`
      || frameParsed.data.taskFrameSnapshot.mode !== taskJson["mode"]
      || frameParsed.data.taskFrameSnapshot.createdAt !== taskJson["createdAt"]
      || frameParsed.data.changeId !== CHANGE_ID
      || !frameParsed.data.resolvedBindings.some(binding => binding.coordinateId === coordinateId
        && binding.repositoryPath === repositoryPath && binding.evidenceId === evidenceId)) {
      return block("FRAME_TASK_CHILD_FAILED", `"semctx control frame-task --json" did not bind the same task and discovered source (exit ${frameTask.code}).`);
    }

    const progressPointer = { state: "not_started" as const, currentCoordinateId: `semantic:${GOAL_ID}` };
    const plannerInput = {
      explicitDiscoveries: [discovery],
      rollbackDescription: "Restore the committed implementation.",
      semanticExpectations: [{
        schemaVersion: 1,
        expectationId: EXPECTATION_ID,
        kind: "behavior",
        level: 2,
        required: true,
        subjectId: GOAL_ID,
        statement: GOAL_STATEMENT,
        acceptanceEvidenceIds: [],
      }],
      repositoryEditExpectations: [{
        schemaVersion: 1,
        editId: EDIT_ID,
        kind: "modify",
        required: true,
        path: repositoryPath,
        coordinateIds: [coordinateId],
        expectedLiftedExpectationIds: [EXPECTATION_ID],
        acceptanceEvidenceIds: [],
      }],
    };
    const plannerFile = writeInput(inputsDir, "planner.json", plannerInput);
    const planChange = runPackagedCli(
      cliPath,
      ["control", "plan-change", CHANGE_ID, "--task-id", taskFrameId, "--input", plannerFile, "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "control-plan-change", planChange));
    const planChangeJson = parseJsonRecord(planChange.stdout);
    const planChangeParsed = planChangeJson !== null ? PlanningBundleV1Schema.safeParse(planChangeJson) : null;
    if (planChange.code !== 0 || planChangeParsed === null || !planChangeParsed.success) {
      return block("PLAN_CHANGE_CHILD_FAILED", `"semctx control plan-change --json" did not return a valid PlanningBundleV1 (exit ${planChange.code}).`);
    }
    const bundle = planChangeParsed.data;
    if (bundle.taskEnvelope.envelopeHash !== frameParsed.data.envelopeHash
      || JSON.stringify(bundle.baseline) !== JSON.stringify(framedBaseline.data)) {
      return block("PLAN_CHANGE_CHILD_FAILED", "The planning bundle did not preserve the observed task envelope.");
    }
    if (!isDeepStrictEqual(bundle.semanticChangeSet.semanticExpectations, plannerInput.semanticExpectations)
      || !isDeepStrictEqual(bundle.semanticChangeSet.repositoryEditExpectations, plannerInput.repositoryEditExpectations)
      || bundle.semanticChangeSet.rollbackDescription !== plannerInput.rollbackDescription) {
      return block("PLAN_CHANGE_CHILD_FAILED", "The planning bundle did not preserve the authored expectations and rollback.");
    }
    outcome.executionAuthority = bundle.executionAuthority;

    const reconcileFile = writeInput(inputsDir, "reconcile.json", { schemaVersion: 1, planningBundle: bundle });
    const reconcile = runPackagedCli(cliPath, ["control", "reconcile-diff", reconcileFile, "--json", "--root", fixtureDir], fixtureDir);
    commands.push(recordCommand(outDir, "control-reconcile-diff", reconcile));
    const reconcileJson = parseJsonRecord(reconcile.stdout);
    const reconcileParsed = reconcileJson !== null ? ReconcileDiffReportV1Schema.safeParse(reconcileJson) : null;
    if (reconcileParsed === null || !reconcileParsed.success) {
      return block("RECONCILE_UNRECOGNIZABLE", `"semctx control reconcile-diff --json" did not return a valid ReconcileDiffReportV1 (exit ${reconcile.code}).`);
    }
    const reconcileReport = reconcileParsed.data;
    if (reconcileReport.changeSetId !== bundle.semanticChangeSet.changeSetId
      || reconcileReport.changeSetHash !== bundle.semanticChangeSet.changeSetHash
      || reconcileReport.envelopeId !== bundle.taskEnvelope.envelopeId
      || reconcileReport.envelopeHash !== bundle.taskEnvelope.envelopeHash
      || reconcileReport.planningCommit !== bundle.planningCommit
      || reconcileReport.observedCommit !== fixtureHeadCommit
      || reconcileReport.baselineSealHash !== bundle.baseline.freshnessSealHash) {
      return block("RECONCILE_IDENTITY_MISMATCH", "The reconciliation did not preserve the submitted plan and observed fixture identities.");
    }
    if (reconcile.code !== (reconcileReport.terminalStatus === "REALIZED" ? 0 : 3)) {
      return block(
        "RECONCILE_UNRECOGNIZABLE",
        `"semctx control reconcile-diff --json" exit code did not match its terminalStatus `
          + `(exit ${reconcile.code}, terminalStatus ${reconcileReport.terminalStatus}).`,
      );
    }
    // Record the actual verdict before checking the fixture's deliberately unperformed edit.
    outcome.initialReconciliation = { terminalStatus: reconcileReport.terminalStatus, primaryReason: reconcileReport.primaryReason };
    if (reconcileReport.terminalStatus !== "VIOLATED" || reconcileReport.primaryReason !== "MISSING_PLANNED_EDIT"
      || reconcileReport.requiredPlannedEditIds.length !== 1 || reconcileReport.requiredPlannedEditIds[0] !== EDIT_ID
      || reconcileReport.missingPlannedEditIds.length !== 1 || reconcileReport.missingPlannedEditIds[0] !== EDIT_ID) {
      return block("RECONCILE_VERDICT_UNEXPECTED", "The initial reconciliation must report the fixture's unperformed edit as missing.");
    }

    const captureFile = writeInput(inputsDir, "capture.json", {
      schemaVersion: 2,
      planningBundle: bundle,
      progress: progressPointer,
    });
    const capture = runPackagedCli(cliPath, ["control", "handoff", captureFile, "--json", "--root", fixtureDir], fixtureDir);
    commands.push(recordCommand(outDir, "control-handoff-capture", capture));
    const captureJson = parseJsonRecord(capture.stdout);
    const captureParsed = captureJson !== null ? ControlHandoffCaptureResultV2Schema.safeParse(captureJson) : null;
    if (
      capture.code !== 0
      || captureParsed === null
      || !captureParsed.success
      || captureParsed.data.status !== "CAPTURED"
      || captureParsed.data.capsule === null
    ) {
      return block("CAPTURE_CHILD_FAILED", `"semctx control handoff --json" did not capture a valid capsule (exit ${capture.code}).`);
    }
    const capsule = captureParsed.data.capsule;
    // Never trust a caller-invented shape: the capsule must actually continue the real
    // task/plan/change identity chain, checked through the public record schema itself.
    const recordParsed = ControlHandoffRecordV2Schema.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_record",
      request: { schemaVersion: 2, planningBundle: bundle, progress: progressPointer },
      capsule,
    });
    if (!recordParsed.success) {
      return block("CAPTURE_CHILD_FAILED", "the captured capsule's identity does not continue the real task/plan/change chain.");
    }
    if (capsule.seals.reconciliationReportHash !== reconcileReport.reportHash
      || capsule.observedCommit !== reconcileReport.observedCommit
      || capsule.seals.observationAnalysisHash !== (reconcileReport.observationAnalysis?.analysisHash ?? null)
      || capsule.reconciliationTerminalStatus !== reconcileReport.terminalStatus
      || JSON.stringify(capsule.reconciliationReasonCodes) !== JSON.stringify(reconcileReport.reasonCodes)) {
      return block("CAPTURE_CHILD_FAILED", "the capsule does not preserve the observed reconciliation report and verdict.");
    }
    outcome.capsuleHash = capsule.capsuleHash;

    if (!Sha256HashSchema.safeParse(capsule.capsuleHash).success) {
      return block("CAPSULE_HASH_INVALID", `captured capsule hash is not a well-formed sha256 digest: "${capsule.capsuleHash}".`);
    }
    const resolvedCapsulePath = join(fixtureDir, ".semctx", "working", "handoffs", "v2", `${capsule.capsuleHash.slice("sha256:".length)}.json`);
    capsuleObservation.path = resolvedCapsulePath;
    if (refuseIfLinked(resolvedCapsulePath)) return;
    try {
      capsuleObservation.bytesBeforeMutation = readFileSync(resolvedCapsulePath);
    } catch {
      return block("CAPSULE_FILE_MISSING", `expected an immutable capsule record at "${resolvedCapsulePath}".`);
    }

    const explainBefore = runPackagedCli(
      cliPath,
      ["control", "handoff", "explain", "--hash", capsule.capsuleHash, "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "control-handoff-explain-before", explainBefore));
    const explainBeforeChecked = checkExplainResult(explainBefore, capsule, "APPLICABLE", "MATCH");
    if (!explainBeforeChecked.ok) return block(explainBeforeChecked.reason, explainBeforeChecked.detail);
    outcome.explainBeforeMutation = explainBeforeChecked.summary;
    outcome.gateAdmission = explainBeforeChecked.gateAdmission;

    if (refuseIfLinked(sourcePath)) return;
    originalSource = readFileSync(sourcePath, "utf8");
    sourceMutated = true;
    writeFileSync(sourcePath, `${originalSource}\n// continuity-demo: intentionally mutated to demonstrate staleness detection\n`, "utf8");

    const explainAfter = runPackagedCli(
      cliPath,
      ["control", "handoff", "explain", "--hash", capsule.capsuleHash, "--json", "--root", fixtureDir],
      fixtureDir,
    );
    commands.push(recordCommand(outDir, "control-handoff-explain-after", explainAfter));
    const explainAfterChecked = checkExplainResult(explainAfter, capsule, "STALE", "CHANGED");
    if (!explainAfterChecked.ok) return block(explainAfterChecked.reason, explainAfterChecked.detail);
    outcome.explainAfterMutation = explainAfterChecked.summary;

    const resume = runPackagedCli(cliPath, ["control", "resume-handoff", capsule.capsuleHash, "--json", "--root", fixtureDir], fixtureDir);
    commands.push(recordCommand(outDir, "control-resume-handoff", resume));
    const resumeJson = parseJsonRecord(resume.stdout);
    const resumeParsed = resumeJson !== null ? ControlHandoffResumeResultV2Schema.safeParse(resumeJson) : null;
    if (
      resume.code !== 3
      || resumeParsed === null
      || !resumeParsed.success
      || resumeParsed.data.status !== "REFUSED"
      || resumeParsed.data.capsule !== null
      || resumeParsed.data.planningBundle !== null
      || resumeParsed.data.reasonCodes.length !== 1
      || resumeParsed.data.reasonCodes[0] !== "HANDOFF_DIFF_STALE"
    ) {
      return block(
        "RESUME_NOT_REFUSED",
        `"semctx control resume-handoff --json" did not refuse the stale capsule with exactly HANDOFF_DIFF_STALE (exit ${resume.code}).`,
      );
    }
    outcome.resumeAfterMutation = { status: resumeParsed.data.status, reasonCodes: [...resumeParsed.data.reasonCodes] };

    if (refuseIfLinked(sourcePath)) return;
    writeFileSync(sourcePath, originalSource, "utf8");
    outcome.sourceBytesRestored = readFileSync(sourcePath, "utf8") === originalSource;
    if (!outcome.sourceBytesRestored) return block("SOURCE_RESTORE_FAILED", "Restored source bytes did not match the original committed content.");
    sourceMutated = false;

    outcome.status = "COMPLETED";
  }

  try {
    step();
  } catch (error) {
    recordSafetyViolation("RUN_FAILED", `Journey failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Restoration facts are decided here, before any manifest or report is written, so a block
    // that occurs after the source was mutated (e.g. a refused resume) never loses whether the
    // fixture's real source bytes were actually put back.
    if (sourceMutated && originalSource !== null) {
      try {
        const linked = firstSymlinkInPath(fixtureDir, sourcePath);
        if (linked !== null) {
          outcome.sourceBytesRestored = false;
          outcome.sourceRestoreError = `refusing to restore through a symbolic link: "${linked}".`;
          recordSafetyViolation("FIXTURE_LINK_REFUSED", outcome.sourceRestoreError);
        } else {
          writeFileSync(sourcePath, originalSource, "utf8");
          const restored = readFileSync(sourcePath, "utf8") === originalSource;
          outcome.sourceBytesRestored = restored;
          if (!restored) {
            outcome.sourceRestoreError = "restored source bytes did not match the original committed content";
            recordSafetyViolation("SOURCE_RESTORE_FAILED", outcome.sourceRestoreError);
          }
        }
      } catch (error) {
        outcome.sourceBytesRestored = false;
        outcome.sourceRestoreError = `source restore failed: ${error instanceof Error ? error.message : String(error)}`;
        recordSafetyViolation("SOURCE_RESTORE_FAILED", outcome.sourceRestoreError);
      }
    }
  }

  // Capsule immutability and runtime-artifact identity are safety invariants of the whole run,
  // not journey steps: they are checked and recorded regardless of which reason blocked the run,
  // so an earlier block never hides a later corruption.
  if (capsuleObservation.path !== null && capsuleObservation.bytesBeforeMutation !== null) {
    const bytesBeforeMutation = capsuleObservation.bytesBeforeMutation;
    let linked: string | null = null;
    let capsuleBytesAfter: Buffer | null = null;
    try {
      linked = firstSymlinkInPath(fixtureDir, capsuleObservation.path);
      if (linked === null) {
        capsuleBytesAfter = readFileSync(capsuleObservation.path);
      }
    } catch {
      capsuleBytesAfter = null;
    }
    outcome.capsuleBytesUnchangedAcrossMutation = linked === null && capsuleBytesAfter !== null && bytesBeforeMutation.equals(capsuleBytesAfter);
    if (!outcome.capsuleBytesUnchangedAcrossMutation) {
      recordSafetyViolation(
        "CAPSULE_BYTES_CHANGED",
        linked !== null
          ? `refusing a symbolic link on the capsule path: "${linked}".`
          : "The immutable capsule record's bytes changed across explain/mutate/resume.",
      );
    }
  }

  try {
    if (identifyPackagedCli(cliPath).runtimeDigest !== cli.runtimeDigest) {
      recordSafetyViolation("ARTIFACT_DRIFT", "Runtime bytes changed during execution.");
    }
  } catch (error) {
    recordSafetyViolation("ARTIFACT_DRIFT", `Runtime identity could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  return finish(outcome);
}
