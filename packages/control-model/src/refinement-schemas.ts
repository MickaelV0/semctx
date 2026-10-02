import { z } from "zod";
import {
  ArchitectureComparisonReportSchema,
  AuthoredSemanticLevelSchema,
  AuthorizationDetailSchema,
  AuthorizationReasonSchema,
  ControlFreshnessReasonSchema,
  ControlFreshnessVerdictSchema,
  CoordinateCategorySchema,
  EpistemicStatusSchema,
  ExplanationReportSchema,
  ImpactReportSchema,
  MigrationStateSchema,
  ProofEvaluationSchema,
  ProofObligationSchema,
  ProofReferenceSchema,
  QualifiedCoordinateIdSchema,
  RiskLevelSchema,
  SemanticLevelSchema,
  Sha256HashSchema,
} from "./schemas";
import {
  computeCanonicalProofAttestationDigest,
  computeAttestationSetHash,
  computeControlFreshnessSealV2Hash,
} from "./hashing";
import { compareCodeUnits } from "./ordering";
import type {
  CanonicalProofAttestationV1,
  ControlFreshnessSealV2,
} from "./refinement";
import {
  ReconciliationEvidenceKindV1Schema as EvidenceKindV1Schema,
  ReconciliationEvidenceRefV1Schema as EvidenceRefV1Schema,
  ReconciliationRefinementRelationKindV1Schema as RefinementRelationKindV1Schema,
  ReconciliationRefinementRelationV1Schema as RefinementRelationV1Schema,
  ReconciliationRelationEndpointV1Schema as RelationEndpointV1Schema,
  ReconciliationRelationProvenanceV1Schema as RelationProvenanceV1Schema,
  ReconciliationSha256DigestV1Schema as Sha256DigestV1Schema,
} from "./reconciliation-refinement-schemas";
import {
  ReconciliationCompatibilityNormalizationNoteV1Schema as CompatibilityNormalizationNoteV1Schema,
  ReconciliationCoordinateGraphReportV2Schema as CoordinateGraphReportV2Schema,
  ReconciliationCoordinateNodeV2Schema as CoordinateNodeV2Schema,
  ReconciliationLevelCoverageV2Schema as LevelCoverageV2Schema,
  ReconciliationObservedDiffHunkV1Schema as ObservedDiffHunkV1Schema,
  ReconciliationObservedDiffRangeV1Schema as ObservedDiffRangeV1Schema,
} from "./reconciliation-observation-schemas";

export {
  EvidenceKindV1Schema,
  EvidenceRefV1Schema,
  RefinementRelationKindV1Schema,
  RefinementRelationV1Schema,
  RelationEndpointV1Schema,
  RelationProvenanceV1Schema,
  Sha256DigestV1Schema,
  CompatibilityNormalizationNoteV1Schema,
  CoordinateGraphReportV2Schema,
  CoordinateNodeV2Schema,
  LevelCoverageV2Schema,
  ObservedDiffHunkV1Schema,
  ObservedDiffRangeV1Schema,
};

export const AuthoredSemanticNodeV1Schema = z.object({
  schemaVersion: z.literal(1),
  nodeId: z.string().min(1),
  kind: z.string().min(1),
  appliesAtLevel: AuthoredSemanticLevelSchema,
  category: CoordinateCategorySchema,
  label: z.string(),
  epistemicStatus: EpistemicStatusSchema,
}).strict();

export const ObservedDiffHunkTransportV1Schema = z.object({
  schemaVersion: z.literal(1),
  repositoryIdentity: z.string().min(1),
  normalizedPath: z.string().min(1),
  oldRange: ObservedDiffRangeV1Schema,
  newRange: ObservedDiffRangeV1Schema,
  oldBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  newBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  rawHunkBytes: z.object({
    encoding: z.literal("base64"),
    value: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict(),
  identity: Sha256HashSchema,
}).strict();

export const ControlReasonCodeV1Schema = z.enum([
  "COORDINATE_UNKNOWN",
  "MAPPING_MISSING",
  "REFINEMENT_DISCONNECTED",
  "INDEX_STALE",
  "BUDGET_EXHAUSTED",
  "PLANNING_COMMIT_MISMATCH",
  "ATTESTATION_UNBOUND",
]);
export const ControlTerminalStatusV1Schema = z.enum(["success", "empty", "refused", "budget_exhausted"]);
export const TraversalDirectionV1Schema = z.enum(["lift", "lower"]);

export const TraversalBudgetV1Schema = z.object({
  limit: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.consumed + value.remaining !== value.limit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "consumed plus remaining must equal limit" });
  }
});

export const RefinementTraversalStepV1Schema = z.object({
  relation: RefinementRelationV1Schema,
  from: RelationEndpointV1Schema,
  to: RelationEndpointV1Schema,
  fromLevel: SemanticLevelSchema,
  toLevel: SemanticLevelSchema,
}).strict().superRefine((value, context) => {
  if (JSON.stringify(value.from) !== JSON.stringify(value.relation.source)
    && JSON.stringify(value.from) !== JSON.stringify(value.relation.target)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "step endpoint is absent from relation" });
  }
  if (JSON.stringify(value.to) !== JSON.stringify(value.relation.source)
    && JSON.stringify(value.to) !== JSON.stringify(value.relation.target)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "step endpoint is absent from relation" });
  }
});

export const RefinementPathV1Schema = z.object({
  coordinates: z.array(z.union([QualifiedCoordinateIdSchema, Sha256HashSchema])).min(1),
  steps: z.array(RefinementTraversalStepV1Schema),
}).strict().superRefine((value, context) => {
  if (value.steps.length !== value.coordinates.length - 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a refinement path requires one fewer step than coordinates" });
  }
});

export const ControlFreshnessSealV2Schema = z.object({
  sealSchemaVersion: z.literal(2),
  kind: z.literal("control_freshness_seal"),
  algorithm: z.literal("sha256-v1"),
  repositoryRoot: z.string().min(1),
  indexedRepositoryRoot: z.string().min(1).nullable(),
  headAtCapture: z.string().min(1).nullable(),
  indexedHeadCommit: z.string().min(1).nullable(),
  repositoryGraphHash: Sha256HashSchema,
  indexedRepositoryGraphHash: Sha256HashSchema.nullable(),
  semanticModelHash: Sha256HashSchema,
  indexedSemanticModelHash: Sha256HashSchema.nullable(),
  analysisInputHash: Sha256HashSchema,
  indexedAnalysisInputHash: Sha256HashSchema.nullable(),
  workingDiffHash: Sha256HashSchema.nullable(),
  indexedWorkingDiffHash: Sha256HashSchema.nullable(),
  indexedAt: z.string().datetime({ offset: true }).nullable(),
  storeSchemaVersion: z.number().int().nonnegative().nullable(),
  indexedStoreSchemaVersion: z.number().int().nonnegative().nullable(),
  toolVersion: z.string().min(1),
  indexedToolVersion: z.string().min(1).nullable(),
  planeAIndexSnapshotHash: Sha256HashSchema.nullable().optional(),
  indexedPlaneAIndexSnapshotHash: Sha256HashSchema.nullable().optional(),
  attestationSetHash: Sha256HashSchema.nullable(),
  sealHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  const { sealHash: _sealHash, ...payload } = value;
  if (computeControlFreshnessSealV2Hash(payload as Omit<ControlFreshnessSealV2, "sealHash">) !== value.sealHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sealHash"], message: "freshness seal v2 hash mismatch" });
  }
});

export const TraversalReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  direction: TraversalDirectionV1Schema,
  sourceId: z.union([QualifiedCoordinateIdSchema, Sha256HashSchema]),
  targetLevel: SemanticLevelSchema,
  visitedCoordinateIds: z.array(z.union([QualifiedCoordinateIdSchema, Sha256HashSchema])),
  paths: z.array(RefinementPathV1Schema),
  governingConstraints: z.array(RefinementRelationV1Schema),
  proofs: z.array(RefinementRelationV1Schema),
  advisoryRelations: z.array(RefinementRelationV1Schema),
  terminalStatus: ControlTerminalStatusV1Schema,
  reasonCode: ControlReasonCodeV1Schema.optional(),
  budget: TraversalBudgetV1Schema,
  freshnessSeal: ControlFreshnessSealV2Schema.optional(),
  compatibilityNormalization: z.array(CompatibilityNormalizationNoteV1Schema),
}).strict().superRefine(validateTerminalReason);

export const RefinementCoverageReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  rootCoordinate: z.union([QualifiedCoordinateIdSchema, Sha256HashSchema]),
  sourceSeal: Sha256HashSchema,
  indexSeal: Sha256HashSchema,
  direction: TraversalDirectionV1Schema,
  levelSpan: z.object({ from: SemanticLevelSchema, to: SemanticLevelSchema }).strict(),
  visitedCoordinates: z.array(z.union([QualifiedCoordinateIdSchema, Sha256HashSchema])),
  loadBearingSteps: z.array(RefinementTraversalStepV1Schema),
  advisorySteps: z.array(RefinementTraversalStepV1Schema),
  governingConstraints: z.array(RefinementRelationV1Schema),
  proofs: z.array(RefinementRelationV1Schema),
  coveredLevels: z.array(SemanticLevelSchema),
  missingLevels: z.array(SemanticLevelSchema),
  loadBearingEvidence: z.array(EvidenceRefV1Schema),
  proofReferences: z.array(EvidenceRefV1Schema),
  terminalStatus: ControlTerminalStatusV1Schema,
  reasonCode: ControlReasonCodeV1Schema.optional(),
  budget: TraversalBudgetV1Schema,
  compatibilityNormalization: z.array(CompatibilityNormalizationNoteV1Schema),
}).strict().superRefine((value, context) => {
  validateTerminalReason(value, context);
  validateSortedUnique(value.coveredLevels, String, context, ["coveredLevels"]);
  validateSortedUnique(value.missingLevels, String, context, ["missingLevels"]);
  if (value.coveredLevels.some((level) => value.missingLevels.includes(level))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "covered and missing levels must be disjoint" });
  }
});

export const AttestationRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  attestationRef: z.string().min(1),
}).strict();

export const CanonicalProofAttestationV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  obligation: ProofObligationSchema,
  subject: z.string().min(1),
  epistemicStatus: EpistemicStatusSchema,
  references: z.array(ProofReferenceSchema).min(1),
  commit: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  attestationDigest: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.observedAt) > Date.parse(value.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry precedes observation" });
  }
  validateSortedUnique(value.references, proofReferenceKey, context, ["references"]);
  const { attestationDigest: _attestationDigest, ...payload } = value;
  if (computeCanonicalProofAttestationDigest(payload as Omit<CanonicalProofAttestationV1, "attestationDigest">) !== value.attestationDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["attestationDigest"], message: "attestation digest mismatch" });
  }
});

export const AdvisoryRejectedAttestationV1Schema = z.object({
  schemaVersion: z.literal(1),
  attestationRef: z.string().min(1),
  reason: z.literal("ATTESTATION_UNBOUND"),
}).strict();

export const SealedAttestationIndexV1Schema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(CanonicalProofAttestationV1Schema),
  attestationSetHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  validateSortedUnique(value.entries, (entry) => entry.id, context, ["entries"]);
  const digests = value.entries.map((entry) => entry.attestationDigest);
  if (new Set(digests).size !== digests.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "attestation digests must be unique" });
  }
  if (computeAttestationSetHash(digests as `sha256:${string}`[]) !== value.attestationSetHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["attestationSetHash"], message: "attestation set hash mismatch" });
  }
});

const TransitionAuthorizationV1Fields = {
  decision: z.enum(["ALLOW", "DENY"]),
  fromState: MigrationStateSchema,
  toState: MigrationStateSchema,
  risk: RiskLevelSchema,
  reasons: z.array(AuthorizationReasonSchema),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
};
const StepAuthorizationV1Fields = {
  decision: z.enum(["ALLOW", "DENY"]),
  stepId: z.string().min(1),
  reasons: z.array(AuthorizationReasonSchema),
  missingDependencies: z.array(z.string()),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
};
const DeletionAuthorizationV1Fields = {
  decision: z.enum(["ALLOW", "DENY"]),
  subject: z.string().min(1),
  reasons: z.array(AuthorizationReasonSchema),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
};
const authorizationV2Fields = {
  acceptedAttestations: z.array(CanonicalProofAttestationV1Schema),
  advisoryRejectedAttestations: z.array(AdvisoryRejectedAttestationV1Schema),
};

export const TransitionAuthorizationReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...TransitionAuthorizationV1Fields,
  ...authorizationV2Fields,
}).strict().superRefine(validateAuthorizationOrder);
export const StepAuthorizationReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...StepAuthorizationV1Fields,
  ...authorizationV2Fields,
}).strict().superRefine(validateAuthorizationOrder);
export const DeletionAuthorizationReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...DeletionAuthorizationV1Fields,
  ...authorizationV2Fields,
}).strict().superRefine(validateAuthorizationOrder);

export const ControlQueryKindV1Schema = z.enum([
  "coordinate_graph",
  "traversal",
  "refinement_coverage",
  "impact",
  "explanation",
  "architecture_comparison",
  "authorize_transition",
  "authorize_step",
  "authorize_deletion",
]);

const envelopeFreshness = z.object({
  verdict: ControlFreshnessVerdictSchema,
  reasons: z.array(ControlFreshnessReasonSchema),
  seal: ControlFreshnessSealV2Schema.nullable(),
}).strict();

function envelope<K extends string, S extends z.ZodTypeAny>(kind: K, payload: S) {
  return z.object({
    schemaVersion: z.literal(1),
    kind: z.literal(kind),
    freshness: envelopeFreshness,
    terminalStatus: ControlTerminalStatusV1Schema,
    reasonCodes: z.array(ControlReasonCodeV1Schema),
    payload: payload.nullable(),
  }).strict().superRefine((value, context) => {
    validateCanonicalReasonCodes(value.reasonCodes, context, ["reasonCodes"]);
    if (value.terminalStatus === "success" && value.payload === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "successful queries require a payload" });
    }
    if ((kind === "traversal" || kind === "refinement_coverage") && value.payload !== null) {
      const payload = value.payload as { terminalStatus: string; reasonCode?: string };
      if (value.terminalStatus !== payload.terminalStatus) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminalStatus"],
          message: "envelope terminal status must match payload",
        });
      }
      const expectedReasonCodes = payload.reasonCode === undefined ? [] : [payload.reasonCode];
      if (
        value.reasonCodes.length !== expectedReasonCodes.length
        || value.reasonCodes.some((reason, index) => reason !== expectedReasonCodes[index])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reasonCodes"],
          message: "envelope reason codes must match payload",
        });
      }
    }
    if (value.freshness.verdict === "STALE" || value.freshness.verdict === "UNSEALED") {
      if (value.terminalStatus !== "refused" || !value.reasonCodes.includes("INDEX_STALE")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "stale or unsealed queries must refuse with INDEX_STALE" });
      }
    }
  });
}

export const ControlQueryEnvelopeV1Schema = z.union([
  envelope("coordinate_graph", CoordinateGraphReportV2Schema),
  envelope("traversal", TraversalReportV2Schema),
  envelope("refinement_coverage", RefinementCoverageReportV1Schema),
  envelope("impact", ImpactReportSchema),
  envelope("explanation", ExplanationReportSchema),
  envelope("architecture_comparison", ArchitectureComparisonReportSchema),
  envelope("authorize_transition", TransitionAuthorizationReportV2Schema),
  envelope("authorize_step", StepAuthorizationReportV2Schema),
  envelope("authorize_deletion", DeletionAuthorizationReportV2Schema),
]);

function proofReferenceKey(reference: { kind: string; uri: string; nonLlm: boolean }): string {
  return `${reference.kind}\0${reference.uri}\0${reference.nonLlm ? "1" : "0"}`;
}
function validateSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const keys = values.map(key);
  const sorted = [...keys].sort(compareCodeUnits);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "values must be unique" });
  }
  if (keys.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "values must use canonical ASCII order" });
  }
}
function validateTerminalReason(
  value: { terminalStatus: string; reasonCode?: string },
  context: z.RefinementCtx,
): void {
  const emptyReasons = new Set([
    "COORDINATE_UNKNOWN",
    "MAPPING_MISSING",
    "REFINEMENT_DISCONNECTED",
  ]);
  const valid =
    (value.terminalStatus === "success" && value.reasonCode === undefined)
    || (value.terminalStatus === "budget_exhausted" && value.reasonCode === "BUDGET_EXHAUSTED")
    || (value.terminalStatus === "refused" && value.reasonCode === "INDEX_STALE")
    || (value.terminalStatus === "empty" && value.reasonCode !== undefined && emptyReasons.has(value.reasonCode));
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCode"],
      message: "terminal status and reason code are inconsistent",
    });
  }
}
function validateCanonicalReasonCodes(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "reason codes must be unique" });
  }
  const order = ControlReasonCodeV1Schema.options;
  const sorted = [...values].sort((left, right) => order.indexOf(left as never) - order.indexOf(right as never));
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "reason codes must use canonical order" });
  }
}
function validateAuthorizationOrder(
  value: {
    acceptedAttestations: readonly { id: string }[];
    advisoryRejectedAttestations: readonly { attestationRef: string }[];
  },
  context: z.RefinementCtx,
): void {
  validateSortedUnique(value.acceptedAttestations, (item) => item.id, context, ["acceptedAttestations"]);
  validateSortedUnique(value.advisoryRejectedAttestations, (item) => item.attestationRef, context, ["advisoryRejectedAttestations"]);
}
