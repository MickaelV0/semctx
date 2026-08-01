import type {
  MigrationState,
  MigrationStepKind,
  ProofObligation,
  RiskLevel,
} from "./types";

export type ReconciliationMigrationPhaseV1 =
  | "capture_baseline"
  | "characterize_behavior"
  | "define_target_proofs"
  | "introduce_parallel"
  | "shadow_validate"
  | "cutover_replacement"
  | "observe_cutover"
  | "deletion_readiness";

export interface ReconciliationMigrationStepProfileV1 {
  readonly phase: ReconciliationMigrationPhaseV1;
  readonly kind: MigrationStepKind;
  readonly fromState: MigrationState;
  readonly toState: MigrationState;
  readonly risk: RiskLevel;
  readonly completionEvidenceRequirementIds: readonly ProofObligation[];
}

/** DELETED is descriptive state only and grants no deletion capability. */
export const RECONCILIATION_MIGRATION_STEP_PROFILES_V1 = Object.freeze([
  step("capture_baseline", "capture", "OBSERVED", "MODELED", "R0", ["baseline_captured"]),
  step("characterize_behavior", "characterize", "MODELED", "TARGET_PROPOSED", "R0", ["behavior_characterized"]),
  step("define_target_proofs", "introduce", "TARGET_PROPOSED", "PROOFS_DEFINED", "R1", ["target_reviewed"]),
  step("introduce_parallel", "introduce", "PROOFS_DEFINED", "PARALLEL_IMPLEMENTATION", "R1", ["replacement_present"]),
  step("shadow_validate", "shadow_compare", "PARALLEL_IMPLEMENTATION", "SHADOW_VALIDATED", "R2", ["shadow_equivalent", "invariants_preserved", "rollback_ready"]),
  step("cutover_replacement", "cutover", "SHADOW_VALIDATED", "CUTOVER", "R3", ["cutover_approved", "invariants_preserved", "rollback_ready"]),
  step("observe_cutover", "observe", "CUTOVER", "LEGACY_REMOVABLE", "R2", ["observation_window_passed", "rollback_ready"]),
  step("deletion_readiness", "deletion_check", "LEGACY_REMOVABLE", "DELETED", "R3", [
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
  ]),
]) satisfies readonly Readonly<ReconciliationMigrationStepProfileV1>[];

function step(
  phase: ReconciliationMigrationPhaseV1,
  kind: ReconciliationMigrationStepProfileV1["kind"],
  fromState: ReconciliationMigrationStepProfileV1["fromState"],
  toState: ReconciliationMigrationStepProfileV1["toState"],
  risk: ReconciliationMigrationStepProfileV1["risk"],
  completionEvidenceRequirementIds: readonly ProofObligation[],
): Readonly<ReconciliationMigrationStepProfileV1> {
  return Object.freeze({
    phase,
    kind,
    fromState,
    toState,
    risk,
    completionEvidenceRequirementIds: Object.freeze([...completionEvidenceRequirementIds]),
  });
}
