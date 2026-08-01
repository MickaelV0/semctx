import { z } from "zod";
import { serializeControlReport } from "./canonical";
import { sha256HashUtf8 } from "./hashing";
import { compareCodeUnits } from "./ordering";
import { Sha256HashSchema } from "./primitive-schemas";
import { QualifiedCoordinateIdSchema, SemanticLevelSchema } from "./schemas";
import {
  EvidenceEvaluationV1Schema,
  PlanningBundleV1Schema,
  ReconciliationReasonCodeV1Schema,
} from "./task-envelope-schemas";
import {
  RECONCILIATION_INSUFFICIENCY_REASONS,
  RECONCILIATION_VIOLATION_REASONS,
  type EvidenceEvaluationV1,
  type PlanningBundleV1,
  type ReconciliationReasonCodeV1,
  type SemanticChangeSetV1,
  type SemanticRefinementStepV1,
} from "./task-envelope-types";
import type { QualifiedCoordinateId, SemanticLevel, Sha256Hash } from "./types";

const PROGRESS_HASH_DOMAIN = "SEMCTX_CONTROL_HANDOFF_PROGRESS_V2\0";
const CAPSULE_HASH_DOMAIN = "SEMCTX_CONTROL_HANDOFF_CAPSULE_V2\0";
const NonEmptyStringSchema = z.string().min(1);

export const CONTROL_HANDOFF_REASON_CODES = [
  "NON_SEMCTX_REPOSITORY",
  "SEMCTX_REPOSITORY_UNREADY",
  "PLANNING_BUNDLE_INVALID",
  "PROGRESS_STEP_UNKNOWN",
  "PROGRESS_STEP_NOT_COMPLETE",
  "PROGRESS_COORDINATE_UNKNOWN",
  "PROGRESS_COORDINATE_UNMAPPED",
  "PROGRESS_COORDINATE_MISMATCH",
  "RECONCILIATION_REFUSED",
  "CAPTURE_STATE_CHANGED",
  "HANDOFF_NOT_FOUND",
  "LEGACY_HANDOFF_ONLY",
  "HANDOFF_RECORD_INVALID",
  "HANDOFF_PERSISTENCE_FAILED",
  "HANDOFF_HASH_MISMATCH",
  "HANDOFF_REPOSITORY_MISMATCH",
  "HANDOFF_HEAD_STALE",
  "HANDOFF_DIFF_STALE",
  "HANDOFF_SEAL_STALE",
  "HANDOFF_REBUILD_MISMATCH",
] as const;

export type ControlHandoffReasonCodeV2 = typeof CONTROL_HANDOFF_REASON_CODES[number];
export type ControlHandoffReconciliationReasonCodeV2 =
  | typeof RECONCILIATION_VIOLATION_REASONS[number]
  | typeof RECONCILIATION_INSUFFICIENCY_REASONS[number];

export type ControlHandoffCoordinateIdV2 = QualifiedCoordinateId | Sha256Hash;

export type ControlHandoffRefinementStepClassificationV2 =
  | "proof_bearing"
  | "descriptive"
  | "legacy_ambiguous";

export function classifyControlHandoffRefinementStepV2(
  changeSet: SemanticChangeSetV1,
  step: SemanticRefinementStepV1,
): ControlHandoffRefinementStepClassificationV2 {
  const hasRequiredOutput = step.toExpectationIds.some((expectationId) =>
    changeSet.semanticExpectations.some(
      (expectation) => expectation.expectationId === expectationId && expectation.required,
    ));
  if (
    step.repositoryEditIds.length > 0
    || hasRequiredOutput
    || (step.completionEvidenceRequirementIds?.length ?? 0) > 0
  ) return "proof_bearing";
  if (step.completionEvidenceRequirementIds !== undefined) return "descriptive";
  return "legacy_ambiguous";
}

export function computeControlHandoffDescriptiveRefinementStepIdsV2(
  changeSet: SemanticChangeSetV1,
): readonly string[] {
  return [...changeSet.refinementSteps]
    .sort((left, right) => left.order - right.order || compareCodeUnits(left.stepId, right.stepId))
    .filter((step) => classifyControlHandoffRefinementStepV2(changeSet, step) === "descriptive")
    .map((step) => step.stepId);
}

export type ControlHandoffProgressPointerV2 =
  | { state: "not_started"; currentCoordinateId: ControlHandoffCoordinateIdV2 }
  | {
      state: "step_completed";
      completedRefinementStepId: string;
      currentCoordinateId: ControlHandoffCoordinateIdV2;
    };

export interface ControlHandoffCaptureRequestV2 {
  schemaVersion: 2;
  planningBundle: PlanningBundleV1;
  progress: ControlHandoffProgressPointerV2;
}

export interface ControlHandoffResumeRequestV2 {
  schemaVersion: 2;
  capsuleHash: Sha256Hash;
}

export type ControlHandoffProgressReceiptV2 = {
  state: "not_started" | "step_completed";
  currentCoordinateId: ControlHandoffCoordinateIdV2;
  currentAbstractionLevel: SemanticLevel;
  completedRefinementStep: { stepId: string; order: number } | null;
  matchedRepositoryEditIds: readonly string[];
  certifiedExpectationIds: readonly string[];
  satisfiedEvidenceRequirementIds: readonly string[];
  progressHash: Sha256Hash;
};

export type ControlHandoffNextTransitionV2 =
  | { kind: "refinement_step"; stepId: string; order: number }
  | {
      kind: "repair_then_reconcile";
      reasonCodes: readonly ControlHandoffReconciliationReasonCodeV2[];
    }
  | { kind: "obtain_proof_then_reconcile"; requirementIds: readonly string[] }
  | { kind: "verify_change" };

export interface ControlHandoffCapsuleV2 {
  schemaVersion: 2;
  kind: "control_handoff_capsule";
  executionAuthority: "none";
  enforcementMode: "shadow";
  blockingEnabled: false;
  sourceContentCollected: false;
  planningBundleId: string;
  planningBundleHash: Sha256Hash;
  envelopeId: string;
  envelopeHash: Sha256Hash;
  changeSetId: string;
  changeSetHash: Sha256Hash;
  planningCommit: string;
  progress: ControlHandoffProgressReceiptV2;
  seals: {
    coordinateGraphSeal: Sha256Hash;
    indexSeal: Sha256Hash;
    baselineFreshnessSeal: Sha256Hash;
    reconciliationReportHash: Sha256Hash;
    reconciliationAnalysisHash: Sha256Hash;
    observationAnalysisHash: Sha256Hash | null;
  };
  repositoryIdentity: string;
  observedCommit: string;
  observedWorkingDiffHash: Sha256Hash;
  reconciliationTerminalStatus: "REALIZED" | "VIOLATED" | "UNPROVEN";
  reconciliationReasonCodes: readonly ControlHandoffReconciliationReasonCodeV2[];
  touchedCoordinateIds: readonly QualifiedCoordinateId[];
  unmappedObservedHunkIds: readonly Sha256Hash[];
  proofsObtained: readonly EvidenceEvaluationV1[];
  descriptiveRefinementStepIds: readonly string[];
  nextValidTransition: ControlHandoffNextTransitionV2;
  capsuleHash: Sha256Hash;
}

export interface ControlHandoffRecordV2 {
  schemaVersion: 2;
  kind: "control_handoff_record";
  request: ControlHandoffCaptureRequestV2;
  capsule: ControlHandoffCapsuleV2;
}

export interface ControlHandoffCaptureResultV2 {
  schemaVersion: 2;
  kind: "control_handoff_result";
  operation: "capture";
  status: "CAPTURED" | "NO_OP" | "REFUSED";
  reasonCodes: readonly ControlHandoffReasonCodeV2[];
  capsule: ControlHandoffCapsuleV2 | null;
}

export interface ControlHandoffResumeResultV2 {
  schemaVersion: 2;
  kind: "control_handoff_result";
  operation: "resume";
  status: "RESUMED" | "NO_OP" | "EMPTY" | "REFUSED";
  reasonCodes: readonly ControlHandoffReasonCodeV2[];
  capsule: ControlHandoffCapsuleV2 | null;
  planningBundle: PlanningBundleV1 | null;
}

export const ControlHandoffReasonCodeV2Schema = z.enum(CONTROL_HANDOFF_REASON_CODES);

export const ControlHandoffCoordinateIdV2Schema = z.union([
  QualifiedCoordinateIdSchema,
  Sha256HashSchema,
]) as z.ZodType<ControlHandoffCoordinateIdV2>;

const NotStartedPointerSchema = z.object({
  state: z.literal("not_started"),
  currentCoordinateId: ControlHandoffCoordinateIdV2Schema,
}).strict();

const StepCompletedPointerSchema = z.object({
  state: z.literal("step_completed"),
  completedRefinementStepId: NonEmptyStringSchema,
  currentCoordinateId: ControlHandoffCoordinateIdV2Schema,
}).strict();

export const ControlHandoffProgressPointerV2Schema = z.discriminatedUnion(
  "state",
  [NotStartedPointerSchema, StepCompletedPointerSchema],
) as unknown as z.ZodType<ControlHandoffProgressPointerV2>;

export const ControlHandoffCaptureRequestV2Schema = z.object({
    schemaVersion: z.literal(2),
    planningBundle: PlanningBundleV1Schema,
    progress: ControlHandoffProgressPointerV2Schema,
  }).strict() as unknown as z.ZodType<ControlHandoffCaptureRequestV2>;

export const ControlHandoffResumeRequestV2Schema = z.object({
    schemaVersion: z.literal(2),
    capsuleHash: Sha256HashSchema,
  }).strict() as unknown as z.ZodType<ControlHandoffResumeRequestV2>;

const ProgressReceiptShape = {
  state: z.enum(["not_started", "step_completed"]),
  currentCoordinateId: ControlHandoffCoordinateIdV2Schema,
  currentAbstractionLevel: SemanticLevelSchema,
  completedRefinementStep: z.object({
    stepId: NonEmptyStringSchema,
    order: z.number().int().nonnegative(),
  }).strict().nullable(),
  matchedRepositoryEditIds: z.array(NonEmptyStringSchema),
  certifiedExpectationIds: z.array(NonEmptyStringSchema),
  satisfiedEvidenceRequirementIds: z.array(NonEmptyStringSchema),
  progressHash: Sha256HashSchema,
};

export const ControlHandoffProgressReceiptV2Schema = z.object(ProgressReceiptShape)
  .strict().superRefine((value, context) => {
    requireCanonicalStrings(value.matchedRepositoryEditIds, context, ["matchedRepositoryEditIds"]);
    requireCanonicalStrings(value.certifiedExpectationIds, context, ["certifiedExpectationIds"]);
    requireCanonicalStrings(
      value.satisfiedEvidenceRequirementIds,
      context,
      ["satisfiedEvidenceRequirementIds"],
    );
    if ((value.state === "not_started") !== (value.completedRefinementStep === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedRefinementStep"],
        message: "completed refinement step must be null exactly when progress is not started",
      });
    }
    if (
      value.state === "not_started"
      && (
        value.matchedRepositoryEditIds.length > 0
        || value.certifiedExpectationIds.length > 0
        || value.satisfiedEvidenceRequirementIds.length > 0
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "not-started progress cannot carry completed work receipts",
      });
    }
    if (
      value.state === "step_completed"
      && value.matchedRepositoryEditIds.length === 0
      && value.certifiedExpectationIds.length === 0
      && value.satisfiedEvidenceRequirementIds.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed progress requires at least one non-empty receipt",
      });
    }
    if (value.progressHash !== computeControlHandoffProgressV2Hash(
      value as unknown as ControlHandoffProgressReceiptV2,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["progressHash"],
        message: "progressHash does not match canonical content",
      });
    }
  }) as unknown as z.ZodType<ControlHandoffProgressReceiptV2>;

export const ControlHandoffReconciliationReasonCodeV2Schema = z.enum([
  ...RECONCILIATION_VIOLATION_REASONS,
  ...RECONCILIATION_INSUFFICIENCY_REASONS,
]);

export const ControlHandoffNextTransitionV2Schema = z.union([
    z.object({
      kind: z.literal("refinement_step"),
      stepId: NonEmptyStringSchema,
      order: z.number().int().nonnegative(),
    }).strict(),
    z.object({
      kind: z.literal("repair_then_reconcile"),
      reasonCodes: z.array(ControlHandoffReconciliationReasonCodeV2Schema).min(1),
    }).strict().superRefine((value, context) =>
      requireCanonicalReconciliationReasons(value.reasonCodes, context, ["reasonCodes"])),
    z.object({
      kind: z.literal("obtain_proof_then_reconcile"),
      requirementIds: z.array(NonEmptyStringSchema).min(1),
    }).strict().superRefine((value, context) =>
      requireCanonicalStrings(value.requirementIds, context, ["requirementIds"])),
    z.object({ kind: z.literal("verify_change") }).strict(),
  ]) as unknown as z.ZodType<ControlHandoffNextTransitionV2>;

const CapsuleShape = {
  schemaVersion: z.literal(2),
  kind: z.literal("control_handoff_capsule"),
  executionAuthority: z.literal("none"),
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  sourceContentCollected: z.literal(false),
  planningBundleId: NonEmptyStringSchema,
  planningBundleHash: Sha256HashSchema,
  envelopeId: NonEmptyStringSchema,
  envelopeHash: Sha256HashSchema,
  changeSetId: NonEmptyStringSchema,
  changeSetHash: Sha256HashSchema,
  planningCommit: NonEmptyStringSchema,
  progress: ControlHandoffProgressReceiptV2Schema,
  seals: z.object({
    coordinateGraphSeal: Sha256HashSchema,
    indexSeal: Sha256HashSchema,
    baselineFreshnessSeal: Sha256HashSchema,
    reconciliationReportHash: Sha256HashSchema,
    reconciliationAnalysisHash: Sha256HashSchema,
    observationAnalysisHash: Sha256HashSchema.nullable(),
  }).strict(),
  repositoryIdentity: NonEmptyStringSchema,
  observedCommit: NonEmptyStringSchema,
  observedWorkingDiffHash: Sha256HashSchema,
  reconciliationTerminalStatus: z.enum(["REALIZED", "VIOLATED", "UNPROVEN"]),
  reconciliationReasonCodes: z.array(ControlHandoffReconciliationReasonCodeV2Schema),
  touchedCoordinateIds: z.array(QualifiedCoordinateIdSchema),
  unmappedObservedHunkIds: z.array(Sha256HashSchema),
  proofsObtained: z.array(EvidenceEvaluationV1Schema),
  descriptiveRefinementStepIds: z.array(NonEmptyStringSchema),
  nextValidTransition: ControlHandoffNextTransitionV2Schema,
  capsuleHash: Sha256HashSchema,
};

export const ControlHandoffCapsuleV2Schema = z.object(CapsuleShape)
  .strict().superRefine((value, context) => {
    requireCanonicalStrings(value.touchedCoordinateIds, context, ["touchedCoordinateIds"]);
    requireCanonicalStrings(
      value.unmappedObservedHunkIds,
      context,
      ["unmappedObservedHunkIds"],
    );
    requireCanonicalByKey(
      value.proofsObtained,
      (proof) => `${proof.requirementId}\0${proof.origin}`,
      context,
      ["proofsObtained"],
    );
    if (new Set(value.descriptiveRefinementStepIds).size !== value.descriptiveRefinementStepIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["descriptiveRefinementStepIds"],
        message: "descriptive refinement step ids must be unique",
      });
    }
    requireCanonicalReconciliationReasons(
      value.reconciliationReasonCodes,
      context,
      ["reconciliationReasonCodes"],
    );
    if (value.proofsObtained.some((proof) => proof.result !== "satisfied")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proofsObtained"],
        message: "handoff proofs must be satisfied evidence evaluations",
      });
    }
    for (const [index, proof] of value.proofsObtained.entries()) {
      if (
        proof.planningCommit !== value.planningCommit
        || proof.observedDiffHash !== value.observedWorkingDiffHash
        || (
          proof.observationAnalysisHash !== undefined
          && proof.observationAnalysisHash !== value.seals.observationAnalysisHash
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proofsObtained", index],
          message: "proof identity must be bound to the capsule state",
        });
      }
    }
    const proofRequirementIds = new Set(
      value.proofsObtained.map((proof) => proof.requirementId),
    );
    if (value.progress.satisfiedEvidenceRequirementIds.some((id) => !proofRequirementIds.has(id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["progress", "satisfiedEvidenceRequirementIds"],
        message: "satisfied requirement receipts require a matching structured proof",
      });
    }
    const reasonsValid = value.reconciliationTerminalStatus === "REALIZED"
      ? value.reconciliationReasonCodes.length === 0
      : value.reconciliationReasonCodes.length > 0 && value.reconciliationReasonCodes.every(
        (reason) => value.reconciliationTerminalStatus === "VIOLATED"
          ? (RECONCILIATION_VIOLATION_REASONS as readonly string[]).includes(reason)
          : (RECONCILIATION_INSUFFICIENCY_REASONS as readonly string[]).includes(reason),
      );
    if (!reasonsValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reconciliationReasonCodes"],
        message: "terminal status and reconciliation reason class must agree",
      });
    }
    if (
      value.nextValidTransition.kind === "verify_change"
      && value.reconciliationTerminalStatus !== "REALIZED"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextValidTransition"],
        message: "verify_change is reserved for realized reconciliation",
      });
    }
    if (
      value.nextValidTransition.kind === "repair_then_reconcile"
      && !(
        value.reconciliationTerminalStatus === "VIOLATED"
        || value.reconciliationTerminalStatus === "UNPROVEN"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextValidTransition"],
        message: "repair transitions require violated or unproven reconciliation",
      });
    }
    if (
      value.nextValidTransition.kind === "repair_then_reconcile"
      && value.nextValidTransition.reasonCodes.some(
        (reason) => !value.reconciliationReasonCodes.includes(reason),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextValidTransition", "reasonCodes"],
        message: "repair reasons must be present in the reconciliation verdict",
      });
    }
    if (
      value.nextValidTransition.kind === "obtain_proof_then_reconcile"
      && value.reconciliationTerminalStatus !== "UNPROVEN"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextValidTransition"],
        message: "proof acquisition transitions require an unproven reconciliation",
      });
    }
    if (value.capsuleHash !== computeControlHandoffCapsuleV2Hash(
      value as unknown as ControlHandoffCapsuleV2,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsuleHash"],
        message: "capsuleHash does not match canonical content",
      });
    }
  }) as unknown as z.ZodType<ControlHandoffCapsuleV2>;

export const ControlHandoffRecordV2Schema = z.object({
    schemaVersion: z.literal(2),
    kind: z.literal("control_handoff_record"),
    request: ControlHandoffCaptureRequestV2Schema,
    capsule: ControlHandoffCapsuleV2Schema,
  }).strict().superRefine((value, context) => {
    const { planningBundle, progress } = value.request;
    const capsule = value.capsule;
    if (
      capsule.planningBundleId !== planningBundle.bundleId
      || capsule.planningBundleHash !== planningBundle.bundleHash
      || capsule.envelopeId !== planningBundle.taskEnvelope.envelopeId
      || capsule.envelopeHash !== planningBundle.taskEnvelope.envelopeHash
      || capsule.changeSetId !== planningBundle.semanticChangeSet.changeSetId
      || capsule.changeSetHash !== planningBundle.semanticChangeSet.changeSetHash
      || capsule.planningCommit !== planningBundle.planningCommit
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule"],
        message: "capsule identities must match the capture planning bundle",
      });
    }
    if (
      capsule.seals.coordinateGraphSeal !== planningBundle.taskEnvelope.coordinateGraphSeal
      || capsule.seals.indexSeal !== planningBundle.taskEnvelope.indexSeal
      || capsule.seals.baselineFreshnessSeal !== planningBundle.taskEnvelope.baselineFreshnessSeal
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule", "seals"],
        message: "capsule seals must match the capture planning bundle",
      });
    }
    const descriptiveRefinementStepIds = computeControlHandoffDescriptiveRefinementStepIdsV2(
      planningBundle.semanticChangeSet,
    );
    if (!arraysEqual(capsule.descriptiveRefinementStepIds, descriptiveRefinementStepIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule", "descriptiveRefinementStepIds"],
        message: "descriptive refinement steps must exactly match the captured semantic order",
      });
    }
    if (
      progress.state !== capsule.progress.state
      || progress.currentCoordinateId !== capsule.progress.currentCoordinateId
      || (
        progress.state === "step_completed"
        && progress.completedRefinementStepId !== capsule.progress.completedRefinementStep?.stepId
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule", "progress"],
        message: "capsule progress must match the capture request",
      });
    }
    if (capsule.progress.completedRefinementStep !== null) {
      const step = planningBundle.semanticChangeSet.refinementSteps.find(
        (candidate) => candidate.stepId === capsule.progress.completedRefinementStep?.stepId,
      );
      const requiredExpectationIds = step === undefined
        ? []
        : step.toExpectationIds.filter((expectationId) =>
          planningBundle.semanticChangeSet.semanticExpectations.some(
            (expectation) => expectation.expectationId === expectationId && expectation.required,
          ));
      const requiredEvidenceIds = requiredExpectationIds.flatMap((expectationId) =>
        planningBundle.semanticChangeSet.semanticExpectations.find(
          (expectation) => expectation.expectationId === expectationId,
        )?.acceptanceEvidenceIds ?? []);
      const requiredEditEvidenceIds = step === undefined
        ? []
        : step.repositoryEditIds.flatMap((editId) =>
          planningBundle.semanticChangeSet.repositoryEditExpectations.find(
            (edit) => edit.editId === editId,
          )?.acceptanceEvidenceIds ?? []);
      const completionEvidenceRequirementIds = step?.completionEvidenceRequirementIds ?? [];
      if (
        step === undefined
        || classifyControlHandoffRefinementStepV2(
          planningBundle.semanticChangeSet,
          step,
        ) !== "proof_bearing"
        || step.order !== capsule.progress.completedRefinementStep.order
        || !arraysEqual(capsule.progress.matchedRepositoryEditIds, step.repositoryEditIds)
        || !arraysEqual(capsule.progress.certifiedExpectationIds, requiredExpectationIds)
        || !arraysEqual(
          capsule.progress.satisfiedEvidenceRequirementIds,
          [...new Set([
            ...requiredEvidenceIds,
            ...requiredEditEvidenceIds,
            ...completionEvidenceRequirementIds,
          ])]
            .sort(compareCodeUnits),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capsule", "progress", "completedRefinementStep"],
          message: "completed progress must reference the captured refinement step",
        });
      }
    }
    const orderedSteps = [...planningBundle.semanticChangeSet.refinementSteps]
      .sort((left, right) => left.order - right.order || compareCodeUnits(left.stepId, right.stepId));
    const completedStepId = capsule.progress.completedRefinementStep?.stepId;
    const completedIndex = completedStepId === undefined
      ? -1
      : orderedSteps.findIndex((step) => step.stepId === completedStepId);
    const nextStep = orderedSteps
      .slice(completedIndex + 1)
      .find((step) => classifyControlHandoffRefinementStepV2(
        planningBundle.semanticChangeSet,
        step,
      ) !== "descriptive");
    const transition = capsule.nextValidTransition;
    if (
      transition.kind === "refinement_step"
      && (
        nextStep === undefined
        || transition.stepId !== nextStep.stepId
        || transition.order !== nextStep.order
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule", "nextValidTransition"],
        message: "refinement transition must identify the next non-descriptive captured step",
      });
    }
    if (
      transition.kind === "verify_change"
      && (capsule.reconciliationTerminalStatus !== "REALIZED" || nextStep !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capsule", "nextValidTransition"],
        message: "verification requires realized reconciliation with no remaining step",
      });
    }
  }) as unknown as z.ZodType<ControlHandoffRecordV2>;

const BaseResultShape = {
  schemaVersion: z.literal(2),
  kind: z.literal("control_handoff_result"),
  reasonCodes: z.array(ControlHandoffReasonCodeV2Schema),
};

export const ControlHandoffCaptureResultV2Schema = z.object({
    ...BaseResultShape,
    operation: z.literal("capture"),
    status: z.enum(["CAPTURED", "NO_OP", "REFUSED"]),
    capsule: ControlHandoffCapsuleV2Schema.nullable(),
  }).strict().superRefine((value, context) => {
    requireCanonicalHandoffReasons(value.reasonCodes, context);
    const valid = value.status === "CAPTURED"
      ? value.capsule !== null && value.reasonCodes.length === 0
      : value.status === "NO_OP"
        ? value.capsule === null
          && value.reasonCodes.length === 1
          && value.reasonCodes[0] === "NON_SEMCTX_REPOSITORY"
        : value.capsule === null && value.reasonCodes.length > 0;
    if (!valid) addResultRelationshipIssue(context);
  }) as unknown as z.ZodType<ControlHandoffCaptureResultV2>;

export const ControlHandoffResumeResultV2Schema = z.object({
    ...BaseResultShape,
    operation: z.literal("resume"),
    status: z.enum(["RESUMED", "NO_OP", "EMPTY", "REFUSED"]),
    capsule: ControlHandoffCapsuleV2Schema.nullable(),
    planningBundle: PlanningBundleV1Schema.nullable(),
  }).strict().superRefine((value, context) => {
    requireCanonicalHandoffReasons(value.reasonCodes, context);
    const valid = value.status === "RESUMED"
      ? value.capsule !== null && value.planningBundle !== null && value.reasonCodes.length === 0
      : value.status === "NO_OP"
        ? value.capsule === null
          && value.planningBundle === null
          && value.reasonCodes.length === 1
          && value.reasonCodes[0] === "NON_SEMCTX_REPOSITORY"
        : value.status === "EMPTY"
          ? value.capsule === null
            && value.planningBundle === null
            && value.reasonCodes.length === 1
            && (
              value.reasonCodes[0] === "HANDOFF_NOT_FOUND"
              || value.reasonCodes[0] === "LEGACY_HANDOFF_ONLY"
            )
          : value.capsule === null
            && value.planningBundle === null
            && value.reasonCodes.length > 0
            && value.reasonCodes.every((reason) =>
              reason !== "NON_SEMCTX_REPOSITORY"
              && reason !== "HANDOFF_NOT_FOUND"
              && reason !== "LEGACY_HANDOFF_ONLY");
    if (!valid) addResultRelationshipIssue(context);
    if (
      value.capsule !== null
      && value.planningBundle !== null
      && value.capsule.planningBundleHash !== value.planningBundle.bundleHash
    ) addResultRelationshipIssue(context);
  }) as unknown as z.ZodType<ControlHandoffResumeResultV2>;

export function computeControlHandoffProgressV2Hash(
  value: Omit<ControlHandoffProgressReceiptV2, "progressHash"> & { progressHash?: Sha256Hash },
): Sha256Hash {
  const { progressHash: _hash, ...payload } = value;
  return sha256HashUtf8(`${PROGRESS_HASH_DOMAIN}${serializeControlReport(payload)}`);
}

export function computeControlHandoffCapsuleV2Hash(
  value: Omit<ControlHandoffCapsuleV2, "capsuleHash"> & { capsuleHash?: Sha256Hash },
): Sha256Hash {
  const { capsuleHash: _hash, ...payload } = value;
  return sha256HashUtf8(`${CAPSULE_HASH_DOMAIN}${serializeControlReport(payload)}`);
}

function requireCanonicalStrings(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const canonical = [...new Set(values)].sort(compareCodeUnits);
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "values must be unique and use canonical ASCII order",
    });
  }
}

function requireCanonicalByKey<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const keys = values.map(key);
  requireCanonicalStrings(keys, context, path);
}

function requireCanonicalReconciliationReasons(
  reasons: readonly ReconciliationReasonCodeV1[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const parsed = reasons.map((reason) => ReconciliationReasonCodeV1Schema.parse(reason));
  const canonical = [...new Set(parsed)].sort(
    (left, right) => reconciliationReasonRank(left) - reconciliationReasonRank(right),
  );
  if (canonical.length !== reasons.length || canonical.some((reason, index) => reason !== reasons[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "reconciliation reasons must be unique and canonically ordered",
    });
  }
}

function reconciliationReasonRank(reason: ReconciliationReasonCodeV1): number {
  const order = [
    ...RECONCILIATION_VIOLATION_REASONS,
    ...RECONCILIATION_INSUFFICIENCY_REASONS,
  ] as readonly string[];
  return order.indexOf(reason);
}

function requireCanonicalHandoffReasons(
  reasons: readonly ControlHandoffReasonCodeV2[],
  context: z.RefinementCtx,
): void {
  const canonical = [...new Set(reasons)].sort(
    (left, right) => CONTROL_HANDOFF_REASON_CODES.indexOf(left) - CONTROL_HANDOFF_REASON_CODES.indexOf(right),
  );
  if (canonical.length !== reasons.length || canonical.some((reason, index) => reason !== reasons[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCodes"],
      message: "handoff reasons must be unique and canonically ordered",
    });
  }
}

function addResultRelationshipIssue(context: z.RefinementCtx): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "result status, reasons, capsule, and planning bundle must agree",
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
