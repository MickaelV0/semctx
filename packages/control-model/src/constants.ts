import type {
  CoordinateCategory,
  EpistemicStatus,
  MigrationState,
  MigrationStepProfileDefinition,
  MigrationStepKind,
  ProofObligation,
  ProofObligationPolicy,
  RiskLevel,
  SemanticLevel,
  SourceKindLevelMapping,
} from "./types";
import { compareCodeUnits } from "./ordering";
import { RECONCILIATION_MIGRATION_STEP_PROFILES_V1 } from "./reconciliation-migration";

export const SEMANTIC_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const satisfies readonly SemanticLevel[];

/** Hash of the canonical empty Git working-diff capture (`{ "entries": [] }`). */
export { CLEAN_CONTROL_WORKING_DIFF_HASH } from "./freshness";

export const EPISTEMIC_STATUSES = [
  "human_declared",
  "statically_observed",
  "dynamically_observed",
  "test_observed",
  "historically_observed",
  "llm_inferred",
  "hypothetical",
] as const satisfies readonly EpistemicStatus[];

export const COORDINATE_CATEGORIES = [
  "syntax",
  "code_entity",
  "module",
  "bounded_context",
  "capability",
  "invariant",
  "policy",
  "goal",
  "decision",
  "system",
  "strategy",
] as const satisfies readonly CoordinateCategory[];

const repositoryKinds = [
  "repository", "decision", "invariant", "capability", "package", "module",
  "bounded_context", "symbol", "type", "function", "class", "interface", "enum",
  "test", "migration", "document", "contract", "risk", "external_integration",
] as const;

export const REPOSITORY_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = repositoryKinds
  .map((sourceKind) => ({
    plane: "repo" as const,
    sourceKind,
    level: null,
    category: null,
    supported: false,
    reason: "explicit_applies_at_level_required",
  }))
  .sort((a, b) => compareCodeUnits(a.sourceKind, b.sourceKind));

const semanticKinds = [
  "goal", "decision", "invariant", "assumption", "unknown", "evidence", "change",
] as const;

const semanticLevelMapping: SourceKindLevelMapping[] = semanticKinds.map((sourceKind) => ({
  plane: "semantic",
  sourceKind,
  level: null,
  category: null,
  supported: false,
  reason: "explicit_applies_at_level_required",
}));

export const SEMANTIC_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = semanticLevelMapping
  .sort((a, b) => compareCodeUnits(a.sourceKind, b.sourceKind));

export const NORMATIVE_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = [
  ...REPOSITORY_LEVEL_MAPPING,
  ...SEMANTIC_LEVEL_MAPPING,
];

export const MIGRATION_STATES = [
  "OBSERVED",
  "MODELED",
  "TARGET_PROPOSED",
  "PROOFS_DEFINED",
  "PARALLEL_IMPLEMENTATION",
  "SHADOW_VALIDATED",
  "CUTOVER",
  "LEGACY_REMOVABLE",
  "DELETED",
] as const satisfies readonly MigrationState[];

export const MIGRATION_STEP_KINDS = [
  "capture",
  "characterize",
  "introduce",
  "shadow_compare",
  "cutover",
  "observe",
  "deletion_check",
] as const satisfies readonly MigrationStepKind[];

export const RISK_LEVELS = ["R0", "R1", "R2", "R3"] as const satisfies readonly RiskLevel[];

export const PROOF_OBLIGATIONS = [
  "baseline_captured",
  "behavior_characterized",
  "target_reviewed",
  "replacement_present",
  "shadow_equivalent",
  "cutover_approved",
  "observation_window_passed",
  "static_dependencies_zero",
  "runtime_dependencies_zero",
  "invariants_preserved",
  "data_migration_complete",
  "rollback_ready",
  "deletion_approved",
] as const satisfies readonly ProofObligation[];

const deletionReadinessProfile = RECONCILIATION_MIGRATION_STEP_PROFILES_V1.at(-1)!;

export const DELETION_PREREQUISITE_OBLIGATIONS = Object.freeze(
  deletionReadinessProfile.completionEvidenceRequirementIds
    .filter((obligation) => obligation !== "deletion_approved"),
) as readonly ProofObligation[];

/** The only eight migration transition profiles accepted by Plane C. */
export const MIGRATION_STEP_PROFILES: readonly Readonly<MigrationStepProfileDefinition>[] =
  Object.freeze(RECONCILIATION_MIGRATION_STEP_PROFILES_V1.map((entry) => profile(
    entry.phase === "deletion_readiness" ? "authorize_deletion" : entry.phase,
    entry.kind,
    entry.fromState,
    entry.toState,
    entry.risk,
    [...entry.completionEvidenceRequirementIds],
  )));

export const PROOF_SUFFICIENCY_MATRIX: Readonly<Record<ProofObligation, ProofObligationPolicy>> = {
  baseline_captured: policy("baseline_captured", [["statically_observed", "dynamically_observed"]]),
  behavior_characterized: policy("behavior_characterized", [["test_observed", "dynamically_observed"]]),
  target_reviewed: policy("target_reviewed", [["human_declared"]], [], {
    referenceKinds: ["architecture"], requireNonLlmReference: true,
  }),
  replacement_present: policy("replacement_present", [["statically_observed"]]),
  shadow_equivalent: policy("shadow_equivalent", [["test_observed"], ["dynamically_observed"]]),
  cutover_approved: policy("cutover_approved", [["human_declared"], ["test_observed", "dynamically_observed"]]),
  observation_window_passed: policy("observation_window_passed", [["dynamically_observed"]]),
  static_dependencies_zero: policy("static_dependencies_zero", [["statically_observed"]]),
  runtime_dependencies_zero: policy("runtime_dependencies_zero", [["dynamically_observed"]]),
  invariants_preserved: policy("invariants_preserved", [["test_observed"]]),
  data_migration_complete: policy("data_migration_complete", [["dynamically_observed", "test_observed"]]),
  rollback_ready: policy("rollback_ready", [["test_observed"]]),
  deletion_approved: policy("deletion_approved", [["human_declared"]], [...DELETION_PREREQUISITE_OBLIGATIONS]),
};

function policy(
  obligation: ProofObligation,
  statusClauses: EpistemicStatus[][],
  prerequisiteObligations: ProofObligation[] = [],
  referenceRequirement?: { referenceKinds: ("architecture")[]; requireNonLlmReference: boolean },
): ProofObligationPolicy {
  return {
    obligation,
    allOf: statusClauses.map((statuses, index) => ({
      statuses,
      ...(index === 0 && referenceRequirement ? referenceRequirement : {}),
    })),
    prerequisiteObligations,
  };
}

function profile(
  profileName: MigrationStepProfileDefinition["profile"],
  kind: MigrationStepKind,
  fromState: MigrationState,
  toState: MigrationState,
  risk: RiskLevel,
  minimumProofObligations: ProofObligation[],
): Readonly<MigrationStepProfileDefinition> {
  return Object.freeze({ profile: profileName, kind, fromState, toState, risk, minimumProofObligations: Object.freeze([...minimumProofObligations]) as ProofObligation[] });
}
