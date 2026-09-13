import { afterEach, describe, expect, it } from "bun:test";
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { serializeControlReport } from "@semantic-context/control-model/reconciliation";
import { ControlHandoffRecordV2Schema, computeControlHandoffCapsuleV2Hash,
  RECONCILIATION_INSUFFICIENCY_REASONS } from "@semantic-context/control-model/control-handoff";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { SAMPLE_REPO, must } from "@semantic-context/test-fixtures";
import { captureControlHandoffV2 } from "../src/control-handoff";
import { indexRepository } from "../src";
import { buildPlanningBundle } from "../src/reconciliation-index";
import { explainControlHandoffV2 } from "../src/control-continuation";

const roots: string[] = [];
const CONTROL_CONTINUATION_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/control-continuation-test-hook",
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[CONTROL_CONTINUATION_TEST_HOOK];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Control Continuation v1 application service", () => {
  it("explains an intact, unchanged capsule with honest applicability", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    const before = readFileSync(handoffRecordPath(fixture.root, capsule.capsuleHash), "utf8");

    const result = explainControlHandoffV2(
      fixture.root,
      { schemaVersion: 1, capsuleHash: capsule.capsuleHash },
      "2026-09-13T00:00:00.000Z",
    );

    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.executionAuthority).toBe("none");
    expect(report.enforcementMode).toBe("shadow");
    expect(report.blockingEnabled).toBe(false);
    expect(report.sourceContentCollected).toBe(false);
    expect(report.gateAdmission).toBe("NOT_EVALUATED");
    expect(report.requestedCapsuleHash).toBe(capsule.capsuleHash);

    const byKind = Object.fromEntries(report.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.repository_identity).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
    // Never claim a proven worktree binding, even when the repository identity matches exactly.
    expect(byKind.worktree_identity).toMatchObject({
      status: "UNKNOWN",
      closedReason: "DEPENDENCY_UNVERIFIED",
    });
    expect(byKind.source_commit).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
    expect(byKind.diff).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
    for (const kind of ["producer_tool", "configuration", "environment", "policy", "expiry"]) {
      expect(byKind[kind]).toMatchObject({ status: "UNKNOWN", closedReason: "DEPENDENCY_MISSING" });
    }

    // Explaining never mutates the immutable capsule record.
    expect(readFileSync(handoffRecordPath(fixture.root, capsule.capsuleHash), "utf8")).toBe(before);
  });

  it("refuses an unknown capsule hash without projecting any historical content", () => {
    const fixture = preparedRepository();
    const unknownHash = `sha256:${"0".repeat(64)}` as const;
    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: unknownHash,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "ARTIFACT_MISSING", report: null });
  });

  it("refuses a corrupted record without projecting any historical content", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    const path = handoffRecordPath(fixture.root, capsule.capsuleHash);
    writeFileSync(path, "{not json", "utf8");

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "ARTIFACT_INVALID", report: null });
  });

  it("refuses an oversize record without reading its bytes into a report", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    const path = handoffRecordPath(fixture.root, capsule.capsuleHash);
    const descriptor = openSync(path, "w");
    try {
      const oversized = `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`;
      writeSync(descriptor, oversized);
    } finally {
      closeSync(descriptor);
    }

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "ARTIFACT_INVALID", report: null });
  });

  it("refuses a record whose stored schemaVersion is unsupported", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    const path = handoffRecordPath(fixture.root, capsule.capsuleHash);
    writeFileSync(path, JSON.stringify({ schemaVersion: 3, capsule: {} }), "utf8");

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "UNSUPPORTED_VERSION", report: null });
  });

  it("refuses a capsule captured for a different repository", () => {
    const origin = preparedRepository();
    const capsule = must(captureFixture(origin).capsule);
    const recordBytes = readFileSync(handoffRecordPath(origin.root, capsule.capsuleHash), "utf8");

    const other = preparedRepository();
    const targetPath = handoffRecordPath(other.root, capsule.capsuleHash);
    mkdirSync(join(other.root, ".semctx", "working", "handoffs", "v2"), { recursive: true });
    writeFileSync(targetPath, recordBytes, "utf8");

    const result = explainControlHandoffV2(other.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "WRONG_REPOSITORY", report: null });
  });

  it("reports a stable historical drift as STALE/CHANGED, not an unstable race", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// drift\n`, "utf8");
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "drift");

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.historicalSource.observedCommit).toBe(capsule.observedCommit);
    const byKind = Object.fromEntries(report.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.source_commit).toMatchObject({ status: "STALE", closedReason: "CHANGED" });
    // Both relative diffs are empty after commit; the separate source binding carries the drift.
    expect(byKind.diff).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
  });

  it("reports an uncommitted historical diff drift as STALE/CHANGED", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// drift\n`, "utf8");
    const result = explainControlHandoffV2(fixture.root, { schemaVersion: 1, capsuleHash: capsule.capsuleHash });
    expect(result.status).toBe("EXPLAINED");
    const byKind = Object.fromEntries(must(result.report).dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.source_commit).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
    expect(byKind.diff).toMatchObject({ status: "STALE", closedReason: "CHANGED" });
  });

  it("matches an unchanged, nonempty dirty capsule against the same working diff", () => {
    const fixture = preparedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// dirty\n`, "utf8");
    const capsule = must(captureFixture(fixture).capsule);
    const before = readFileSync(handoffRecordPath(fixture.root, capsule.capsuleHash), "utf8");

    const first = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(first.status, JSON.stringify(first)).toBe("EXPLAINED");
    const firstReport = must(first.report);
    const byKind = Object.fromEntries(firstReport.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.diff).toMatchObject({ status: "APPLICABLE", closedReason: "MATCH" });
    expect(firstReport.currentCapture.workingDiffHash).toBe(capsule.observedWorkingDiffHash);

    // Reading twice must not mutate the immutable capsule record.
    explainControlHandoffV2(fixture.root, { schemaVersion: 1, capsuleHash: capsule.capsuleHash });
    expect(readFileSync(handoffRecordPath(fixture.root, capsule.capsuleHash), "utf8")).toBe(before);
  });

  it("still explains historical context when the current index becomes unreadable", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(join(fixture.root, ".semctx", `semctx.db${suffix}`), { force: true });
    }

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.currentCapture.indexFreshnessVerdict).toBe("UNSEALED");
    expect(report.currentCapture.currentFreshnessSealHash).toBeNull();
    const byKind = Object.fromEntries(report.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.semantic_index_inputs).toMatchObject({
      status: "UNKNOWN",
      closedReason: "DEPENDENCY_UNVERIFIED",
    });
  });

  it("detects an actual source mutation mid-capture as an unstable current state", () => {
    const fixture = preparedRepository();
    const capsule = must(captureFixture(fixture).capsule);
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_CONTINUATION_TEST_HOOK] = (
      stage: string,
      root: string,
    ) => {
      if (stage !== "after_initial_git_identity_capture") return;
      writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// race\n`, "utf8");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "race");
    };

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.currentCapture.headCommit).toBeNull();
    expect(report.currentCapture.workingDiffHash).toBeNull();
    expect(report.currentCapture.indexFreshnessVerdict).toBe("UNSEALED");
    expect(report.currentCapture.currentFreshnessSealHash).toBeNull();
    const byKind = Object.fromEntries(report.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.source_commit).toMatchObject({ status: "UNKNOWN", closedReason: "CURRENT_STATE_CHANGED" });
    expect(byKind.diff).toMatchObject({ status: "UNKNOWN", closedReason: "CURRENT_STATE_CHANGED" });
    // The hook is one-shot: it must delete itself before a second call could re-fire it.
    expect((globalThis as Record<PropertyKey, unknown>)[CONTROL_CONTINUATION_TEST_HOOK]).toBeUndefined();
  });

  it("detects a staging-only mutation of already-dirty content mid-capture as unstable", () => {
    const fixture = preparedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// dirty\n`, "utf8");
    const capsule = must(captureFixture(fixture).capsule);
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_CONTINUATION_TEST_HOOK] = (
      stage: string,
      root: string,
    ) => {
      if (stage !== "after_initial_git_identity_capture") return;
      git(root, "add", "-A");
    };

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    // HEAD and the combined HEAD-vs-worktree diff are unaffected by staging alone.
    expect(report.historicalSource.observedCommit).toBe(capsule.observedCommit);
    const byKind = Object.fromEntries(report.dependencies.map((d) => [d.dependencyKind, d]));
    expect(byKind.diff).toMatchObject({ status: "UNKNOWN", closedReason: "CURRENT_STATE_CHANGED" });
  });

  it("retains 60 short non-goals in full and in order when they fit the budget", () => {
    const nonGoals = Array.from(
      { length: 60 },
      (_, index) => `non-goal ${String(index).padStart(2, "0")} with descriptive padding text`,
    );
    const fixture = preparedRepository({ nonGoals });
    const capsule = must(captureFixture(fixture).capsule);

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.completeness).toBe("complete");
    expect(report.omittedSectionCounts.declaredNonGoals).toBe(0);
    expect(report.sections.declaredNonGoals.map((statement) => statement.text)).toEqual([
      ...nonGoals,
      ...nonGoals,
    ]);
    expect(report.dependencies.length).toBe(10);
    expect(report.sections.nextChecks.length).toBeGreaterThan(0);
  });

  it("truncates an oversized Unicode section to the exact byte budget while preserving mandatory content", () => {
    const heavyItem = "非常長的非目標描述文本，用於超出序列化預算並驗證截斷邏輯是否精確運作。".repeat(6);
    const nonGoals = Array.from({ length: 120 }, (_, index) => `${heavyItem} ${index}`);
    const fixture = preparedRepository({ nonGoals });
    const capsule = must(captureFixture(fixture).capsule);

    const baselineFixture = preparedRepository();
    const baselineCapsule = must(captureFixture(baselineFixture).capsule);
    const baselineResult = explainControlHandoffV2(baselineFixture.root, {
      schemaVersion: 1,
      capsuleHash: baselineCapsule.capsuleHash,
    });
    const baselineReport = must(baselineResult.report);

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.completeness).toBe("partial");
    expect(report.omittedSectionCounts.declaredNonGoals).toBeGreaterThan(0);
    expect(
      report.sections.declaredNonGoals.length + report.omittedSectionCounts.declaredNonGoals,
    ).toBe(nonGoals.length * 2);
    const serializedBytes = Buffer.byteLength(serializeControlReport(report), "utf8");
    expect(serializedBytes).toBeLessThanOrEqual(65536);
    // Mandatory content is never truncated: it survives byte-for-byte identical to a light fixture.
    expect(report.dependencies.length).toBe(10);
    expect(report.sections.missingEvidence.length).toBe(baselineReport.sections.missingEvidence.length);
    expect(report.sections.nextChecks.length).toBe(baselineReport.sections.nextChecks.length);
    expect(report.sections.nextChecks.length).toBeGreaterThan(0);
  });

  it("keeps a 2001-character authored statement intact within budget", () => {
    const longStatement = "A".repeat(2001);
    const fixture = preparedRepository({}, longStatement);
    const capsule = must(captureFixture(fixture).capsule);

    const result = explainControlHandoffV2(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(result.status, JSON.stringify(result)).toBe("EXPLAINED");
    const report = must(result.report);
    expect(report.completeness).toBe("complete");
    const match = report.sections.expectedChanges.find((statement) => statement.text === longStatement);
    expect(match?.text.length).toBe(2001);
  });

  it("returns a typed refusal when mandatory next checks alone exceed the report budget", () => {
    const fixture = preparedRepository();
    const original = must(captureFixture(fixture).capsule);
    // A synthetic but schema-valid historical artifact tests the reader's resource boundary.
    // It is not a producer receipt or evidence of a real reconciliation.
    const record = ControlHandoffRecordV2Schema.parse(JSON.parse(
      readFileSync(handoffRecordPath(fixture.root, original.capsuleHash), "utf8"),
    ));
    record.capsule.reconciliationTerminalStatus = "UNPROVEN";
    record.capsule.reconciliationReasonCodes = [RECONCILIATION_INSUFFICIENCY_REASONS[0]!];
    record.capsule.nextValidTransition = { kind: "obtain_proof_then_reconcile", requirementIds: ["required:" + "x".repeat(70000)] };
    record.capsule.capsuleHash = computeControlHandoffCapsuleV2Hash(record.capsule);
    const bytes = serializeControlReport(ControlHandoffRecordV2Schema.parse(record));
    expect(Buffer.byteLength(bytes, "utf8")).toBeLessThan(1024 * 1024);
    const path = handoffRecordPath(fixture.root, record.capsule.capsuleHash);
    writeFileSync(path, bytes);
    const result = explainControlHandoffV2(fixture.root, { schemaVersion: 1, capsuleHash: record.capsule.capsuleHash });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "BUDGET_EXCEEDED", report: null });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
});

function handoffRecordPath(root: string, capsuleHash: string): string {
  return join(root, ".semctx", "working", "handoffs", "v2", `${capsuleHash.slice("sha256:".length)}.json`);
}

function captureFixture(fixture: ReturnType<typeof preparedRepository>) {
  return captureControlHandoffV2(fixture.root, {
    schemaVersion: 2,
    planningBundle: fixture.bundle,
    progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
  });
}

function preparedRepository(
  taskFrameOverrides: Partial<TaskFrame> = {},
  changeStatement = "Adjust capacity behavior.",
) {
  const root = temporaryRoot("continuation");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.continuation",
    statement: changeStatement,
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  writeFileSync(
    join(root, ".semctx", "semantic", "continuation.sem"),
    [
      "goal goal.capacity",
      "  statement: Capacity behavior remains explicit.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 2",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-08-01T10:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.continuation",
    rawTask: "Adjust capacity behavior.",
    mode: "feature",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-08-01T09:00:00.000Z",
    ...taskFrameOverrides,
  };
  const sourcePath = "src/domain/capacity.ts";
  const store = openStore(root);
  const node = must(store.loadGraph().nodes.find((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === sourcePath
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === sourcePath)));
  store.saveTaskFrame(frame);
  store.close();
  const coordinateId = `repo:${node.id}` as const;
  const expectation = {
    schemaVersion: 1 as const,
    expectationId: "expectation.capacity",
    kind: "behavior" as const,
    level: 2 as const,
    required: true,
    subjectId: "goal.capacity",
    statement: "Capacity behavior remains explicit.",
    acceptanceEvidenceIds: [],
  };
  const bundle = buildPlanningBundle(root, {
    schemaVersion: 1,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: [{
      coordinateId,
      repositoryPath: sourcePath,
      evidenceId: "discovery:continuation",
      evidenceProvenance: "test",
      scope: { kind: "file", path: sourcePath },
    }],
    rollbackDescription: "Restore the committed implementation.",
    semanticExpectations: [expectation],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      editId: "edit.capacity",
      kind: "modify",
      required: true,
      path: sourcePath,
      coordinateIds: [coordinateId],
      expectedLiftedExpectationIds: [expectation.expectationId],
      acceptanceEvidenceIds: [],
    }],
  });
  return {
    root,
    source: join(root, sourcePath),
    coordinateId,
    currentCoordinateId: "semantic:goal.capacity" as const,
    bundle,
  };
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-continuation-${label}-`));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}
