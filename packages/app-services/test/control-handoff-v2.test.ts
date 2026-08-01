import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import {
  PlanningBundleV1Schema,
  SemanticChangeSetV1Schema,
  computePlanningBundleV1Hash,
  computeSemanticChangeSetV1Hash,
  sha256HashCanonicalJson,
  type PlanningBundleV1,
  type SemanticChangeSetV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";
import {
  classifyControlHandoffRefinementStepV2,
  computeControlHandoffDescriptiveRefinementStepIdsV2,
} from "@semantic-context/control-model/control-handoff";
import {
  initSemanticScaffold,
  newChangeContract,
  writeChangeFile,
} from "@semantic-context/semantic-engine";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { SAMPLE_REPO, must } from "@semantic-context/test-fixtures";
import {
  captureControlHandoffV2,
  resumeControlHandoffV2,
} from "../src/control-handoff";
import {
  indexRepository,
} from "../src";
import {
  buildPlanningBundle,
  reconcileWorkingTreeDetailed,
} from "../src/reconciliation-index";

const roots: string[] = [];
const CONTROL_HANDOFF_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/control-handoff-test-hook",
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[CONTROL_HANDOFF_TEST_HOOK];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Control Handoff v2 application service", () => {
  it("is a write-free no-op outside Semctx and refuses marker-only repositories", () => {
    const plain = temporaryRoot("plain");
    expect(captureControlHandoffV2(plain, {})).toEqual({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "NO_OP",
      reasonCodes: ["NON_SEMCTX_REPOSITORY"],
      capsule: null,
    });
    expect(existsSync(join(plain, ".semctx"))).toBe(false);

    const markerOnly = temporaryRoot("marker");
    mkdirSync(join(markerOnly, ".semctx", "semantic"), { recursive: true });
    expect(captureControlHandoffV2(markerOnly, {})).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["SEMCTX_REPOSITORY_UNREADY"],
      capsule: null,
    });
  });

  it("captures deterministically, persists by hash, and remains idempotent beside v1", () => {
    const fixture = preparedRepository();
    const legacy = join(fixture.root, ".semctx", "working", "handoff.json");
    mkdirSync(join(fixture.root, ".semctx", "working"), { recursive: true });
    writeFileSync(legacy, "{\"version\":1}\n", "utf8");
    const legacyBefore = readFileSync(legacy, "utf8");
    const request = {
      schemaVersion: 2 as const,
      planningBundle: fixture.bundle,
      progress: { state: "not_started" as const, currentCoordinateId: fixture.currentCoordinateId },
    };

    const first = captureControlHandoffV2(fixture.root, request);
    const second = captureControlHandoffV2(fixture.root, request);
    expect(first.status, JSON.stringify(first)).toBe("CAPTURED");
    expect(second).toEqual(first);
    expect(first.capsule?.executionAuthority).toBe("none");
    expect(first.capsule?.sourceContentCollected).toBe(false);
    expect(first.capsule?.nextValidTransition.kind).toBe("refinement_step");
    const hash = must(first.capsule).capsuleHash.slice("sha256:".length);
    expect(existsSync(join(
      fixture.root,
      ".semctx",
      "working",
      "handoffs",
      "v2",
      `${hash}.json`,
    ))).toBe(true);
    expect(readFileSync(legacy, "utf8")).toBe(legacyBefore);
  });

  it("accepts only machine-proven completed progress and derives its receipt", () => {
    const fixture = completedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const result = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: {
        state: "step_completed",
        completedRefinementStepId: fixture.stepId,
        currentCoordinateId: fixture.currentCoordinateId,
      },
    });

    expect(result.status, JSON.stringify(result)).toBe("CAPTURED");
    expect(result.capsule?.reconciliationTerminalStatus).toBe("REALIZED");
    expect(result.capsule?.progress).toMatchObject({
      state: "step_completed",
      currentCoordinateId: fixture.currentCoordinateId,
      currentAbstractionLevel: 2,
      matchedRepositoryEditIds: [fixture.editId],
      certifiedExpectationIds: [fixture.expectationId],
      satisfiedEvidenceRequirementIds: [fixture.editEvidenceId, fixture.evidenceId].sort(),
    });
    expect(result.capsule?.proofsObtained.filter((proof) =>
      [fixture.editEvidenceId, fixture.evidenceId].includes(proof.requirementId)
      && proof.result === "satisfied"
    ).map((proof) => proof.requirementId).sort()).toEqual(
      [fixture.editEvidenceId, fixture.evidenceId].sort(),
    );
    expect(result.capsule?.nextValidTransition).toMatchObject({ kind: "refinement_step" });
  });

  it("completes a canonical edit-only local patch across explicit descriptive phases", () => {
    const fixture = editOnlyLocalPatchRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const snapshot = reconcileWorkingTreeDetailed(fixture.root, {
      schemaVersion: 1,
      planningBundle: fixture.bundle,
    });
    const claimedStep = must(fixture.bundle.semanticChangeSet.refinementSteps.find((step) =>
      step.repositoryEditIds.includes(fixture.editId)));
    expect(classifyControlHandoffRefinementStepV2(
      fixture.bundle.semanticChangeSet,
      claimedStep,
    )).toBe("proof_bearing");
    const claimedHunkIds = new Set(snapshot.report.matchedPlannedEdits
      .filter((match) => claimedStep.repositoryEditIds.includes(match.editId))
      .flatMap((match) => match.observedHunkIds));
    const claimedBindings = snapshot.sealedAnalysis.hunkBindings
      .filter((binding) => claimedHunkIds.has(binding.hunkId))
      .flatMap((binding) => binding.coordinateIds);
    const candidateCoordinates = [...claimedHunkIds, ...claimedBindings];
    const currentCoordinateId = must(candidateCoordinates.find((coordinateId) =>
      snapshot.candidateGraph.nodes.some((node) =>
        node.id === coordinateId && node.appliesAtLevel !== null)));
    expect(currentCoordinateId.startsWith("sha256:")).toBe(true);
    expect(claimedHunkIds.has(currentCoordinateId as Sha256Hash)).toBe(true);

    const result = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: {
        state: "step_completed",
        completedRefinementStepId: claimedStep.stepId,
        currentCoordinateId,
      },
    });

    expect(result.status, JSON.stringify(result)).toBe("CAPTURED");
    const capsule = must(result.capsule);
    const descriptiveRefinementStepIds =
      computeControlHandoffDescriptiveRefinementStepIdsV2(fixture.bundle.semanticChangeSet);
    expect(descriptiveRefinementStepIds.length).toBeGreaterThan(0);
    expect(capsule.descriptiveRefinementStepIds).toEqual(descriptiveRefinementStepIds);
    expect(result.capsule?.progress).toMatchObject({
      completedRefinementStep: { stepId: claimedStep.stepId, order: claimedStep.order },
      currentCoordinateId,
      matchedRepositoryEditIds: [fixture.editId],
      certifiedExpectationIds: [],
      satisfiedEvidenceRequirementIds: [],
    });
    expect(result.capsule?.nextValidTransition).toEqual({ kind: "verify_change" });

    const resumed = resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: capsule.capsuleHash,
    });
    expect(resumed.status, JSON.stringify(resumed)).toBe("RESUMED");
    expect(resumed.capsule?.capsuleHash).toBe(capsule.capsuleHash);
    expect(resumed.capsule?.descriptiveRefinementStepIds).toEqual(
      descriptiveRefinementStepIds,
    );
  });

  it("refuses unknown and incomplete completed-step pointers", () => {
    const fixture = preparedRepository();
    const base = {
      schemaVersion: 2 as const,
      planningBundle: fixture.bundle,
      progress: {
        state: "step_completed" as const,
        currentCoordinateId: fixture.currentCoordinateId,
        completedRefinementStepId: "step.unknown",
      },
    };
    expect(captureControlHandoffV2(fixture.root, base)).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["PROGRESS_STEP_UNKNOWN"],
      capsule: null,
    });

    const step = must(fixture.bundle.semanticChangeSet.refinementSteps[0]);
    expect(captureControlHandoffV2(fixture.root, {
      ...base,
      progress: { ...base.progress, completedRefinementStepId: step.stepId },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["PROGRESS_STEP_NOT_COMPLETE"],
      capsule: null,
    });
  });

  it("refuses a satisfied later step when an earlier step has no machine receipt", () => {
    const fixture = completedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const planningBundle = withSkippedEarlierStep(fixture);
    expect(planningBundle.semanticChangeSet.refinementSteps.map((step) =>
      classifyControlHandoffRefinementStepV2(planningBundle.semanticChangeSet, step)
    )).toEqual(["proof_bearing", "proof_bearing"]);

    expect(captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle,
      progress: {
        state: "step_completed",
        completedRefinementStepId: "step.later.satisfied",
        currentCoordinateId: fixture.currentCoordinateId,
      },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["PROGRESS_STEP_NOT_COMPLETE"],
      capsule: null,
    });
  });

  it("fails closed when a predecessor is legacy ambiguous", () => {
    const fixture = completedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const planningBundle = withSkippedEarlierStep(fixture, true);
    expect(classifyControlHandoffRefinementStepV2(
      planningBundle.semanticChangeSet,
      must(planningBundle.semanticChangeSet.refinementSteps[0]),
    )).toBe("legacy_ambiguous");

    expect(captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle,
      progress: {
        state: "step_completed",
        completedRefinementStepId: "step.later.satisfied",
        currentCoordinateId: fixture.currentCoordinateId,
      },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["PROGRESS_STEP_NOT_COMPLETE"],
      capsule: null,
    });
  });

  it("fails closed with a null capsule when the captured diff drifts", () => {
    const fixture = preparedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// drift\n`, "utf8");

    expect(resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: capsule.capsuleHash,
    })).toEqual({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "REFUSED",
      reasonCodes: ["HANDOFF_DIFF_STALE"],
      capsule: null,
      planningBundle: null,
    });
  });

  it("does not publish a record when state changes at the final visibility gate", () => {
    const fixture = preparedRepository();
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_HANDOFF_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage === "before_state_validation") {
        writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// raced\n`, "utf8");
      }
    };

    expect(captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["CAPTURE_STATE_CHANGED"],
      capsule: null,
    });
    const directory = join(fixture.root, ".semctx", "working", "handoffs", "v2");
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toEqual([]);
  });

  it("revalidates state before an idempotent capture returns success", () => {
    const fixture = preparedRepository();
    const request = {
      schemaVersion: 2 as const,
      planningBundle: fixture.bundle,
      progress: { state: "not_started" as const, currentCoordinateId: fixture.currentCoordinateId },
    };
    expect(captureControlHandoffV2(fixture.root, request).status).toBe("CAPTURED");
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_HANDOFF_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage === "before_state_validation") {
        writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// raced\n`, "utf8");
      }
    };

    expect(captureControlHandoffV2(fixture.root, request)).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["CAPTURE_STATE_CHANGED"],
      capsule: null,
    });
  });

  it("revalidates state immediately before resume returns the capsule", () => {
    const fixture = preparedRepository();
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_HANDOFF_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage === "before_resume_state_validation") {
        writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// raced\n`, "utf8");
      }
    };

    expect(resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: capsule.capsuleHash,
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["CAPTURE_STATE_CHANGED"],
      capsule: null,
      planningBundle: null,
    });
  });

  it("rejects a handoff directory link without writing or reading outside the repository", () => {
    const fixture = preparedRepository();
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);
    const directory = join(fixture.root, ".semctx", "working", "handoffs", "v2");
    rmSync(directory, { recursive: true, force: true });
    const external = temporaryRoot("external-handoff");
    try {
      symlinkSync(external, directory, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    expect(captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["HANDOFF_RECORD_INVALID"],
      capsule: null,
    });
    expect(resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: capsule.capsuleHash,
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["HANDOFF_RECORD_INVALID"],
      capsule: null,
      planningBundle: null,
    });
    expect(readdirSync(external)).toEqual([]);
  });

  it("removes only its own published target when post-publication validation fails", () => {
    const fixture = preparedRepository();
    const directory = join(fixture.root, ".semctx", "working", "handoffs", "v2");
    (globalThis as Record<PropertyKey, unknown>)[CONTROL_HANDOFF_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage !== "after_publish_before_validation") return;
      const target = must(readdirSync(directory).find((entry) => entry.endsWith(".json")));
      writeFileSync(join(directory, target), "{corrupted", "utf8");
    };

    expect(captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["HANDOFF_RECORD_INVALID"],
      capsule: null,
    });
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toEqual([]);
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects corrupted content-addressed records", () => {
    const fixture = preparedRepository();
    writeFileSync(fixture.source, `${readFileSync(fixture.source, "utf8")}\n// candidate\n`, "utf8");
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);
    const path = join(
      fixture.root,
      ".semctx",
      "working",
      "handoffs",
      "v2",
      `${capsule.capsuleHash.slice("sha256:".length)}.json`,
    );
    writeFileSync(path, "{}", "utf8");
    expect(resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: capsule.capsuleHash,
    })).toMatchObject({
      status: "REFUSED",
      reasonCodes: ["HANDOFF_RECORD_INVALID"],
      capsule: null,
      planningBundle: null,
    });
  });
});

function preparedRepository() {
  const root = temporaryRoot("prepared");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.handoff-v2",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  writeFileSync(
    join(root, ".semctx", "semantic", "handoff-v2.sem"),
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
    id: "task.handoff-v2",
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
      evidenceId: "discovery:handoff-v2",
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

function completedRepository() {
  const root = temporaryRoot("completed");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.handoff-v2-complete",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-08-01T10:00:00.000Z");

  const sourcePath = "src/domain/capacity.ts";
  const firstStore = openStore(root);
  const pathNodes = firstStore.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === sourcePath
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === sourcePath));
  const linkedNode = must(pathNodes.find((node) => node.id.startsWith("sym:")));
  const repositoryEvidence = firstStore.loadEvidence();
  const relationEvidence = must(repositoryEvidence.find((evidence) =>
    evidence.filePath.replaceAll("\\", "/") === sourcePath));
  const editEvidence = must(repositoryEvidence.find((evidence) =>
    evidence.id !== relationEvidence.id));
  firstStore.close();
  const evidenceDigest = sha256HashCanonicalJson(relationEvidence);
  writeFileSync(
    join(root, ".semctx", "semantic", "handoff-v2-complete.sem"),
    [
      "goal goal.capacity.behavior",
      "  statement: Capacity behavior remains explicit.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 2",
      "",
      "goal goal.capacity.component",
      "  statement: Capacity component implements the behavior.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 1",
      `  link: ${linkedNode.id}`,
      "",
      "relation relation.capacity.handoff decomposes_to source semantic goal.capacity.behavior",
      "target semantic goal.capacity.component",
      "epistemicStatus human_declared",
      "provenance author",
      `evidenceRef document_span ${relationEvidence.id} ${evidenceDigest}`,
      "end",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seal refinement");
  indexRepository(root, "2026-08-01T10:01:00.000Z");

  const frame: TaskFrame = {
    id: "task.handoff-v2-complete",
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
  };
  const store = openStore(root);
  store.saveTaskFrame(frame);
  store.close();
  const coordinateIds = pathNodes.map((node) => `repo:${node.id}` as const).sort();
  const expectationId = "expectation.capacity.behavior";
  const editId = "edit.capacity.complete";
  const bundle = buildPlanningBundle(root, {
    schemaVersion: 1,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: coordinateIds.map((coordinateId, index) => ({
      coordinateId,
      repositoryPath: sourcePath,
      evidenceId: `discovery:handoff-complete:${index}`,
      evidenceProvenance: "test" as const,
      scope: { kind: "coordinate_set" as const, coordinateIds },
    })),
    rollbackDescription: "Restore the committed implementation.",
    semanticExpectations: [{
      schemaVersion: 1,
      expectationId,
      kind: "behavior",
      level: 2,
      required: true,
      subjectId: "goal.capacity.behavior",
      statement: "Capacity behavior remains explicit.",
      acceptanceEvidenceIds: [editEvidence.id],
    }],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      editId,
      kind: "modify",
      required: true,
      path: sourcePath,
      coordinateIds,
      expectedLiftedExpectationIds: [expectationId],
      acceptanceEvidenceIds: [relationEvidence.id],
    }],
  });
  const stepId = must(bundle.semanticChangeSet.refinementSteps.find((step) =>
    step.repositoryEditIds.includes(editId))).stepId;
  return {
    root,
    source: join(root, sourcePath),
    bundle,
    stepId,
    currentCoordinateId: "semantic:goal.capacity.behavior" as const,
    editId,
    expectationId,
    evidenceId: relationEvidence.id,
    editEvidenceId: editEvidence.id,
  };
}

function editOnlyLocalPatchRepository() {
  const root = temporaryRoot("edit-only-local-patch");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.handoff-v2-edit-only",
    statement: "Adjust one local capacity implementation.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-08-01T12:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.handoff-v2-edit-only",
    rawTask: "Fix one local capacity implementation.",
    mode: "bugfix",
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
    createdAt: "2026-08-01T11:00:00.000Z",
  };
  const sourcePath = "src/domain/capacity.ts";
  const store = openStore(root);
  const pathNodes = store.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === sourcePath
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === sourcePath));
  store.saveTaskFrame(frame);
  store.close();
  const coordinateIds = pathNodes.map((node) => `repo:${node.id}` as const).sort();
  const editId = "edit.capacity.local-patch";
  const bundle = buildPlanningBundle(root, {
    schemaVersion: 1,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: coordinateIds.map((coordinateId, index) => ({
      coordinateId,
      repositoryPath: sourcePath,
      evidenceId: `discovery:local-patch:${index}`,
      evidenceProvenance: "test" as const,
      scope: { kind: "coordinate_set" as const, coordinateIds },
    })),
    rollbackDescription: "Restore the committed implementation.",
    semanticExpectations: [],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      editId,
      kind: "modify",
      required: true,
      path: sourcePath,
      coordinateIds,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    }],
  });
  expect(bundle.semanticChangeSet.profile).toBe("local_patch");
  return { root, source: join(root, sourcePath), bundle, editId };
}

function withSkippedEarlierStep(
  fixture: ReturnType<typeof completedRepository>,
  legacyAmbiguousPredecessor = false,
): PlanningBundleV1 {
  const original = fixture.bundle.semanticChangeSet;
  const requiredEdit = must(original.repositoryEditExpectations.find(
    (edit) => edit.editId === fixture.editId,
  ));
  const optionalEdit = {
    ...requiredEdit,
    editId: "edit.optional.unmatched",
    required: false,
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
  const changeSetPayload: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    ...original,
    repositoryEditExpectations: [...original.repositoryEditExpectations, optionalEdit]
      .sort((left, right) => left.editId.localeCompare(right.editId)),
    refinementSteps: [{
      schemaVersion: 1,
      stepId: "step.earlier.unmatched",
      order: 0,
      fromExpectationIds: [],
      toExpectationIds: [],
      repositoryEditIds: legacyAmbiguousPredecessor ? [] : [optionalEdit.editId],
      ...(legacyAmbiguousPredecessor ? {} : { completionEvidenceRequirementIds: [] }),
    }, {
      schemaVersion: 1,
      stepId: "step.later.satisfied",
      order: 1,
      fromExpectationIds: [fixture.expectationId],
      toExpectationIds: [fixture.expectationId],
      repositoryEditIds: [fixture.editId],
      completionEvidenceRequirementIds: [],
    }],
  };
  const semanticChangeSet = SemanticChangeSetV1Schema.parse({
    ...changeSetPayload,
    changeSetHash: computeSemanticChangeSetV1Hash(changeSetPayload),
  }) as SemanticChangeSetV1;
  const bundlePayload: Omit<PlanningBundleV1, "bundleHash"> = {
    ...fixture.bundle,
    semanticChangeSet,
  };
  return PlanningBundleV1Schema.parse({
    ...bundlePayload,
    bundleHash: computePlanningBundleV1Hash(bundlePayload),
  }) as PlanningBundleV1;
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-handoff-v2-${label}-`));
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
