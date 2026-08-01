import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  CONTROL_HANDOFF_REASON_CODES,
  ControlHandoffCaptureRequestV2Schema,
  ControlHandoffCaptureResultV2Schema,
  ControlHandoffCapsuleV2Schema,
  ControlHandoffRecordV2Schema,
  ControlHandoffResumeRequestV2Schema,
  ControlHandoffResumeResultV2Schema,
  classifyControlHandoffRefinementStepV2,
  computeControlHandoffDescriptiveRefinementStepIdsV2,
  computeControlHandoffCapsuleV2Hash,
  computeControlHandoffProgressV2Hash,
  type ControlHandoffCaptureRequestV2,
  type ControlHandoffCaptureResultV2,
  type ControlHandoffCapsuleV2,
  type ControlHandoffCoordinateIdV2,
  type ControlHandoffNextTransitionV2,
  type ControlHandoffProgressReceiptV2,
  type ControlHandoffReconciliationReasonCodeV2,
  type ControlHandoffReasonCodeV2,
  type ControlHandoffRecordV2,
  type ControlHandoffResumeResultV2,
} from "@semantic-context/control-model/control-handoff";
import {
  PlanningBundleV1Schema,
  compareCodeUnits,
  type EvidenceEvaluationV1,
  type PlanningBundleV1,
  type QualifiedCoordinateId,
  type ReconcileDiffReportV1,
  type SemanticExpectationV1,
  type SemanticRefinementStepV1,
  type Sha256Hash,
  serializeControlReport,
} from "@semantic-context/control-model/reconciliation";
import { isSemctxError } from "@semantic-context/core";
import { configPath, dbPath, isInitialized } from "@semantic-context/repository-store";
import { controlRepositoryIdentity } from "./freshness";
import {
  captureReconciliationStateToken,
  reconcileWorkingTreeDetailed,
  type DetailedReconciliationSnapshotV1,
} from "./reconciliation-index";

const HANDOFF_V2_RELATIVE_DIR = [".semctx", "working", "handoffs", "v2"] as const;
const LEGACY_HANDOFF_RELATIVE_PATH = [".semctx", "working", "handoff.json"] as const;
const CONTROL_HANDOFF_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/control-handoff-test-hook",
);
const HANDOFF_VIOLATION_REASONS = [
  "SCOPE_ESCAPE",
  "INVARIANT_DRIFT",
  "UNDECLARED_LIFTED_IMPACT",
  "MISSING_PLANNED_EDIT",
  "UNPLANNED_COORDINATE",
  "TARGET_NOT_REALIZED",
] as const;
const HANDOFF_INSUFFICIENCY_REASONS = [
  "BASELINE_NOT_CLEAN",
  "OBSERVATION_ANALYSIS_UNAVAILABLE",
  "REFINEMENT_DISCONNECTED",
  "BUDGET_EXHAUSTED",
  "ROUND_TRIP_UNPROVEN",
  "CONCRETE_EDIT_EXPECTATION_MISSING",
  "OBSERVATION_ANALYSIS_INCOMPLETE",
  "REQUIRED_EVIDENCE_UNSATISFIED",
] as const;

type CapsuleBuildResult =
  | { ok: true; capsule: ControlHandoffCapsuleV2; stateToken: Sha256Hash }
  | { ok: false; reasonCode: ControlHandoffReasonCodeV2 };

type ProgressBuildResult =
  | { ok: true; receipt: ControlHandoffProgressReceiptV2 }
  | { ok: false; reasonCode: ControlHandoffReasonCodeV2 };

export function captureControlHandoffV2(
  root: string,
  request: unknown,
): ControlHandoffCaptureResultV2 {
  if (!hasSemctxMarker(root)) return captureResult("NO_OP", ["NON_SEMCTX_REPOSITORY"]);
  if (!isInitialized(root)) return captureResult("REFUSED", ["SEMCTX_REPOSITORY_UNREADY"]);
  if (!existsSync(dbPath(root))) return captureResult("REFUSED", ["SEMCTX_REPOSITORY_UNREADY"]);

  const parsed = ControlHandoffCaptureRequestV2Schema.safeParse(request);
  if (!parsed.success) return captureResult("REFUSED", ["PLANNING_BUNDLE_INVALID"]);

  const built = buildCapsule(root, parsed.data);
  if (!built.ok) return captureResult("REFUSED", [built.reasonCode]);

  const record: ControlHandoffRecordV2 = ControlHandoffRecordV2Schema.parse({
    schemaVersion: 2,
    kind: "control_handoff_record",
    request: parsed.data,
    capsule: built.capsule,
  });
  const persistence = persistRecord(root, record, built.stateToken);
  if (persistence !== null) return captureResult("REFUSED", [persistence]);
  return captureResult("CAPTURED", [], built.capsule);
}

export function resumeControlHandoffV2(
  root: string,
  request: unknown,
): ControlHandoffResumeResultV2 {
  if (!hasSemctxMarker(root)) return resumeResult("NO_OP", ["NON_SEMCTX_REPOSITORY"]);
  if (!isInitialized(root)) return resumeResult("REFUSED", ["SEMCTX_REPOSITORY_UNREADY"]);
  if (!existsSync(dbPath(root))) return resumeResult("REFUSED", ["SEMCTX_REPOSITORY_UNREADY"]);

  const parsedRequest = ControlHandoffResumeRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return resumeResult("REFUSED", ["HANDOFF_HASH_MISMATCH"]);
  const path = recordPath(root, parsedRequest.data.capsuleHash);
  const safePath = validateRecordPathForRead(root, path);
  if (safePath === "invalid") return resumeResult("REFUSED", ["HANDOFF_RECORD_INVALID"]);
  if (safePath === "missing") {
    const legacyOnly = existsSync(join(root, ...LEGACY_HANDOFF_RELATIVE_PATH));
    return resumeResult("EMPTY", [legacyOnly ? "LEGACY_HANDOFF_ONLY" : "HANDOFF_NOT_FOUND"]);
  }

  const stored = readRecord(root, path);
  if (stored === null) return resumeResult("REFUSED", ["HANDOFF_RECORD_INVALID"]);
  const record = stored.record;
  if (record.capsule.capsuleHash !== parsedRequest.data.capsuleHash) {
    return resumeResult("REFUSED", ["HANDOFF_HASH_MISMATCH"]);
  }
  if (record.capsule.repositoryIdentity !== controlRepositoryIdentity(root)) {
    return resumeResult("REFUSED", ["HANDOFF_REPOSITORY_MISMATCH"]);
  }

  const built = buildCapsule(root, record.request);
  if (!built.ok) {
    return resumeResult(
      "REFUSED",
      [built.reasonCode === "RECONCILIATION_REFUSED" ? "HANDOFF_SEAL_STALE" : built.reasonCode],
    );
  }
  const stale = staleReason(record.capsule, built.capsule);
  if (stale !== null) return resumeResult("REFUSED", [stale]);
  if (built.capsule.capsuleHash !== record.capsule.capsuleHash) {
    return resumeResult("REFUSED", ["HANDOFF_REBUILD_MISMATCH"]);
  }
  runControlHandoffTestHook("before_resume_state_validation", root);
  try {
    if (
      captureReconciliationStateToken(root, record.request.planningBundle)
      !== built.stateToken
    ) return resumeResult("REFUSED", ["CAPTURE_STATE_CHANGED"]);
  } catch {
    return resumeResult("REFUSED", ["CAPTURE_STATE_CHANGED"]);
  }
  return resumeResult("RESUMED", [], built.capsule, record.request.planningBundle);
}

function buildCapsule(root: string, request: ControlHandoffCaptureRequestV2): CapsuleBuildResult {
  const bundle = PlanningBundleV1Schema.parse(request.planningBundle) as PlanningBundleV1;
  let snapshot: DetailedReconciliationSnapshotV1;
  try {
    snapshot = reconcileWorkingTreeDetailed(root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });
  } catch (error) {
    if (isSemctxError(error) || isValidationError(error)) {
      return { ok: false, reasonCode: "RECONCILIATION_REFUSED" };
    }
    throw error;
  }
  if (snapshot.report.terminalStatus === "REFUSED") {
    return { ok: false, reasonCode: "RECONCILIATION_REFUSED" };
  }

  const progress = deriveProgress(request, snapshot);
  if (!progress.ok) return progress;
  const proofsObtained = snapshot.sealedAnalysis.evidenceEvaluations
    .filter((proof) => proof.result === "satisfied")
    .sort((left, right) => compareCodeUnits(proofKey(left), proofKey(right)));
  const touchedCoordinateIds = canonicalStrings(
    snapshot.sealedAnalysis.hunkBindings.flatMap((binding) => binding.coordinateIds),
  ) as QualifiedCoordinateId[];
  const unmappedObservedHunkIds = canonicalStrings(
    snapshot.sealedAnalysis.hunkBindings
      .filter((binding) => binding.coordinateIds.length === 0)
      .map((binding) => binding.hunkId),
  ) as Sha256Hash[];
  const reconciliationReasonCodes = capsuleReconciliationReasons(snapshot.report);
  const nextValidTransition = deriveNextTransition(
    bundle,
    progress.receipt,
    snapshot.report,
    proofsObtained,
  );
  const payload: Omit<ControlHandoffCapsuleV2, "capsuleHash"> = {
    schemaVersion: 2,
    kind: "control_handoff_capsule",
    executionAuthority: "none",
    enforcementMode: "shadow",
    blockingEnabled: false,
    sourceContentCollected: false,
    planningBundleId: bundle.bundleId,
    planningBundleHash: bundle.bundleHash,
    envelopeId: bundle.taskEnvelope.envelopeId,
    envelopeHash: bundle.taskEnvelope.envelopeHash,
    changeSetId: bundle.semanticChangeSet.changeSetId,
    changeSetHash: bundle.semanticChangeSet.changeSetHash,
    planningCommit: bundle.planningCommit,
    descriptiveRefinementStepIds: computeControlHandoffDescriptiveRefinementStepIdsV2(
      bundle.semanticChangeSet,
    ),
    progress: progress.receipt,
    seals: {
      coordinateGraphSeal: bundle.taskEnvelope.coordinateGraphSeal,
      indexSeal: bundle.taskEnvelope.indexSeal,
      baselineFreshnessSeal: bundle.taskEnvelope.baselineFreshnessSeal,
      reconciliationReportHash: snapshot.report.reportHash,
      reconciliationAnalysisHash: snapshot.sealedAnalysis.analysisHash,
      observationAnalysisHash: snapshot.report.observationAnalysis?.analysisHash ?? null,
    },
    repositoryIdentity: controlRepositoryIdentity(root),
    observedCommit: snapshot.report.observedCommit,
    observedWorkingDiffHash: snapshot.report.observedWorkingDiffHash,
    reconciliationTerminalStatus: snapshot.report.terminalStatus,
    reconciliationReasonCodes,
    touchedCoordinateIds,
    unmappedObservedHunkIds,
    proofsObtained,
    nextValidTransition,
  };
  const capsule = ControlHandoffCapsuleV2Schema.parse({
    ...payload,
    capsuleHash: computeControlHandoffCapsuleV2Hash(payload),
  }) as ControlHandoffCapsuleV2;
  return { ok: true, capsule, stateToken: snapshot.stateToken };
}

function deriveProgress(
  request: ControlHandoffCaptureRequestV2,
  snapshot: DetailedReconciliationSnapshotV1,
): ProgressBuildResult {
  const { planningBundle: bundle, progress: pointer } = request;
  const node = snapshot.candidateGraph.nodes.find((candidate) => candidate.id === pointer.currentCoordinateId);
  if (node === undefined) return { ok: false, reasonCode: "PROGRESS_COORDINATE_UNKNOWN" };
  if (node.appliesAtLevel === null) return { ok: false, reasonCode: "PROGRESS_COORDINATE_UNMAPPED" };

  if (pointer.state === "not_started") {
    if (!taskRelevantCoordinateIds(bundle).has(pointer.currentCoordinateId)) {
      return { ok: false, reasonCode: "PROGRESS_COORDINATE_MISMATCH" };
    }
    return {
      ok: true,
      receipt: progressReceipt({
        state: "not_started",
        currentCoordinateId: pointer.currentCoordinateId,
        currentAbstractionLevel: node.appliesAtLevel,
        completedRefinementStep: null,
        matchedRepositoryEditIds: [],
        certifiedExpectationIds: [],
        satisfiedEvidenceRequirementIds: [],
      }),
    };
  }

  const step = bundle.semanticChangeSet.refinementSteps.find(
    (candidate) => candidate.stepId === pointer.completedRefinementStepId,
  );
  if (step === undefined) return { ok: false, reasonCode: "PROGRESS_STEP_UNKNOWN" };
  const matched = new Set(snapshot.report.matchedPlannedEdits.map((item) => item.editId));
  const certified = new Map(
    snapshot.report.certifiedRoundTrips.map((item) => [item.expectationId, item] as const),
  );
  const satisfied = new Set(
    snapshot.sealedAnalysis.evidenceEvaluations
      .filter((evaluation) => evaluation.result === "satisfied")
      .map((evaluation) => evaluation.requirementId),
  );
  const orderedStepsThroughDeclared = [...bundle.semanticChangeSet.refinementSteps]
    .filter((candidate) => candidate.order <= step.order)
    .sort((left, right) => left.order - right.order || compareCodeUnits(left.stepId, right.stepId));
  const contiguous = orderedStepsThroughDeclared.length === step.order + 1
    && orderedStepsThroughDeclared.every((candidate, index) => candidate.order === index);
  const claimedClassification = classifyControlHandoffRefinementStepV2(
    bundle.semanticChangeSet,
    step,
  );
  const allStepsComplete = contiguous
    && claimedClassification === "proof_bearing"
    && snapshot.report.terminalStatus !== "VIOLATED"
    && orderedStepsThroughDeclared.every((candidate) => {
      const classification = classifyControlHandoffRefinementStepV2(
        bundle.semanticChangeSet,
        candidate,
      );
      if (classification === "descriptive") return true;
      if (classification === "legacy_ambiguous") return false;
      const requiredOutputs = requiredStepOutputs(bundle, candidate.toExpectationIds);
      const requiredEvidenceIds = stepEvidenceRequirementIds(
        bundle,
        candidate,
        requiredOutputs,
      );
      return candidate.repositoryEditIds.every((editId) => matched.has(editId))
        && requiredOutputs.every((expectation) => certified.has(expectation.expectationId))
        && requiredEvidenceIds.every((requirementId) => satisfied.has(requirementId));
    });
  if (!allStepsComplete) return { ok: false, reasonCode: "PROGRESS_STEP_NOT_COMPLETE" };

  const outputs = requiredStepOutputs(bundle, step.toExpectationIds);

  const validCoordinates = new Set<ControlHandoffCoordinateIdV2>();
  for (const expectation of outputs) validCoordinates.add(semanticCoordinateId(expectation));
  for (const expectation of outputs) {
    for (const coordinateId of certified.get(expectation.expectationId)?.coordinateIds ?? []) {
      validCoordinates.add(coordinateId);
    }
  }
  const claimedObservedHunkIds = new Set(
    snapshot.report.matchedPlannedEdits
      .filter((match) => step.repositoryEditIds.includes(match.editId))
      .flatMap((match) => match.observedHunkIds),
  );
  for (const binding of snapshot.sealedAnalysis.hunkBindings) {
    if (!claimedObservedHunkIds.has(binding.hunkId)) continue;
    validCoordinates.add(binding.hunkId);
    binding.coordinateIds.forEach((coordinateId) => validCoordinates.add(coordinateId));
  }
  if (
    step.repositoryEditIds.length === 0
    && outputs.length === 0
    && (step.completionEvidenceRequirementIds?.length ?? 0) > 0
  ) {
    taskRelevantCoordinateIds(bundle).forEach((coordinateId) => validCoordinates.add(coordinateId));
  }
  if (!validCoordinates.has(pointer.currentCoordinateId)) {
    return { ok: false, reasonCode: "PROGRESS_COORDINATE_MISMATCH" };
  }
  return {
    ok: true,
    receipt: progressReceipt({
      state: "step_completed",
      currentCoordinateId: pointer.currentCoordinateId,
      currentAbstractionLevel: node.appliesAtLevel,
      completedRefinementStep: { stepId: step.stepId, order: step.order },
      matchedRepositoryEditIds: canonicalStrings(step.repositoryEditIds),
      certifiedExpectationIds: canonicalStrings(outputs.map((item) => item.expectationId)),
      satisfiedEvidenceRequirementIds: stepEvidenceRequirementIds(
        bundle,
        step,
        outputs,
      ).filter((requirementId) => satisfied.has(requirementId)),
    }),
  };
}

function requiredStepOutputs(
  bundle: PlanningBundleV1,
  expectationIds: readonly string[],
): SemanticExpectationV1[] {
  return bundle.semanticChangeSet.semanticExpectations.filter(
    (expectation) => expectationIds.includes(expectation.expectationId) && expectation.required,
  );
}

function stepEvidenceRequirementIds(
  bundle: PlanningBundleV1,
  step: SemanticRefinementStepV1,
  outputs: readonly SemanticExpectationV1[],
): string[] {
  return canonicalStrings([
    ...(step.completionEvidenceRequirementIds ?? []),
    ...outputs.flatMap((expectation) => expectation.acceptanceEvidenceIds),
    ...bundle.semanticChangeSet.repositoryEditExpectations
      .filter((edit) => step.repositoryEditIds.includes(edit.editId))
      .flatMap((edit) => edit.acceptanceEvidenceIds),
  ]);
}

function progressReceipt(
  payload: Omit<ControlHandoffProgressReceiptV2, "progressHash">,
): ControlHandoffProgressReceiptV2 {
  return {
    ...payload,
    progressHash: computeControlHandoffProgressV2Hash(payload),
  };
}

function deriveNextTransition(
  bundle: PlanningBundleV1,
  progress: ControlHandoffProgressReceiptV2,
  report: ReconcileDiffReportV1,
  proofs: readonly EvidenceEvaluationV1[],
): ControlHandoffNextTransitionV2 {
  const reasons = capsuleReconciliationReasons(report);
  const hardViolationReasons = reasons.filter((reason) =>
    reason === "SCOPE_ESCAPE"
    || reason === "INVARIANT_DRIFT"
    || reason === "UNDECLARED_LIFTED_IMPACT"
    || reason === "UNPLANNED_COORDINATE");
  if (hardViolationReasons.length > 0) {
    return { kind: "repair_then_reconcile", reasonCodes: hardViolationReasons };
  }

  const steps = [...bundle.semanticChangeSet.refinementSteps].sort(
    (left, right) => left.order - right.order || compareCodeUnits(left.stepId, right.stepId),
  );
  const next = steps.find((step) =>
    step.order > (progress.completedRefinementStep?.order ?? -1)
    && classifyControlHandoffRefinementStepV2(bundle.semanticChangeSet, step) !== "descriptive");
  if (next !== undefined) return { kind: "refinement_step", stepId: next.stepId, order: next.order };

  if (
    report.terminalStatus === "VIOLATED"
    || reasons.includes("MISSING_PLANNED_EDIT")
    || reasons.includes("CONCRETE_EDIT_EXPECTATION_MISSING")
    || reasons.includes("TARGET_NOT_REALIZED")
  ) return { kind: "repair_then_reconcile", reasonCodes: reasons };

  const satisfied = new Set(proofs.map((proof) => proof.requirementId));
  const unmet = canonicalStrings(report.requiredEvidenceRequirementIds.filter((id) => !satisfied.has(id)));
  if (unmet.length > 0) return { kind: "obtain_proof_then_reconcile", requirementIds: unmet };

  if (report.terminalStatus === "UNPROVEN") {
    return { kind: "repair_then_reconcile", reasonCodes: reasons };
  }
  return { kind: "verify_change" };
}

function capsuleReconciliationReasons(
  report: ReconcileDiffReportV1,
): ControlHandoffReconciliationReasonCodeV2[] {
  const allowed = report.terminalStatus === "VIOLATED"
    ? new Set<string>(HANDOFF_VIOLATION_REASONS)
    : new Set<string>(HANDOFF_INSUFFICIENCY_REASONS);
  return report.reasonCodes.filter(
    (reason): reason is ControlHandoffReconciliationReasonCodeV2 => allowed.has(reason),
  );
}

function taskRelevantCoordinateIds(bundle: PlanningBundleV1): Set<ControlHandoffCoordinateIdV2> {
  const result = new Set<ControlHandoffCoordinateIdV2>(
    bundle.taskEnvelope.resolvedBindings.map((binding) => binding.coordinateId),
  );
  bundle.semanticChangeSet.semanticExpectations.forEach((expectation) =>
    result.add(semanticCoordinateId(expectation)));
  return result;
}

function semanticCoordinateId(expectation: SemanticExpectationV1): QualifiedCoordinateId {
  const subject = expectation.subjectId;
  return /^(repo:|semantic:)/.test(subject)
    ? subject as QualifiedCoordinateId
    : `semantic:${subject}` as QualifiedCoordinateId;
}

function persistRecord(
  root: string,
  record: ControlHandoffRecordV2,
  expectedStateToken: Sha256Hash,
): ControlHandoffReasonCodeV2 | null {
  const target = recordPath(root, record.capsule.capsuleHash);
  const bytes = serializeControlReport(record);
  try {
    ensureSafeHandoffDirectory(root);
  } catch {
    return "HANDOFF_RECORD_INVALID";
  }
  const targetState = validateRecordTarget(root, target);
  if (targetState === "invalid") return "HANDOFF_RECORD_INVALID";
  if (targetState === "file") {
    const existing = readRecord(root, target);
    if (existing === null || existing.bytes !== serializeControlReport(existing.record)) {
      return "HANDOFF_RECORD_INVALID";
    }
    if (existing.bytes !== bytes) return "HANDOFF_HASH_MISMATCH";
    runControlHandoffTestHook("before_state_validation", root);
    try {
      return captureReconciliationStateToken(root, record.request.planningBundle) === expectedStateToken
        ? null
        : "CAPTURE_STATE_CHANGED";
    } catch {
      return "CAPTURE_STATE_CHANGED";
    }
  }

  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | null = null;
  const cleanupTemporary = () => {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The caller reports the originating persistence failure.
      }
      descriptor = null;
    }
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  };
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    if (!fstatSync(descriptor).isFile()) throw new Error("handoff temporary path is not a file");
    writeAll(descriptor, new TextEncoder().encode(bytes));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
  } catch {
    cleanupTemporary();
    return "HANDOFF_PERSISTENCE_FAILED";
  }

  try {
    runControlHandoffTestHook("before_state_validation", root);
    const currentStateToken = captureReconciliationStateToken(root, record.request.planningBundle);
    if (currentStateToken !== expectedStateToken) {
      cleanupTemporary();
      return "CAPTURE_STATE_CHANGED";
    }
  } catch {
    cleanupTemporary();
    return "CAPTURE_STATE_CHANGED";
  }

  try {
    ensureSafeHandoffDirectory(root);
  } catch {
    cleanupTemporary();
    return "HANDOFF_RECORD_INVALID";
  }
  if (validateRecordTarget(root, target) !== "missing") {
    cleanupTemporary();
    return "HANDOFF_RECORD_INVALID";
  }

  try {
    linkSync(temporary, target);
  } catch {
    cleanupTemporary();
    return "HANDOFF_PERSISTENCE_FAILED";
  }

  try {
    runControlHandoffTestHook("after_publish_before_validation", root);
    if (validateRecordTarget(root, target) !== "file") return "HANDOFF_RECORD_INVALID";
    const published = readRecord(root, target);
    if (published === null || published.bytes !== bytes) return "HANDOFF_RECORD_INVALID";
    return null;
  } finally {
    if (
      existsSync(temporary)
      && existsSync(target)
      && stillSameFile(temporary, target)
      && readRecord(root, target)?.bytes !== bytes
    ) rmSync(target, { force: true });
    cleanupTemporary();
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (written <= 0) throw new Error("handoff record write made no progress");
    offset += written;
  }
}

function stillSameFile(leftPath: string, rightPath: string): boolean {
  let left: number | null = null;
  let right: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    left = openSync(leftPath, constants.O_RDONLY | noFollow);
    right = openSync(rightPath, constants.O_RDONLY | noFollow);
    const leftStat = fstatSync(left, { bigint: true });
    const rightStat = fstatSync(right, { bigint: true });
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  } finally {
    if (right !== null) closeSync(right);
    if (left !== null) closeSync(left);
  }
}

function readRecord(
  root: string,
  path: string,
): { record: ControlHandoffRecordV2; bytes: string } | null {
  let descriptor: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile() || validateRecordTarget(root, path) !== "file") return null;
    const pathStat = lstatSync(path);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) return null;
    const bytes = readFileSync(descriptor, "utf8");
    const parsed = JSON.parse(bytes) as unknown;
    const result = ControlHandoffRecordV2Schema.safeParse(parsed);
    return result.success && serializeControlReport(result.data) === bytes
      ? { record: result.data, bytes }
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function staleReason(
  stored: ControlHandoffCapsuleV2,
  rebuilt: ControlHandoffCapsuleV2,
): ControlHandoffReasonCodeV2 | null {
  if (stored.repositoryIdentity !== rebuilt.repositoryIdentity) return "HANDOFF_REPOSITORY_MISMATCH";
  if (stored.observedCommit !== rebuilt.observedCommit) return "HANDOFF_HEAD_STALE";
  if (stored.observedWorkingDiffHash !== rebuilt.observedWorkingDiffHash) return "HANDOFF_DIFF_STALE";
  if (
    stored.seals.coordinateGraphSeal !== rebuilt.seals.coordinateGraphSeal
    || stored.seals.indexSeal !== rebuilt.seals.indexSeal
    || stored.seals.baselineFreshnessSeal !== rebuilt.seals.baselineFreshnessSeal
  ) return "HANDOFF_SEAL_STALE";
  return null;
}

function recordPath(root: string, capsuleHash: Sha256Hash): string {
  return join(root, ...HANDOFF_V2_RELATIVE_DIR, `${capsuleHash.slice("sha256:".length)}.json`);
}

function ensureSafeHandoffDirectory(root: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  let current = resolve(root);
  for (const component of HANDOFF_V2_RELATIVE_DIR) {
    current = join(current, component);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe handoff directory");
    assertContained(canonicalRoot, realpathSync.native(current));
  }
}

function validateRecordPathForRead(
  root: string,
  target: string,
): "file" | "missing" | "invalid" {
  try {
    const canonicalRoot = realpathSync.native(resolve(root));
    let current = resolve(root);
    for (const component of HANDOFF_V2_RELATIVE_DIR) {
      current = join(current, component);
      if (!existsSync(current)) return "missing";
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid";
      assertContained(canonicalRoot, realpathSync.native(current));
    }
    return validateRecordTarget(root, target);
  } catch {
    return "invalid";
  }
}

function validateRecordTarget(
  root: string,
  target: string,
): "file" | "missing" | "invalid" {
  try {
    if (!existsSync(target)) return "missing";
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return "invalid";
    assertContained(realpathSync.native(resolve(root)), realpathSync.native(target));
    return "file";
  } catch {
    return "invalid";
  }
}

function assertContained(root: string, path: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new Error("handoff path escapes repository");
}

function canonicalStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function proofKey(proof: EvidenceEvaluationV1): string {
  return `${proof.requirementId}\0${proof.origin}`;
}

function captureResult(
  status: ControlHandoffCaptureResultV2["status"],
  reasonCodes: readonly ControlHandoffReasonCodeV2[],
  capsule: ControlHandoffCapsuleV2 | null = null,
): ControlHandoffCaptureResultV2 {
  return ControlHandoffCaptureResultV2Schema.parse({
    schemaVersion: 2,
    kind: "control_handoff_result",
    operation: "capture",
    status,
    reasonCodes: canonicalHandoffReasons(reasonCodes),
    capsule,
  }) as ControlHandoffCaptureResultV2;
}

function resumeResult(
  status: ControlHandoffResumeResultV2["status"],
  reasonCodes: readonly ControlHandoffReasonCodeV2[],
  capsule: ControlHandoffCapsuleV2 | null = null,
  planningBundle: PlanningBundleV1 | null = null,
): ControlHandoffResumeResultV2 {
  return ControlHandoffResumeResultV2Schema.parse({
    schemaVersion: 2,
    kind: "control_handoff_result",
    operation: "resume",
    status,
    reasonCodes: canonicalHandoffReasons(reasonCodes),
    capsule,
    planningBundle,
  }) as ControlHandoffResumeResultV2;
}

function canonicalHandoffReasons(
  reasons: readonly ControlHandoffReasonCodeV2[],
): ControlHandoffReasonCodeV2[] {
  return [...new Set(reasons)].sort(
    (left, right) => CONTROL_HANDOFF_REASON_CODES.indexOf(left) - CONTROL_HANDOFF_REASON_CODES.indexOf(right),
  );
}

function hasSemctxMarker(root: string): boolean {
  return existsSync(configPath(root)) || existsSync(join(root, ".semctx", "semantic"));
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

function runControlHandoffTestHook(
  stage:
    | "before_state_validation"
    | "before_resume_state_validation"
    | "after_publish_before_validation",
  root: string,
): void {
  const hook = (globalThis as {
    [CONTROL_HANDOFF_TEST_HOOK]?: (
      stage:
        | "before_state_validation"
        | "before_resume_state_validation"
        | "after_publish_before_validation",
      root: string,
    ) => void;
  })[CONTROL_HANDOFF_TEST_HOOK];
  hook?.(stage, root);
}
