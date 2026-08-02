import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import * as handoffSurface from "@semantic-context/control-model/control-handoff";
import type {
  PlanningBundleV1,
  SemanticChangeSetV1,
  SemanticRefinementStepV1,
  TaskEnvelopeV1,
  TaskFrameSnapshotV1,
} from "@semantic-context/control-model";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;
const hashC = `sha256:${"c".repeat(64)}` as const;

function taskFrame(): TaskFrameSnapshotV1 {
  return {
    schemaVersion: 1,
    taskFrameId: "task.handoff",
    rawTaskDigest: hashA,
    mode: "feature",
    createdAt: "2026-08-01T10:00:00.000Z",
    capabilitySignals: ["handoff"],
    riskSignals: ["control_plane"],
    profileCandidate: "feature",
    altitudeCandidate: 3,
  };
}

function envelope(): TaskEnvelopeV1 {
  const snapshot = taskFrame();
  const input: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: "envelope.handoff",
    planningCommit: "abc123",
    taskFrameSnapshot: snapshot,
    taskFrameHash: controlModel.computeTaskFrameSnapshotV1Hash(snapshot),
    changeId: "change.handoff",
    changeContractHash: hashB,
    coordinateGraphSeal: hashA,
    indexSeal: hashB,
    baselineFreshnessSeal: hashC,
    profile: "feature",
    risk: "R1",
    requiredAltitude: 3,
    candidateAnchors: [],
    resolvedBindings: [{
      schemaVersion: 1,
      bindingId: "binding.file",
      coordinateId: "repo:file.src-x",
      repositoryPath: "src/x.ts",
      provenance: "explicit_discovery",
      evidenceId: "evidence.discovery",
      planningCommit: "abc123",
      graphSeal: hashA,
      scope: { kind: "file", path: "src/x.ts" },
    }],
    parentIntentIds: ["goal.handoff"],
    preservedInvariantIds: ["invariant.no-authority"],
    nonGoals: ["execute.patch"],
    expectedBehaviorDelta: ["handoff.is.reproducible"],
    declaredReconciliationScope: {
      kind: "file",
      bindingId: "binding.file",
      path: "src/x.ts",
    },
    proofObligationIds: ["proof.handoff"],
    compatibilityNotes: [],
  };
  return { ...input, envelopeHash: controlModel.computeTaskEnvelopeV1Hash(input) };
}

function changeSet(): SemanticChangeSetV1 {
  const taskEnvelope = envelope();
  const input: Omit<SemanticChangeSetV1, "changeSetHash"> = {
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "changeset.handoff",
    envelopeId: taskEnvelope.envelopeId,
    envelopeHash: taskEnvelope.envelopeHash,
    planningCommit: taskEnvelope.planningCommit,
    profile: "feature",
    declaredReconciliationScope: taskEnvelope.declaredReconciliationScope,
    refinementSteps: [{
      schemaVersion: 1,
      stepId: "step.0",
      order: 0,
      fromExpectationIds: ["semantic.behavior"],
      toExpectationIds: ["semantic.behavior"],
      repositoryEditIds: ["edit.modify"],
    }],
    semanticExpectations: [{
      schemaVersion: 1,
      expectationId: "semantic.behavior",
      kind: "behavior",
      level: 3,
      required: true,
      subjectId: "semantic:capability.handoff",
      statement: "The handoff is bound to the observed repository state.",
      acceptanceEvidenceIds: ["evidence.behavior"],
    }],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      kind: "modify",
      editId: "edit.modify",
      required: true,
      path: "src/x.ts",
      coordinateIds: ["repo:file.src-x"],
      expectedLiftedExpectationIds: ["semantic.behavior"],
      acceptanceEvidenceIds: ["evidence.behavior"],
    }],
    rollbackDescription: "Revert the candidate commit.",
    testReferences: ["test.handoff"],
    acceptanceEvidenceIds: ["evidence.behavior"],
    proofObligationIds: ["proof.handoff"],
  };
  return { ...input, changeSetHash: controlModel.computeSemanticChangeSetV1Hash(input) };
}

function bundle(): PlanningBundleV1 {
  const taskEnvelope = envelope();
  const semanticChangeSet = changeSet();
  const input: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: "bundle.handoff",
    planningCommit: "abc123",
    taskEnvelope,
    semanticChangeSet,
    baseline: {
      schemaVersion: 1,
      kind: "workspace_baseline",
      planningCommit: "abc123",
      cleanliness: "FRESH",
      freshnessSealHash: hashC,
      workingDiffHash: hashA,
      semanticModelHash: hashC,
      analyzerConfigHash: hashA,
      toolVersion: "semctx@0.1.17",
      storeSchemaVersion: 2,
      attestationSetHash: hashA,
    },
  };
  return { ...input, bundleHash: controlModel.computePlanningBundleV1Hash(input) };
}

function bundleWithThreeSteps(): PlanningBundleV1 {
  const original = bundle();
  const { changeSetHash: _changeSetHash, ...changeSetPayload } = original.semanticChangeSet;
  const semanticChangeSet = {
    ...changeSetPayload,
    refinementSteps: [
      ...changeSetPayload.refinementSteps,
      {
        ...changeSetPayload.refinementSteps[0]!,
        stepId: "step.1",
        order: 1,
      },
      {
        ...changeSetPayload.refinementSteps[0]!,
        stepId: "step.2",
        order: 2,
      },
    ],
  };
  const rehashedChangeSet = {
    ...semanticChangeSet,
    changeSetHash: controlModel.computeSemanticChangeSetV1Hash(semanticChangeSet),
  };
  const { bundleHash: _bundleHash, ...bundlePayload } = original;
  const rehashedBundle = { ...bundlePayload, semanticChangeSet: rehashedChangeSet };
  return {
    ...rehashedBundle,
    bundleHash: controlModel.computePlanningBundleV1Hash(rehashedBundle),
  };
}

function bundleWithEditEvidence(): PlanningBundleV1 {
  const original = bundle();
  const { changeSetHash: _changeSetHash, ...changeSetPayload } = original.semanticChangeSet;
  const semanticChangeSet = {
    ...changeSetPayload,
    repositoryEditExpectations: changeSetPayload.repositoryEditExpectations.map((edit) => ({
      ...edit,
      acceptanceEvidenceIds: ["evidence.behavior", "evidence.edit"],
    })),
    acceptanceEvidenceIds: ["evidence.behavior", "evidence.edit"],
  };
  const rehashedChangeSet = {
    ...semanticChangeSet,
    changeSetHash: controlModel.computeSemanticChangeSetV1Hash(semanticChangeSet),
  };
  const { bundleHash: _bundleHash, ...bundlePayload } = original;
  const rehashedBundle = { ...bundlePayload, semanticChangeSet: rehashedChangeSet };
  return {
    ...rehashedBundle,
    bundleHash: controlModel.computePlanningBundleV1Hash(rehashedBundle),
  };
}

function bundleWithSteps(
  refinementSteps: readonly SemanticRefinementStepV1[],
  proofObligationIds = bundle().semanticChangeSet.proofObligationIds,
): PlanningBundleV1 {
  const original = bundle();
  const { changeSetHash: _changeSetHash, ...changeSetPayload } = original.semanticChangeSet;
  const semanticChangeSetPayload = {
    ...changeSetPayload,
    refinementSteps,
    proofObligationIds,
  };
  const semanticChangeSet = {
    ...semanticChangeSetPayload,
    changeSetHash: controlModel.computeSemanticChangeSetV1Hash(semanticChangeSetPayload),
  };
  const { bundleHash: _bundleHash, ...bundlePayload } = original;
  const nextBundlePayload = { ...bundlePayload, semanticChangeSet };
  return {
    ...nextBundlePayload,
    bundleHash: controlModel.computePlanningBundleV1Hash(nextBundlePayload),
  };
}

function progress() {
  const input = {
    state: "step_completed" as const,
    currentCoordinateId: "repo:file.src-x" as const,
    currentAbstractionLevel: 0 as const,
    completedRefinementStep: { stepId: "step.0", order: 0 },
    matchedRepositoryEditIds: ["edit.modify"],
    certifiedExpectationIds: ["semantic.behavior"],
    satisfiedEvidenceRequirementIds: ["evidence.behavior"],
  };
  return {
    ...input,
    progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(input),
  };
}

function capsule(planningBundle = bundle()) {
  const input = {
    schemaVersion: 2 as const,
    kind: "control_handoff_capsule" as const,
    executionAuthority: "none" as const,
    enforcementMode: "shadow" as const,
    blockingEnabled: false as const,
    sourceContentCollected: false as const,
    planningBundleId: planningBundle.bundleId,
    planningBundleHash: planningBundle.bundleHash,
    envelopeId: planningBundle.taskEnvelope.envelopeId,
    envelopeHash: planningBundle.taskEnvelope.envelopeHash,
    changeSetId: planningBundle.semanticChangeSet.changeSetId,
    changeSetHash: planningBundle.semanticChangeSet.changeSetHash,
    planningCommit: planningBundle.planningCommit,
    progress: progress(),
    seals: {
      coordinateGraphSeal: planningBundle.taskEnvelope.coordinateGraphSeal,
      indexSeal: planningBundle.taskEnvelope.indexSeal,
      baselineFreshnessSeal: planningBundle.taskEnvelope.baselineFreshnessSeal,
      reconciliationReportHash: hashA,
      reconciliationAnalysisHash: hashB,
      observationAnalysisHash: hashC,
    },
    repositoryIdentity: "repo:semctx",
    observedCommit: "def456",
    observedWorkingDiffHash: hashB,
    reconciliationTerminalStatus: "REALIZED" as const,
    reconciliationReasonCodes: [],
    touchedCoordinateIds: ["repo:file.src-x" as const],
    unmappedObservedHunkIds: [],
    proofsObtained: [{
      schemaVersion: 1 as const,
      requirementId: "evidence.behavior",
      origin: "semantic_expectation" as const,
      required: true,
      evidenceId: "evidence.behavior",
      semanticEvidenceDigest: hashA,
      acceptedAttestationDigests: [hashB],
      planningCommit: "abc123",
      observedDiffHash: hashB,
      semanticModelHash: hashC,
      attestationSetHash: hashA,
      observationAnalysisHash: hashC,
      provenance: ["canonical_attestation" as const, "plane_a_observed" as const, "plane_b_authored" as const],
      result: "satisfied" as const,
    }],
    descriptiveRefinementStepIds: requiredFunction(
      "computeControlHandoffDescriptiveRefinementStepIdsV2",
    )(planningBundle.semanticChangeSet),
    nextValidTransition: { kind: "verify_change" as const },
  };
  return {
    ...input,
    capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(input),
  };
}

// This public-export contract intentionally bypasses static imports so missing
// runtime exports fail the test instead of TypeScript compilation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requiredExport(name: string): any {
  const value = (controlModel as Record<string, unknown>)[name];
  expect(value, `${name} must be publicly exported`).toBeDefined();
  return value;
}

// The dynamically selected export's signature is part of the runtime contract
// under test, so both arguments and return value are deliberately unconstrained.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requiredFunction(name: string): (...args: any[]) => any {
  const value = requiredExport(name);
  expect(typeof value).toBe("function");
  return value;
}

describe("Control Handoff v2 public contract", () => {
  it("classifies proof-bearing, explicit descriptive, and legacy ambiguous steps", () => {
    const changeSetValue = changeSet();
    const classify = requiredFunction("classifyControlHandoffRefinementStepV2");
    const base = changeSetValue.refinementSteps[0]!;
    const descriptive = {
      ...base,
      toExpectationIds: [],
      repositoryEditIds: [],
      completionEvidenceRequirementIds: [],
    };
    const ambiguous = {
      ...base,
      toExpectationIds: [],
      repositoryEditIds: [],
    };
    delete (ambiguous as Partial<SemanticRefinementStepV1>).completionEvidenceRequirementIds;

    expect(classify(changeSetValue, base)).toBe("proof_bearing");
    expect(classify(changeSetValue, descriptive)).toBe("descriptive");
    expect(classify(changeSetValue, ambiguous)).toBe("legacy_ambiguous");
  });

  it("exports the strict request, capsule, record, and result schemas", () => {
    for (const name of [
      "ControlHandoffProgressPointerV2Schema",
      "ControlHandoffCoordinateIdV2Schema",
      "ControlHandoffCaptureRequestV2Schema",
      "ControlHandoffResumeRequestV2Schema",
      "ControlHandoffProgressReceiptV2Schema",
      "ControlHandoffReconciliationReasonCodeV2Schema",
      "ControlHandoffCapsuleV2Schema",
      "ControlHandoffRecordV2Schema",
      "ControlHandoffCaptureResultV2Schema",
      "ControlHandoffResumeResultV2Schema",
    ]) requiredExport(name);
  });

  it("accepts qualified or observed-hunk progress coordinates and hashes them exactly", () => {
    const coordinateSchema = requiredExport("ControlHandoffCoordinateIdV2Schema");
    expect(coordinateSchema.safeParse("repo:file.src-x").success).toBe(true);
    expect(coordinateSchema.safeParse("semantic:capability.handoff").success).toBe(true);
    expect(coordinateSchema.safeParse(hashA).success).toBe(true);
    expect(coordinateSchema.safeParse("hunk:unsealed").success).toBe(false);

    const valid = progress();
    const { progressHash: _hash, ...payload } = {
      ...valid,
      currentCoordinateId: hashA,
    };
    const observedHunkProgress = {
      ...payload,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(payload),
    };
    expect(requiredExport("ControlHandoffProgressReceiptV2Schema").safeParse(
      observedHunkProgress,
    ).success).toBe(true);
    expect(observedHunkProgress.progressHash).not.toBe(valid.progressHash);
  });

  it("accepts a canonical capsule and rejects unknown fields and stale hashes", () => {
    const schema = requiredExport("ControlHandoffCapsuleV2Schema");
    const valid = capsule();
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(schema.safeParse({ ...valid, capsuleHash: hashC }).success).toBe(false);
    expect(schema.safeParse({
      ...valid,
      progress: { ...valid.progress, progressHash: hashC },
      capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")({
        ...valid,
        progress: { ...valid.progress, progressHash: hashC },
      }),
    }).success).toBe(false);
  });

  it("requires canonical arrays, satisfied proofs, and terminal reason coherence", () => {
    const schema = requiredExport("ControlHandoffCapsuleV2Schema");
    const valid = capsule();
    for (const mutation of [
      { ...valid, touchedCoordinateIds: ["repo:z", "repo:a"] },
      { ...valid, touchedCoordinateIds: ["repo:file.src-x", "repo:file.src-x"] },
      { ...valid, proofsObtained: [{ ...valid.proofsObtained[0], result: "missing" }] },
      { ...valid, reconciliationTerminalStatus: "REFUSED" },
      { ...valid, reconciliationTerminalStatus: "REALIZED", reconciliationReasonCodes: ["BASELINE_NOT_CLEAN"] },
      { ...valid, reconciliationTerminalStatus: "UNPROVEN", reconciliationReasonCodes: [] },
      {
        ...valid,
        nextValidTransition: {
          kind: "obtain_proof_then_reconcile",
          requirementIds: ["evidence.missing"],
        },
      },
    ]) {
      const { capsuleHash: _hash, ...payload } = mutation;
      expect(schema.safeParse({
        ...payload,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
      }).success).toBe(false);
    }
  });

  it("allows repair after an unproven concrete edit expectation", () => {
    const valid = capsule();
    const { capsuleHash: _hash, ...payload } = {
      ...valid,
      reconciliationTerminalStatus: "UNPROVEN" as const,
      reconciliationReasonCodes: ["CONCRETE_EDIT_EXPECTATION_MISSING" as const],
      nextValidTransition: {
        kind: "repair_then_reconcile" as const,
        reasonCodes: ["CONCRETE_EDIT_EXPECTATION_MISSING" as const],
      },
    };
    expect(requiredExport("ControlHandoffCapsuleV2Schema").safeParse({
      ...payload,
      capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
    }).success).toBe(true);
  });

  it("allows repair after any canonical unproven insufficiency", () => {
    const valid = capsule();
    const { capsuleHash: _hash, ...payload } = {
      ...valid,
      reconciliationTerminalStatus: "UNPROVEN" as const,
      reconciliationReasonCodes: ["ROUND_TRIP_UNPROVEN" as const],
      nextValidTransition: {
        kind: "repair_then_reconcile" as const,
        reasonCodes: ["ROUND_TRIP_UNPROVEN" as const],
      },
    };
    expect(requiredExport("ControlHandoffCapsuleV2Schema").safeParse({
      ...payload,
      capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
    }).success).toBe(true);
  });

  it("allows a realized capsule to continue to the next refinement step", () => {
    const valid = capsule();
    const { capsuleHash: _hash, ...payload } = {
      ...valid,
      nextValidTransition: {
        kind: "refinement_step" as const,
        stepId: "step.1",
        order: 1,
      },
    };
    expect(requiredExport("ControlHandoffCapsuleV2Schema").safeParse({
      ...payload,
      capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
    }).success).toBe(true);
  });

  it("allows violated and unproven handoffs to continue to the exact next step", () => {
    const valid = capsule();
    for (const terminal of [
      {
        reconciliationTerminalStatus: "VIOLATED" as const,
        reconciliationReasonCodes: ["MISSING_PLANNED_EDIT" as const],
      },
      {
        reconciliationTerminalStatus: "UNPROVEN" as const,
        reconciliationReasonCodes: ["ROUND_TRIP_UNPROVEN" as const],
      },
    ]) {
      const { capsuleHash: _hash, ...payload } = {
        ...valid,
        ...terminal,
        nextValidTransition: {
          kind: "refinement_step" as const,
          stepId: "step.1",
          order: 1,
        },
      };
      expect(requiredExport("ControlHandoffCapsuleV2Schema").safeParse({
        ...payload,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
      }).success).toBe(true);
    }
  });

  it("exports the contract and reason vocabularies on its dedicated runtime subpath", () => {
    expect(handoffSurface.ControlHandoffCapsuleV2Schema).toBe(
      controlModel.ControlHandoffCapsuleV2Schema,
    );
    expect(handoffSurface.RECONCILIATION_VIOLATION_REASONS).toEqual(
      controlModel.RECONCILIATION_VIOLATION_REASONS,
    );
    expect(handoffSurface.RECONCILIATION_INSUFFICIENCY_REASONS).toEqual(
      controlModel.RECONCILIATION_INSUFFICIENCY_REASONS,
    );
  });

  it("enforces progress state relationships and canonical progress arrays", () => {
    const schema = requiredExport("ControlHandoffProgressReceiptV2Schema");
    const valid = progress();
    expect(schema.safeParse(valid).success).toBe(true);
    for (const mutation of [
      { ...valid, state: "not_started", completedRefinementStep: valid.completedRefinementStep },
      { ...valid, matchedRepositoryEditIds: ["z", "a"] },
      { ...valid, certifiedExpectationIds: ["semantic.behavior", "semantic.behavior"] },
      {
        ...valid,
        matchedRepositoryEditIds: [],
        certifiedExpectationIds: [],
        satisfiedEvidenceRequirementIds: [],
      },
    ]) {
      const { progressHash: _hash, ...payload } = mutation;
      expect(schema.safeParse({
        ...payload,
        progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(payload),
      }).success).toBe(false);
    }
  });

  it("does not infer abstraction level from the repository coordinate prefix", () => {
    const valid = progress();
    const { progressHash: _hash, ...payload } = {
      ...valid,
      currentAbstractionLevel: 1 as const,
    };
    expect(requiredExport("ControlHandoffProgressReceiptV2Schema").safeParse({
      ...payload,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(payload),
    }).success).toBe(true);
  });

  it("binds a record to its capture request and capsule", () => {
    const request = {
      schemaVersion: 2 as const,
      planningBundle: bundle(),
      progress: {
        state: "step_completed" as const,
        completedRefinementStepId: "step.0",
        currentCoordinateId: "repo:file.src-x" as const,
      },
    };
    const record = {
      schemaVersion: 2 as const,
      kind: "control_handoff_record" as const,
      request,
      capsule: capsule(),
    };
    const schema = requiredExport("ControlHandoffRecordV2Schema");
    expect(schema.safeParse(record).success).toBe(true);
    expect(schema.safeParse({
      ...record,
      request: { ...request, progress: { ...request.progress, completedRefinementStepId: "step.other" } },
    }).success).toBe(false);

    const observedProgressPayload = {
      ...record.capsule.progress,
      currentCoordinateId: hashA,
    };
    const { progressHash: _observedProgressHash, ...observedProgressWithoutHash } =
      observedProgressPayload;
    const observedProgress = {
      ...observedProgressWithoutHash,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(
        observedProgressWithoutHash,
      ),
    };
    const observedCapsulePayload = { ...record.capsule, progress: observedProgress };
    const { capsuleHash: _observedCapsuleHash, ...observedCapsuleWithoutHash } =
      observedCapsulePayload;
    const observedRecord = {
      ...record,
      request: {
        ...request,
        progress: { ...request.progress, currentCoordinateId: hashA },
      },
      capsule: {
        ...observedCapsuleWithoutHash,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(
          observedCapsuleWithoutHash,
        ),
      },
    };
    expect(schema.safeParse(observedRecord).success).toBe(true);
    expect(schema.safeParse({
      ...observedRecord,
      request: {
        ...observedRecord.request,
        progress: { ...observedRecord.request.progress, currentCoordinateId: hashB },
      },
    }).success).toBe(false);
    const invalidNextPayload = {
      ...record.capsule,
      nextValidTransition: { kind: "refinement_step" as const, stepId: "step.1", order: 1 },
    };
    expect(schema.safeParse({
      ...record,
      capsule: {
        ...invalidNextPayload,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(invalidNextPayload),
      },
    }).success).toBe(false);
    for (const progressMutation of [
      { ...record.capsule.progress, matchedRepositoryEditIds: [] },
      { ...record.capsule.progress, certifiedExpectationIds: [] },
      { ...record.capsule.progress, satisfiedEvidenceRequirementIds: [] },
    ]) {
      const { progressHash: _progressHash, ...progressPayload } = progressMutation;
      const nextProgress = {
        ...progressPayload,
        progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(progressPayload),
      };
      const capsulePayload = { ...record.capsule, progress: nextProgress };
      const { capsuleHash: _capsuleHash, ...capsuleWithoutHash } = capsulePayload;
      expect(schema.safeParse({
        ...record,
        capsule: {
          ...capsuleWithoutHash,
          capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(capsuleWithoutHash),
        },
      }).success).toBe(false);
    }
  });

  it("rejects skipped refinement steps for violated and unproven records", () => {
    const planningBundle = bundleWithThreeSteps();
    const request = {
      schemaVersion: 2 as const,
      planningBundle,
      progress: {
        state: "step_completed" as const,
        completedRefinementStepId: "step.0",
        currentCoordinateId: "repo:file.src-x" as const,
      },
    };
    const schema = requiredExport("ControlHandoffRecordV2Schema");
    for (const terminal of [
      {
        reconciliationTerminalStatus: "VIOLATED" as const,
        reconciliationReasonCodes: ["MISSING_PLANNED_EDIT" as const],
      },
      {
        reconciliationTerminalStatus: "UNPROVEN" as const,
        reconciliationReasonCodes: ["ROUND_TRIP_UNPROVEN" as const],
      },
    ]) {
      const base = capsule(planningBundle);
      const { capsuleHash: _validHash, ...validPayload } = {
        ...base,
        ...terminal,
        nextValidTransition: {
          kind: "refinement_step" as const,
          stepId: "step.1",
          order: 1,
        },
      };
      expect(schema.safeParse({
        schemaVersion: 2,
        kind: "control_handoff_record",
        request,
        capsule: {
          ...validPayload,
          capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(validPayload),
        },
      }).success).toBe(true);
      const { capsuleHash: _capsuleHash, ...capsulePayload } = {
        ...base,
        ...terminal,
        nextValidTransition: {
          kind: "refinement_step" as const,
          stepId: "step.2",
          order: 2,
        },
      };
      expect(schema.safeParse({
        schemaVersion: 2,
        kind: "control_handoff_record",
        request,
        capsule: {
          ...capsulePayload,
          capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(capsulePayload),
        },
      }).success).toBe(false);
    }
  });

  it("records descriptive steps in semantic order and skips only those explicit steps", () => {
    const baseStep = changeSet().refinementSteps[0]!;
    const planningBundle = bundleWithSteps([
      baseStep,
      {
        ...baseStep,
        stepId: "step.z-description",
        order: 1,
        toExpectationIds: [],
        repositoryEditIds: [],
        completionEvidenceRequirementIds: [],
      },
      {
        ...baseStep,
        stepId: "step.a-description",
        order: 2,
        toExpectationIds: [],
        repositoryEditIds: [],
        completionEvidenceRequirementIds: [],
      },
      { ...baseStep, stepId: "step.middle-proof", order: 3 },
    ]);
    const baseCapsule = capsule(planningBundle);
    const { capsuleHash: _capsuleHash, ...capsulePayload } = {
      ...baseCapsule,
      nextValidTransition: {
        kind: "refinement_step" as const,
        stepId: "step.middle-proof",
        order: 3,
      },
    };
    const record = {
      schemaVersion: 2 as const,
      kind: "control_handoff_record" as const,
      request: {
        schemaVersion: 2 as const,
        planningBundle,
        progress: {
          state: "step_completed" as const,
          completedRefinementStepId: "step.0",
          currentCoordinateId: "repo:file.src-x" as const,
        },
      },
      capsule: {
        ...capsulePayload,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(capsulePayload),
      },
    };
    const schema = requiredExport("ControlHandoffRecordV2Schema");
    expect(record.capsule.descriptiveRefinementStepIds).toEqual([
      "step.z-description",
      "step.a-description",
    ]);
    expect(schema.safeParse(record).success).toBe(true);

    const tamperedPayload = { ...record.capsule, descriptiveRefinementStepIds: [] };
    const { capsuleHash: _tamperedHash, ...tamperedWithoutHash } = tamperedPayload;
    expect(schema.safeParse({
      ...record,
      capsule: {
        ...tamperedWithoutHash,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(tamperedWithoutHash),
      },
    }).success).toBe(false);
  });

  it("keeps legacy ambiguous steps non-skippable", () => {
    const baseStep = changeSet().refinementSteps[0]!;
    const planningBundle = bundleWithSteps([
      baseStep,
      {
        ...baseStep,
        stepId: "step.legacy",
        order: 1,
        toExpectationIds: [],
        repositoryEditIds: [],
      },
      { ...baseStep, stepId: "step.after", order: 2 },
    ]);
    const baseCapsule = capsule(planningBundle);
    const request = {
      schemaVersion: 2 as const,
      planningBundle,
      progress: {
        state: "step_completed" as const,
        completedRefinementStepId: "step.0",
        currentCoordinateId: "repo:file.src-x" as const,
      },
    };
    const schema = requiredExport("ControlHandoffRecordV2Schema");
    for (const [stepId, order, expected] of [
      ["step.legacy", 1, true],
      ["step.after", 2, false],
    ] as const) {
      const { capsuleHash: _hash, ...payload } = {
        ...baseCapsule,
        nextValidTransition: { kind: "refinement_step" as const, stepId, order },
      };
      expect(schema.safeParse({
        schemaVersion: 2,
        kind: "control_handoff_record",
        request,
        capsule: {
          ...payload,
          capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(payload),
        },
      }).success).toBe(expected);
    }
  });

  it("rejects descriptive steps as completed progress and requires explicit completion evidence", () => {
    const baseStep = changeSet().refinementSteps[0]!;
    const descriptiveBundle = bundleWithSteps([{
      ...baseStep,
      stepId: "step.description",
      order: 0,
      toExpectationIds: [],
      repositoryEditIds: [],
      completionEvidenceRequirementIds: [],
    }]);
    const descriptiveProgressPayload = {
      ...progress(),
      completedRefinementStep: { stepId: "step.description", order: 0 },
    };
    const { progressHash: _descriptiveHash, ...descriptiveWithoutHash } = descriptiveProgressPayload;
    const descriptiveProgress = {
      ...descriptiveWithoutHash,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(descriptiveWithoutHash),
    };
    const descriptiveCapsuleBase = capsule(descriptiveBundle);
    const { capsuleHash: _capsuleHash, ...descriptiveCapsulePayload } = {
      ...descriptiveCapsuleBase,
      progress: descriptiveProgress,
    };
    expect(requiredExport("ControlHandoffRecordV2Schema").safeParse({
      schemaVersion: 2,
      kind: "control_handoff_record",
      request: {
        schemaVersion: 2,
        planningBundle: descriptiveBundle,
        progress: {
          state: "step_completed",
          completedRefinementStepId: "step.description",
          currentCoordinateId: "repo:file.src-x",
        },
      },
      capsule: {
        ...descriptiveCapsulePayload,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(
          descriptiveCapsulePayload,
        ),
      },
    }).success).toBe(false);

    const legacyStep = {
      ...baseStep,
      stepId: "step.legacy-completed",
      order: 0,
      toExpectationIds: [],
      repositoryEditIds: [],
    };
    delete (legacyStep as Partial<SemanticRefinementStepV1>)
      .completionEvidenceRequirementIds;
    const legacyBundle = bundleWithSteps([legacyStep]);
    const legacyProgressPayload = {
      ...progress(),
      completedRefinementStep: { stepId: legacyStep.stepId, order: legacyStep.order },
    };
    const { progressHash: _legacyProgressHash, ...legacyProgressWithoutHash } =
      legacyProgressPayload;
    const legacyProgress = {
      ...legacyProgressWithoutHash,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(
        legacyProgressWithoutHash,
      ),
    };
    const legacyCapsuleBase = capsule(legacyBundle);
    const { capsuleHash: _legacyCapsuleHash, ...legacyCapsuleWithoutHash } = {
      ...legacyCapsuleBase,
      progress: legacyProgress,
    };
    expect(requiredExport("ControlHandoffRecordV2Schema").safeParse({
      schemaVersion: 2,
      kind: "control_handoff_record",
      request: {
        schemaVersion: 2,
        planningBundle: legacyBundle,
        progress: {
          state: "step_completed",
          completedRefinementStepId: legacyStep.stepId,
          currentCoordinateId: "repo:file.src-x",
        },
      },
      capsule: {
        ...legacyCapsuleWithoutHash,
        capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(
          legacyCapsuleWithoutHash,
        ),
      },
    }).success).toBe(false);

    const evidenceBundle = bundleWithSteps([{
      ...baseStep,
      completionEvidenceRequirementIds: ["proof.handoff"],
    }]);
    const evidenceCapsule = capsule(evidenceBundle);
    expect(requiredExport("ControlHandoffRecordV2Schema").safeParse({
      schemaVersion: 2,
      kind: "control_handoff_record",
      request: {
        schemaVersion: 2,
        planningBundle: evidenceBundle,
        progress: {
          state: "step_completed",
          completedRefinementStepId: "step.0",
          currentCoordinateId: "repo:file.src-x",
        },
      },
      capsule: evidenceCapsule,
    }).success).toBe(false);

    const evidenceProgressPayload = {
      ...evidenceCapsule.progress,
      satisfiedEvidenceRequirementIds: ["evidence.behavior", "proof.handoff"],
    };
    const { progressHash: _evidenceProgressHash, ...evidenceProgressWithoutHash } =
      evidenceProgressPayload;
    const evidenceProgress = {
      ...evidenceProgressWithoutHash,
      progressHash: requiredFunction("computeControlHandoffProgressV2Hash")(
        evidenceProgressWithoutHash,
      ),
    };
    const proofObligationEvidence = {
      ...evidenceCapsule.proofsObtained[0]!,
      requirementId: "proof.handoff",
      evidenceId: "proof.handoff",
      origin: "proof_obligation" as const,
    };
    const { capsuleHash: _evidenceCapsuleHash, ...evidenceCapsuleWithoutHash } = {
      ...evidenceCapsule,
      progress: evidenceProgress,
      proofsObtained: [...evidenceCapsule.proofsObtained, proofObligationEvidence],
    };
    const completedEvidenceCapsule = {
      ...evidenceCapsuleWithoutHash,
      capsuleHash: requiredFunction("computeControlHandoffCapsuleV2Hash")(
        evidenceCapsuleWithoutHash,
      ),
    };
    expect(requiredExport("ControlHandoffRecordV2Schema").safeParse({
      schemaVersion: 2,
      kind: "control_handoff_record",
      request: {
        schemaVersion: 2,
        planningBundle: evidenceBundle,
        progress: {
          state: "step_completed",
          completedRefinementStepId: "step.0",
          currentCoordinateId: "repo:file.src-x",
        },
      },
      capsule: completedEvidenceCapsule,
    }).success).toBe(true);
  });

  it("rejects a completed receipt that omits required edit evidence", () => {
    const planningBundle = bundleWithEditEvidence();
    const record = {
      schemaVersion: 2 as const,
      kind: "control_handoff_record" as const,
      request: {
        schemaVersion: 2 as const,
        planningBundle,
        progress: {
          state: "step_completed" as const,
          completedRefinementStepId: "step.0",
          currentCoordinateId: "repo:file.src-x" as const,
        },
      },
      capsule: capsule(planningBundle),
    };
    expect(requiredExport("ControlHandoffRecordV2Schema").safeParse(record).success).toBe(false);
  });

  it("enforces request strictness and capture/resume result status relationships", () => {
    const captureRequest = requiredExport("ControlHandoffCaptureRequestV2Schema");
    const resumeRequest = requiredExport("ControlHandoffResumeRequestV2Schema");
    expect(captureRequest.safeParse({
      schemaVersion: 2,
      planningBundle: bundle(),
      progress: { state: "not_started", currentCoordinateId: "semantic:capability.handoff" },
    }).success).toBe(true);
    expect(captureRequest.safeParse({
      schemaVersion: 2,
      planningBundle: bundle(),
      progress: { state: "not_started", currentCoordinateId: "semantic:capability.handoff", extra: true },
    }).success).toBe(false);
    expect(resumeRequest.safeParse({ schemaVersion: 2, capsuleHash: capsule().capsuleHash }).success).toBe(true);

    const captureResult = requiredExport("ControlHandoffCaptureResultV2Schema");
    expect(captureResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "CAPTURED",
      reasonCodes: [],
      capsule: capsule(),
    }).success).toBe(true);
    expect(captureResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "REFUSED",
      reasonCodes: ["PLANNING_BUNDLE_INVALID"],
      capsule: capsule(),
    }).success).toBe(false);
    expect(captureResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "REFUSED",
      reasonCodes: ["HANDOFF_PERSISTENCE_FAILED"],
      capsule: null,
    }).success).toBe(true);
    expect(captureResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "NO_OP",
      reasonCodes: ["NON_SEMCTX_REPOSITORY"],
      capsule: null,
    }).success).toBe(true);
    expect(captureResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "capture",
      status: "NO_OP",
      reasonCodes: [],
      capsule: capsule(),
    }).success).toBe(false);

    const resumeResult = requiredExport("ControlHandoffResumeResultV2Schema");
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "RESUMED",
      reasonCodes: [],
      capsule: capsule(),
      planningBundle: bundle(),
    }).success).toBe(true);
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "EMPTY",
      reasonCodes: [],
      capsule: null,
      planningBundle: bundle(),
    }).success).toBe(false);
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "EMPTY",
      reasonCodes: ["HANDOFF_NOT_FOUND"],
      capsule: null,
      planningBundle: null,
    }).success).toBe(true);
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "REFUSED",
      reasonCodes: ["HANDOFF_NOT_FOUND"],
      capsule: null,
      planningBundle: null,
    }).success).toBe(false);
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "NO_OP",
      reasonCodes: ["NON_SEMCTX_REPOSITORY"],
      capsule: null,
      planningBundle: null,
    }).success).toBe(true);
    expect(resumeResult.safeParse({
      schemaVersion: 2,
      kind: "control_handoff_result",
      operation: "resume",
      status: "REFUSED",
      reasonCodes: ["HANDOFF_REPOSITORY_MISMATCH"],
      capsule: null,
      planningBundle: null,
    }).success).toBe(true);
  });
});
