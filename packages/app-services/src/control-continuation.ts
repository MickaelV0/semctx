import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import {
  compareControlContinuationDependenciesV1,
  type ControlContinuationDependencyFixtureV1,
} from "@semantic-context/control-engine";
import {
  CONTROL_CONTINUATION_SECTION_KEYS,
  ControlContinuationExplainRequestV1Schema,
  ControlContinuationExplainResultV1Schema,
  computeControlContinuationReportV1Hash,
  type ControlContinuationExplainResultV1,
  type ControlContinuationFreshnessVerdictV1,
  type ControlContinuationRefusalReasonV1,
  type ControlContinuationReportV1,
  type ControlContinuationSectionKeyV1,
  type ControlContinuationSectionsV1,
  type ControlContinuationStatementV1,
} from "@semantic-context/control-model/control-continuation";
import {
  ControlHandoffRecordV2Schema,
  RECONCILIATION_INSUFFICIENCY_REASONS,
  RECONCILIATION_VIOLATION_REASONS,
  type ControlHandoffCapsuleV2,
  type ControlHandoffNextTransitionV2,
  type ControlHandoffRecordV2,
} from "@semantic-context/control-model/control-handoff";
import {
  compareCodeUnits,
  serializeControlReport,
  type PlanningBundleV1,
  type RepositoryEditExpectationV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";
import { controlStatus } from "./control";
import { recordPath, validateRecordPathForRead } from "./control-handoff";
import { controlRepositoryIdentity } from "./freshness";
import { captureObservedWorkingDiffHashV1 } from "./reconciliation-index";
import { captureVerificationGitState } from "./verification-state";

const RAW_READ_LIMIT_BYTES = 1 * 1024 * 1024;
const SERIALIZED_BUDGET_BYTES = 64 * 1024;
const CONTROL_CONTINUATION_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/control-continuation-test-hook",
);
const TRUNCATABLE_SECTION_KEYS: readonly ControlContinuationSectionKeyV1[] = [
  "objective",
  "declaredDecisions",
  "declaredNonGoals",
  "expectedChanges",
  "observedChanges",
];

type ExplainOutcome =
  | { ok: true; report: ControlContinuationReportV1 }
  | { ok: false; reasonCode: ControlContinuationRefusalReasonV1 };

/**
 * Explain one intact Control Handoff v2 capsule: its historical planning context plus
 * dependency-by-dependency current applicability. Never mutates the capsule, never
 * initializes/indexes/records anything, and grants no execution authority.
 */
export function explainControlHandoffV2(
  root: string,
  request: unknown,
  capturedAt: string = new Date().toISOString(),
): ControlContinuationExplainResultV1 {
  const outcome = buildExplainOutcome(root, request, capturedAt);
  return ControlContinuationExplainResultV1Schema.parse(
    outcome.ok
      ? {
          schemaVersion: 1,
          kind: "control_continuation_result",
          operation: "explain",
          status: "EXPLAINED",
          reasonCode: null,
          report: outcome.report,
        }
      : {
          schemaVersion: 1,
          kind: "control_continuation_result",
          operation: "explain",
          status: "REFUSED",
          reasonCode: outcome.reasonCode,
          report: null,
        },
  ) as ControlContinuationExplainResultV1;
}

function buildExplainOutcome(root: string, request: unknown, capturedAt: string): ExplainOutcome {
  const parsedRequest = ControlContinuationExplainRequestV1Schema.safeParse(request);
  if (!parsedRequest.success) return { ok: false, reasonCode: "ARTIFACT_INVALID" };

  const read = readHandoffRecordForContinuation(root, parsedRequest.data.capsuleHash);
  if (!read.ok) return read;
  const capsule = read.record.capsule;
  const bundle = read.record.request.planningBundle;

  const currentRepositoryIdentity = controlRepositoryIdentity(root);
  if (capsule.repositoryIdentity !== currentRepositoryIdentity) {
    return { ok: false, reasonCode: "WRONG_REPOSITORY" };
  }

  const beforeGitIdentity = captureCurrentGitIdentityV1(root);
  runControlContinuationTestHook("after_initial_git_identity_capture", root);

  let indexFreshnessVerdict: ControlContinuationFreshnessVerdictV1;
  let currentFreshnessSealHash: Sha256Hash | null;
  try {
    const status = controlStatus(root);
    indexFreshnessVerdict = status.verdict;
    currentFreshnessSealHash = status.freshnessSeal?.sealHash ?? null;
  } catch {
    indexFreshnessVerdict = "UNSEALED";
    currentFreshnessSealHash = null;
  }

  const afterGitIdentity = captureCurrentGitIdentityV1(root);
  const gitCaptureStable = beforeGitIdentity.headCommit !== null
    && beforeGitIdentity.headCommit === afterGitIdentity.headCommit
    && beforeGitIdentity.observedWorkingDiffHash !== null
    && beforeGitIdentity.observedWorkingDiffHash === afterGitIdentity.observedWorkingDiffHash
    && beforeGitIdentity.repositoryStateHash !== null
    && beforeGitIdentity.repositoryStateHash === afterGitIdentity.repositoryStateHash
    && beforeGitIdentity.indexStateHash !== null
    && beforeGitIdentity.indexStateHash === afterGitIdentity.indexStateHash;
  const headCommit = gitCaptureStable ? afterGitIdentity.headCommit : null;
  const workingDiffHash = gitCaptureStable ? afterGitIdentity.observedWorkingDiffHash : null;
  if (!gitCaptureStable) {
    indexFreshnessVerdict = "UNSEALED";
    currentFreshnessSealHash = null;
  }

  const dependencies = compareControlContinuationDependenciesV1(buildDependencyFixtures({
    capsule,
    currentRepositoryIdentity,
    headCommit,
    workingDiffHash,
    gitCaptureStable,
    indexFreshnessVerdict,
    currentFreshnessSealHash,
  }));

  const sections = buildSections(bundle, capsule);
  const fitted = fitSectionsToBudget({
    schemaVersion: 1,
    kind: "control_continuation_report",
    executionAuthority: "none",
    enforcementMode: "shadow",
    blockingEnabled: false,
    sourceContentCollected: false,
    gateAdmission: "NOT_EVALUATED",
    requestedCapsuleHash: parsedRequest.data.capsuleHash,
    historicalSource: {
      repositoryIdentity: capsule.repositoryIdentity,
      observedCommit: capsule.observedCommit,
      observedWorkingDiffHash: capsule.observedWorkingDiffHash,
      planningCommit: capsule.planningCommit,
      planningBundleHash: capsule.planningBundleHash,
      envelopeHash: capsule.envelopeHash,
      changeSetHash: capsule.changeSetHash,
      baselineFreshnessSealHash: capsule.seals.baselineFreshnessSeal,
    },
    currentCapture: {
      repositoryIdentity: currentRepositoryIdentity,
      headCommit,
      workingDiffHash,
      indexFreshnessVerdict,
      currentFreshnessSealHash,
    },
    captureTime: capturedAt,
    sections,
    dependencies,
  });
  if (!fitted.ok) return { ok: false, reasonCode: "BUDGET_EXCEEDED" };
  return { ok: true, report: fitted.report };
}

function readHandoffRecordForContinuation(
  root: string,
  capsuleHash: Sha256Hash,
): { ok: true; record: ControlHandoffRecordV2 }
  | { ok: false; reasonCode: ControlContinuationRefusalReasonV1 } {
  const path = recordPath(root, capsuleHash);
  const safePath = validateRecordPathForRead(root, path);
  if (safePath === "missing") return { ok: false, reasonCode: "ARTIFACT_MISSING" };
  if (safePath === "invalid") return { ok: false, reasonCode: "ARTIFACT_INVALID" };

  let descriptor: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile()) return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    const pathStat = lstatSync(path);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    }
    const boundedContent = readBoundedDescriptor(descriptor, RAW_READ_LIMIT_BYTES);
    if (boundedContent === null) return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    const bytes = boundedContent.toString("utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bytes);
    } catch {
      return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    }
    if (
      typeof parsedJson === "object"
      && parsedJson !== null
      && "schemaVersion" in parsedJson
      && (parsedJson as { schemaVersion?: unknown }).schemaVersion !== 2
    ) {
      return { ok: false, reasonCode: "UNSUPPORTED_VERSION" };
    }
    const parsedRecord = ControlHandoffRecordV2Schema.safeParse(parsedJson);
    if (!parsedRecord.success) return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    if (serializeControlReport(parsedRecord.data) !== bytes) {
      return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    }
    if (parsedRecord.data.capsule.capsuleHash !== capsuleHash) {
      return { ok: false, reasonCode: "ARTIFACT_INVALID" };
    }
    return { ok: true, record: parsedRecord.data };
  } catch {
    return { ok: false, reasonCode: "ARTIFACT_INVALID" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Read at most `limitBytes` from an already-opened descriptor using positional reads, never
 * trusting a prior `fstat` size. Returns null when the descriptor yields more than `limitBytes`
 * (a concurrently growing file included) so a caller can refuse rather than read unbounded bytes.
 */
function readBoundedDescriptor(descriptor: number, limitBytes: number): Buffer | null {
  const buffer = Buffer.alloc(limitBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > limitBytes) return null;
  return buffer.subarray(0, offset);
}

interface CurrentGitIdentityV1 {
  headCommit: string | null;
  observedWorkingDiffHash: Sha256Hash | null;
  repositoryStateHash: string | null;
  indexStateHash: string | null;
}

/**
 * Capture source and staging identities for the surrounding stability comparison. The separate
 * index hash detects staging-only changes that preserve both HEAD and working-tree bytes.
 */
function captureCurrentGitIdentityV1(root: string): CurrentGitIdentityV1 {
  try {
    const state = captureVerificationGitState(root);
    return {
      headCommit: state.headCommit,
      observedWorkingDiffHash: captureObservedWorkingDiffHashV1(root),
      repositoryStateHash: state.repositoryStateHash,
      indexStateHash: state.indexStateHash,
    };
  } catch {
    return { headCommit: null, observedWorkingDiffHash: null, repositoryStateHash: null, indexStateHash: null };
  }
}

function runControlContinuationTestHook(
  stage: "after_initial_git_identity_capture",
  root: string,
): void {
  const target = globalThis as {
    [CONTROL_CONTINUATION_TEST_HOOK]?: (
      stage: "after_initial_git_identity_capture",
      root: string,
    ) => void;
  };
  const hook = target[CONTROL_CONTINUATION_TEST_HOOK];
  if (hook === undefined) return;
  delete target[CONTROL_CONTINUATION_TEST_HOOK];
  hook(stage, root);
}

function buildDependencyFixtures(input: {
  capsule: ControlHandoffCapsuleV2;
  currentRepositoryIdentity: string;
  headCommit: string | null;
  workingDiffHash: Sha256Hash | null;
  gitCaptureStable: boolean;
  indexFreshnessVerdict: ControlContinuationFreshnessVerdictV1;
  currentFreshnessSealHash: Sha256Hash | null;
}): ControlContinuationDependencyFixtureV1[] {
  const { capsule } = input;
  const unstableGitReason = input.gitCaptureStable ? "DEPENDENCY_UNREADABLE" : "CURRENT_STATE_CHANGED";
  const semanticIndexCurrentlyReadable = input.gitCaptureStable
    && (input.indexFreshnessVerdict === "FRESH" || input.indexFreshnessVerdict === "DIRTY_KNOWN");
  return [
    {
      obligation: "repository_identity_binding",
      scope: "repository",
      dependencyKind: "repository_identity",
      baselineRef: capsule.repositoryIdentity,
      currentRef: input.currentRepositoryIdentity,
      provenance: "historically_observed",
      comparison: "match_required",
    },
    {
      obligation: "worktree_identity_binding",
      scope: "repository",
      dependencyKind: "worktree_identity",
      baselineRef: null,
      currentRef: null,
      provenance: "historically_observed",
      comparison: "always_unknown",
      unknownReason: "DEPENDENCY_UNVERIFIED",
    },
    {
      obligation: "source_commit_binding",
      scope: "repository",
      dependencyKind: "source_commit",
      baselineRef: capsule.observedCommit,
      currentRef: input.headCommit,
      provenance: "historically_observed",
      comparison: "match_required",
      unknownReason: unstableGitReason,
      changedReason: "CHANGED",
    },
    {
      obligation: "working_diff_binding",
      scope: "repository",
      dependencyKind: "diff",
      baselineRef: capsule.observedWorkingDiffHash,
      currentRef: input.workingDiffHash,
      provenance: "historically_observed",
      comparison: "match_required",
      unknownReason: unstableGitReason,
      changedReason: "CHANGED",
    },
    semanticIndexCurrentlyReadable
      ? {
          obligation: "semantic_index_input_binding",
          scope: "repository",
          dependencyKind: "semantic_index_inputs",
          baselineRef: capsule.seals.baselineFreshnessSeal,
          currentRef: input.currentFreshnessSealHash,
          provenance: "historically_observed",
          comparison: "match_required",
          unknownReason: "DEPENDENCY_UNREADABLE",
          changedReason: "CHANGED",
        }
      : {
          obligation: "semantic_index_input_binding",
          scope: "repository",
          dependencyKind: "semantic_index_inputs",
          baselineRef: capsule.seals.baselineFreshnessSeal,
          currentRef: null,
          provenance: "historically_observed",
          comparison: "always_unknown",
          unknownReason: input.gitCaptureStable ? "DEPENDENCY_UNVERIFIED" : "CURRENT_STATE_CHANGED",
        },
    ...(["producer_tool", "configuration", "environment", "policy", "expiry"] as const).map(
      (dependencyKind) => ({
        obligation: `evidence_${dependencyKind}_binding`,
        scope: "evidence" as const,
        dependencyKind,
        baselineRef: null,
        currentRef: null,
        provenance: "declared" as const,
        comparison: "always_unknown" as const,
        unknownReason: "DEPENDENCY_MISSING" as const,
      }),
    ),
  ];
}

function buildSections(
  bundle: PlanningBundleV1,
  capsule: ControlHandoffCapsuleV2,
): ControlContinuationSectionsV1 {
  const artifact = capsule.capsuleHash;
  const expectations = [...bundle.semanticChangeSet.semanticExpectations].sort(
    (left, right) => compareCodeUnits(left.expectationId, right.expectationId),
  );
  const statement = (
    text: string,
    provenance: ControlContinuationStatementV1["provenance"],
    sourceField: string,
  ): ControlContinuationStatementV1 => ({ text, provenance, sourceArtifactHash: artifact, sourceField });

  const objective = expectations
    .filter((expectation) => expectation.kind === "goal")
    .map((expectation) =>
      statement(
        expectation.statement,
        "declared",
        `semanticChangeSet.semanticExpectations[${expectation.expectationId}].statement`,
      ));

  const declaredDecisions = [
    ...expectations
      .filter((expectation) =>
        expectation.required
        && (expectation.kind === "capability" || expectation.kind === "contract"))
      .map((expectation) =>
        statement(
          expectation.statement,
          "declared",
          `semanticChangeSet.semanticExpectations[${expectation.expectationId}].statement`,
        )),
    ...bundle.taskEnvelope.compatibilityNotes.map((note, index) =>
      statement(note, "declared", `taskEnvelope.compatibilityNotes[${index}]`)),
  ];

  const declaredNonGoals = [
    ...bundle.taskEnvelope.nonGoals.map((nonGoal, index) =>
      statement(nonGoal, "declared", `taskEnvelope.nonGoals[${index}]`)),
    ...(bundle.taskEnvelope.taskFrameSnapshot.descriptiveNonGoals ?? []).map((nonGoal, index) =>
      statement(
        nonGoal,
        "declared",
        `taskEnvelope.taskFrameSnapshot.descriptiveNonGoals[${index}]`,
      )),
  ];

  const expectedChanges = [
    ...bundle.taskEnvelope.expectedBehaviorDelta.map((delta, index) =>
      statement(delta, "declared", `taskEnvelope.expectedBehaviorDelta[${index}]`)),
    ...[...bundle.semanticChangeSet.repositoryEditExpectations]
      .sort((left, right) => compareCodeUnits(left.editId, right.editId))
      .map((edit) =>
        statement(
          `${edit.kind} ${editExpectationPath(edit)}`,
          "declared",
          `semanticChangeSet.repositoryEditExpectations[${edit.editId}]`,
        )),
  ];

  const observedChanges = [
    ...capsule.reconciliationReasonCodes.map((code, index) =>
      statement(
        `reconciliation reason: ${code}`,
        "historically_observed",
        `capsule.reconciliationReasonCodes[${index}]`,
      )),
    ...capsule.touchedCoordinateIds.map((coordinateId, index) =>
      statement(
        `touched coordinate: ${coordinateId}`,
        "historically_observed",
        `capsule.touchedCoordinateIds[${index}]`,
      )),
  ];

  const violationCodes = new Set<string>(RECONCILIATION_VIOLATION_REASONS);
  const insufficiencyCodes = new Set<string>(RECONCILIATION_INSUFFICIENCY_REASONS);

  const risks = [
    ...expectations
      .filter((expectation) => expectation.kind === "invariant")
      .map((expectation) =>
        statement(
          expectation.statement,
          "declared",
          `semanticChangeSet.semanticExpectations[${expectation.expectationId}].statement`,
        )),
    ...capsule.reconciliationReasonCodes
      .flatMap((code, index) => violationCodes.has(code) ? [statement(
          `violation risk: ${code}`,
          "historically_observed",
          `capsule.reconciliationReasonCodes[${index}]`,
        )] : []),
  ];

  const missingEvidence = [
    ...(capsule.nextValidTransition.kind === "obtain_proof_then_reconcile"
      ? capsule.nextValidTransition.requirementIds.map((requirementId, index) =>
        statement(
          `unresolved evidence requirement: ${requirementId}`,
          "historically_observed",
          `capsule.nextValidTransition.requirementIds[${index}]`,
        ))
      : []),
    ...capsule.reconciliationReasonCodes
      .flatMap((code, index) => insufficiencyCodes.has(code) ? [statement(
          `insufficiency: ${code}`,
          "historically_observed",
          `capsule.reconciliationReasonCodes[${index}]`,
        )] : []),
  ];

  const nextChecks = [nextCheckStatement(capsule.nextValidTransition, artifact)];

  return {
    objective,
    declaredDecisions,
    declaredNonGoals,
    expectedChanges,
    observedChanges,
    risks,
    missingEvidence,
    nextChecks,
  };
}

function editExpectationPath(edit: RepositoryEditExpectationV1): string {
  if (edit.kind === "add") return edit.newPath;
  if (edit.kind === "modify") return edit.path;
  if (edit.kind === "delete") return edit.oldPath;
  return `${edit.oldPath} -> ${edit.newPath}`;
}

function nextCheckStatement(
  transition: ControlHandoffNextTransitionV2,
  artifact: Sha256Hash,
): ControlContinuationStatementV1 {
  if (transition.kind === "refinement_step") {
    return {
      text: `complete refinement step ${transition.stepId} (order ${transition.order})`,
      provenance: "historically_observed",
      sourceArtifactHash: artifact,
      sourceField: "capsule.nextValidTransition.stepId",
    };
  }
  if (transition.kind === "repair_then_reconcile") {
    return {
      text: `repair and reconcile: ${transition.reasonCodes.join(", ")}`,
      provenance: "historically_observed",
      sourceArtifactHash: artifact,
      sourceField: "capsule.nextValidTransition.reasonCodes",
    };
  }
  if (transition.kind === "obtain_proof_then_reconcile") {
    return {
      text: `obtain proof for: ${transition.requirementIds.join(", ")}`,
      provenance: "historically_observed",
      sourceArtifactHash: artifact,
      sourceField: "capsule.nextValidTransition.requirementIds",
    };
  }
  return {
    text: "run verify_change",
    provenance: "historically_observed",
    sourceArtifactHash: artifact,
    sourceField: "capsule.nextValidTransition.kind",
  };
}

function fitSectionsToBudget(
  base: Omit<ControlContinuationReportV1, "reportHash" | "completeness" | "omittedSectionCounts">,
): { ok: true; report: ControlContinuationReportV1 } | { ok: false } {
  const omittedSectionCounts: Record<ControlContinuationSectionKeyV1, number> = Object.fromEntries(
    CONTROL_CONTINUATION_SECTION_KEYS.map((key) => [key, 0]),
  ) as Record<ControlContinuationSectionKeyV1, number>;
  const sections: Record<ControlContinuationSectionKeyV1, ControlContinuationStatementV1[]> = {
    objective: [...base.sections.objective],
    declaredDecisions: [...base.sections.declaredDecisions],
    declaredNonGoals: [...base.sections.declaredNonGoals],
    expectedChanges: [...base.sections.expectedChanges],
    observedChanges: [...base.sections.observedChanges],
    risks: [...base.sections.risks],
    missingEvidence: [...base.sections.missingEvidence],
    nextChecks: [...base.sections.nextChecks],
  };

  const build = (): ControlContinuationReportV1 => {
    const completeness: "complete" | "partial" = CONTROL_CONTINUATION_SECTION_KEYS.some(
      (key) => omittedSectionCounts[key] > 0,
    ) ? "partial" : "complete";
    const payload = {
      ...base,
      completeness,
      sections,
      omittedSectionCounts,
    };
    return { ...payload, reportHash: computeControlContinuationReportV1Hash(payload) };
  };

  let report = build();
  if (byteLength(serializeControlReport(report)) <= SERIALIZED_BUDGET_BYTES) {
    return { ok: true, report };
  }

  while (
    TRUNCATABLE_SECTION_KEYS.some((key) => sections[key].length > 0)
    && byteLength(serializeControlReport(report)) > SERIALIZED_BUDGET_BYTES
  ) {
    const largestKey = [...TRUNCATABLE_SECTION_KEYS].sort(
      (left, right) => sections[right].length - sections[left].length,
    )[0]!;
    if (sections[largestKey].length === 0) break;
    sections[largestKey] = sections[largestKey].slice(0, -1);
    omittedSectionCounts[largestKey] += 1;
    report = build();
  }

  if (byteLength(serializeControlReport(report)) > SERIALIZED_BUDGET_BYTES) return { ok: false };
  return { ok: true, report };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
