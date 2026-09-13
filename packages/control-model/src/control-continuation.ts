import { z } from "zod";
import { serializeControlReport } from "./canonical";
import { sha256HashUtf8 } from "./hashing";
import { Sha256HashSchema } from "./primitive-schemas";
import type { Sha256Hash } from "./types";

const REPORT_HASH_DOMAIN = "SEMCTX_CONTROL_CONTINUATION_REPORT_V1\0";

export const CONTROL_CONTINUATION_CLOSED_REASONS = [
  "MATCH",
  "CHANGED",
  "EXPIRED",
  "DEPENDENCY_MISSING",
  "DEPENDENCY_UNREADABLE",
  "DEPENDENCY_UNVERIFIED",
  "SCOPE_INCOMPLETE",
  "CURRENT_STATE_CHANGED",
  "WRONG_REPOSITORY",
  "WRONG_WORKTREE",
  "ARTIFACT_MISSING",
  "ARTIFACT_INVALID",
  "UNSUPPORTED_VERSION",
  "BUDGET_EXCEEDED",
] as const;
export type ControlContinuationClosedReasonV1 = typeof CONTROL_CONTINUATION_CLOSED_REASONS[number];
export const ControlContinuationClosedReasonV1Schema = z.enum(CONTROL_CONTINUATION_CLOSED_REASONS);

export const CONTROL_CONTINUATION_REFUSAL_REASONS = [
  "ARTIFACT_MISSING",
  "ARTIFACT_INVALID",
  "UNSUPPORTED_VERSION",
  "WRONG_REPOSITORY",
  "BUDGET_EXCEEDED",
] as const;
export type ControlContinuationRefusalReasonV1 = typeof CONTROL_CONTINUATION_REFUSAL_REASONS[number];
export const ControlContinuationRefusalReasonV1Schema = z.enum(CONTROL_CONTINUATION_REFUSAL_REASONS);

const DEPENDENCY_ONLY_REASONS = new Set<ControlContinuationClosedReasonV1>(
  CONTROL_CONTINUATION_CLOSED_REASONS.filter(
    (reason) => !(CONTROL_CONTINUATION_REFUSAL_REASONS as readonly string[]).includes(reason),
  ),
);

export const CONTROL_CONTINUATION_DEPENDENCY_STATUSES = ["APPLICABLE", "STALE", "UNKNOWN"] as const;
export type ControlContinuationDependencyStatusV1 = typeof CONTROL_CONTINUATION_DEPENDENCY_STATUSES[number];

/** Fixed, deterministic dependency-kind order; also the canonical report ordering. */
export const CONTROL_CONTINUATION_DEPENDENCY_KINDS = [
  "repository_identity",
  "worktree_identity",
  "source_commit",
  "diff",
  "semantic_index_inputs",
  "producer_tool",
  "configuration",
  "environment",
  "policy",
  "expiry",
] as const;
export type ControlContinuationDependencyKindV1 = typeof CONTROL_CONTINUATION_DEPENDENCY_KINDS[number];

export const CONTROL_CONTINUATION_DEPENDENCY_SCOPES = ["repository", "evidence"] as const;
export type ControlContinuationDependencyScopeV1 = typeof CONTROL_CONTINUATION_DEPENDENCY_SCOPES[number];

export const CONTROL_CONTINUATION_STATEMENT_PROVENANCES = [
  "declared",
  "historically_observed",
  "currently_observed",
] as const;
export type ControlContinuationProvenanceV1 = typeof CONTROL_CONTINUATION_STATEMENT_PROVENANCES[number];

export const CONTROL_CONTINUATION_SECTION_KEYS = [
  "objective",
  "declaredDecisions",
  "declaredNonGoals",
  "expectedChanges",
  "observedChanges",
  "risks",
  "missingEvidence",
  "nextChecks",
] as const;
export type ControlContinuationSectionKeyV1 = typeof CONTROL_CONTINUATION_SECTION_KEYS[number];

export const CONTROL_CONTINUATION_FRESHNESS_VERDICTS = [
  "FRESH",
  "DIRTY_KNOWN",
  "STALE",
  "UNSEALED",
] as const;
export type ControlContinuationFreshnessVerdictV1 = typeof CONTROL_CONTINUATION_FRESHNESS_VERDICTS[number];

export interface ControlContinuationExplainRequestV1 {
  schemaVersion: 1;
  capsuleHash: Sha256Hash;
}

export const ControlContinuationExplainRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  capsuleHash: Sha256HashSchema,
}).strict() as unknown as z.ZodType<ControlContinuationExplainRequestV1>;

export interface ControlContinuationStatementV1 {
  text: string;
  provenance: ControlContinuationProvenanceV1;
  sourceArtifactHash: Sha256Hash;
  sourceField: string;
}

export const ControlContinuationStatementV1Schema = z.object({
  text: z.string().min(1),
  provenance: z.enum(CONTROL_CONTINUATION_STATEMENT_PROVENANCES),
  sourceArtifactHash: Sha256HashSchema,
  sourceField: z.string().min(1).max(200),
}).strict() as unknown as z.ZodType<ControlContinuationStatementV1>;

export interface ControlContinuationDependencyDecisionV1 {
  obligation: string;
  scope: ControlContinuationDependencyScopeV1;
  dependencyKind: ControlContinuationDependencyKindV1;
  baselineRef: string | null;
  currentRef: string | null;
  provenance: ControlContinuationProvenanceV1;
  status: ControlContinuationDependencyStatusV1;
  closedReason: ControlContinuationClosedReasonV1;
}

const APPLICABLE_REASONS = new Set<ControlContinuationClosedReasonV1>(["MATCH"]);
const STALE_REASONS = new Set<ControlContinuationClosedReasonV1>([
  "CHANGED",
  "EXPIRED",
  "CURRENT_STATE_CHANGED",
  "WRONG_REPOSITORY",
  "WRONG_WORKTREE",
  "SCOPE_INCOMPLETE",
]);
const UNKNOWN_REASONS = new Set<ControlContinuationClosedReasonV1>([
  "DEPENDENCY_MISSING",
  "DEPENDENCY_UNREADABLE",
  "DEPENDENCY_UNVERIFIED",
  "SCOPE_INCOMPLETE",
  "CURRENT_STATE_CHANGED",
]);

export const ControlContinuationDependencyDecisionV1Schema = z.object({
  obligation: z.string().min(1).max(200),
  scope: z.enum(CONTROL_CONTINUATION_DEPENDENCY_SCOPES),
  dependencyKind: z.enum(CONTROL_CONTINUATION_DEPENDENCY_KINDS),
  baselineRef: z.string().max(200).nullable(),
  currentRef: z.string().max(200).nullable(),
  provenance: z.enum(CONTROL_CONTINUATION_STATEMENT_PROVENANCES),
  status: z.enum(CONTROL_CONTINUATION_DEPENDENCY_STATUSES),
  closedReason: ControlContinuationClosedReasonV1Schema,
}).strict().superRefine((value, context) => {
  if (!DEPENDENCY_ONLY_REASONS.has(value.closedReason)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["closedReason"],
      message: "closedReason is reserved for report-level refusal",
    });
  }
  const valid = value.status === "APPLICABLE"
    ? APPLICABLE_REASONS.has(value.closedReason)
      && value.baselineRef !== null
      && value.currentRef !== null
      && value.baselineRef === value.currentRef
    : value.status === "STALE"
      ? STALE_REASONS.has(value.closedReason)
      : UNKNOWN_REASONS.has(value.closedReason);
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dependency status and closedReason must agree",
    });
  }
}) as unknown as z.ZodType<ControlContinuationDependencyDecisionV1>;

export interface ControlContinuationHistoricalSourceV1 {
  repositoryIdentity: string;
  observedCommit: string;
  observedWorkingDiffHash: Sha256Hash;
  planningCommit: string;
  planningBundleHash: Sha256Hash;
  envelopeHash: Sha256Hash;
  changeSetHash: Sha256Hash;
  baselineFreshnessSealHash: Sha256Hash;
}

export const ControlContinuationHistoricalSourceV1Schema = z.object({
  repositoryIdentity: z.string().min(1),
  observedCommit: z.string().min(1),
  observedWorkingDiffHash: Sha256HashSchema,
  planningCommit: z.string().min(1),
  planningBundleHash: Sha256HashSchema,
  envelopeHash: Sha256HashSchema,
  changeSetHash: Sha256HashSchema,
  baselineFreshnessSealHash: Sha256HashSchema,
}).strict() as unknown as z.ZodType<ControlContinuationHistoricalSourceV1>;

export interface ControlContinuationCurrentCaptureV1 {
  repositoryIdentity: string;
  headCommit: string | null;
  workingDiffHash: Sha256Hash | null;
  indexFreshnessVerdict: ControlContinuationFreshnessVerdictV1;
  currentFreshnessSealHash: Sha256Hash | null;
}

export const ControlContinuationCurrentCaptureV1Schema = z.object({
  repositoryIdentity: z.string().min(1),
  headCommit: z.string().min(1).nullable(),
  workingDiffHash: Sha256HashSchema.nullable(),
  indexFreshnessVerdict: z.enum(CONTROL_CONTINUATION_FRESHNESS_VERDICTS),
  currentFreshnessSealHash: Sha256HashSchema.nullable(),
}).strict() as unknown as z.ZodType<ControlContinuationCurrentCaptureV1>;

export interface ControlContinuationSectionsV1 {
  objective: readonly ControlContinuationStatementV1[];
  declaredDecisions: readonly ControlContinuationStatementV1[];
  declaredNonGoals: readonly ControlContinuationStatementV1[];
  expectedChanges: readonly ControlContinuationStatementV1[];
  observedChanges: readonly ControlContinuationStatementV1[];
  risks: readonly ControlContinuationStatementV1[];
  missingEvidence: readonly ControlContinuationStatementV1[];
  nextChecks: readonly ControlContinuationStatementV1[];
}

export const ControlContinuationSectionsV1Schema = z.object({
  objective: z.array(ControlContinuationStatementV1Schema),
  declaredDecisions: z.array(ControlContinuationStatementV1Schema),
  declaredNonGoals: z.array(ControlContinuationStatementV1Schema),
  expectedChanges: z.array(ControlContinuationStatementV1Schema),
  observedChanges: z.array(ControlContinuationStatementV1Schema),
  risks: z.array(ControlContinuationStatementV1Schema),
  missingEvidence: z.array(ControlContinuationStatementV1Schema),
  nextChecks: z.array(ControlContinuationStatementV1Schema),
}).strict() as unknown as z.ZodType<ControlContinuationSectionsV1>;

export const ControlContinuationOmittedSectionCountsV1Schema = z.object(
  Object.fromEntries(
    CONTROL_CONTINUATION_SECTION_KEYS.map((key) => [key, z.number().int().nonnegative()]),
  ) as Record<ControlContinuationSectionKeyV1, z.ZodNumber>,
).strict();

export interface ControlContinuationReportV1 {
  schemaVersion: 1;
  kind: "control_continuation_report";
  executionAuthority: "none";
  enforcementMode: "shadow";
  blockingEnabled: false;
  sourceContentCollected: false;
  gateAdmission: "NOT_EVALUATED";
  requestedCapsuleHash: Sha256Hash;
  historicalSource: ControlContinuationHistoricalSourceV1;
  currentCapture: ControlContinuationCurrentCaptureV1;
  captureTime: string;
  completeness: "complete" | "partial";
  sections: ControlContinuationSectionsV1;
  dependencies: readonly ControlContinuationDependencyDecisionV1[];
  omittedSectionCounts: Readonly<Record<ControlContinuationSectionKeyV1, number>>;
  reportHash: Sha256Hash;
}

const ReportShape = {
  schemaVersion: z.literal(1),
  kind: z.literal("control_continuation_report"),
  executionAuthority: z.literal("none"),
  enforcementMode: z.literal("shadow"),
  blockingEnabled: z.literal(false),
  sourceContentCollected: z.literal(false),
  gateAdmission: z.literal("NOT_EVALUATED"),
  requestedCapsuleHash: Sha256HashSchema,
  historicalSource: ControlContinuationHistoricalSourceV1Schema,
  currentCapture: ControlContinuationCurrentCaptureV1Schema,
  captureTime: z.string().min(1),
  completeness: z.enum(["complete", "partial"]),
  sections: ControlContinuationSectionsV1Schema,
  dependencies: z.array(ControlContinuationDependencyDecisionV1Schema),
  omittedSectionCounts: ControlContinuationOmittedSectionCountsV1Schema,
  reportHash: Sha256HashSchema,
};

export const ControlContinuationReportV1Schema = z.object(ReportShape).strict().superRefine(
  (value, context) => {
    const dependencyKinds = value.dependencies.map((dependency) => dependency.dependencyKind);
    const canonicalKinds = [...new Set(dependencyKinds)].sort(
      (left, right) =>
        CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(left)
        - CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(right),
    );
    if (
      canonicalKinds.length !== dependencyKinds.length
      || canonicalKinds.some((kind, index) => kind !== dependencyKinds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencies"],
        message: "dependencies must be unique and canonically ordered by dependencyKind",
      });
    }
    if (dependencyKinds.length !== CONTROL_CONTINUATION_DEPENDENCY_KINDS.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependencies"],
        message: "every canonical dependency kind must be reported exactly once",
      });
    }
    if (value.reportHash !== computeControlContinuationReportV1Hash(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reportHash"],
        message: "reportHash does not match canonical content",
      });
    }
  },
) as unknown as z.ZodType<ControlContinuationReportV1>;

export interface ControlContinuationExplainResultV1 {
  schemaVersion: 1;
  kind: "control_continuation_result";
  operation: "explain";
  status: "EXPLAINED" | "REFUSED";
  reasonCode: ControlContinuationRefusalReasonV1 | null;
  report: ControlContinuationReportV1 | null;
}

export const ControlContinuationExplainResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("control_continuation_result"),
  operation: z.literal("explain"),
  status: z.enum(["EXPLAINED", "REFUSED"]),
  reasonCode: ControlContinuationRefusalReasonV1Schema.nullable(),
  report: ControlContinuationReportV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  const valid = value.status === "EXPLAINED"
    ? value.report !== null && value.reasonCode === null
    : value.report === null && value.reasonCode !== null;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "result status, reasonCode, and report must agree",
    });
  }
}) as unknown as z.ZodType<ControlContinuationExplainResultV1>;

export function computeControlContinuationReportV1Hash(
  value: Omit<ControlContinuationReportV1, "reportHash" | "captureTime"> & {
    reportHash?: Sha256Hash;
    captureTime?: string;
  },
): Sha256Hash {
  const { reportHash: _hash, captureTime: _time, ...payload } = value;
  return sha256HashUtf8(`${REPORT_HASH_DOMAIN}${serializeControlReport(payload)}`);
}
