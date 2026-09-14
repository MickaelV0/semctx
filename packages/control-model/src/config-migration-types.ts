/**
 * Config-migration public contract (Plane C payload) — see ADR 0028.
 *
 * `plan` never writes. `apply` binds itself to one previously computed plan by its digest and
 * refuses when the repository has moved since. `restore` is keyed by an explicit run id. Every
 * refusal names a distinct repair, matching the anchor-migration authority convention: an operator
 * reading `reasons` should never have to guess which one of several unrelated repairs applies.
 */

import type { Sha256Hash } from "./types";

export type ConfigMigrationOperation = "plan" | "apply" | "restore";

export type ConfigMigrationStatus = "PLANNED" | "APPLIED" | "RESTORED" | "REFUSED";

/**
 * Each reason is a distinct repair:
 *  - INVALID_INPUT           — malformed/missing proposal, non-v1 current config, schema failure.
 *  - POLICY_CHANGE_REJECTED  — a non-selection or unknown policy field would silently change.
 *  - STALE_PLAN              — the caller's plan digest no longer matches recomputed state, or the
 *                              authored `.sem` / verification-state inventory the plan bound moved
 *                              while the apply was running.
 *  - ACTIVE_MIGRATION        — the cooperative mutex is held by another live process right now.
 *  - RECOVERY_REQUIRED       — a published run exists and is not yet RESTORED; the report names it.
 *  - INVALID_ARTIFACT        — a run id, manifest, digest or path safety check failed, or an authored
 *                              `.sem` / verification-state entry could not be read, before any write.
 *  - DIVERGENT_CONFIG        — current config bytes match neither the run's before nor after value.
 */
export const CONFIG_MIGRATION_REFUSAL_REASONS = [
  "INVALID_INPUT",
  "POLICY_CHANGE_REJECTED",
  "STALE_PLAN",
  "ACTIVE_MIGRATION",
  "RECOVERY_REQUIRED",
  "INVALID_ARTIFACT",
  "DIVERGENT_CONFIG",
] as const;

export type ConfigMigrationRefusalReason = (typeof CONFIG_MIGRATION_REFUSAL_REASONS)[number];

/**
 * What the operator must do next, named in the JSON contract and not only in rendered text:
 *  - RESTORE_RUN         — `semctx migrate config --restore <runId>` for the report's own run id.
 *  - REBUILD_INDEX       — rebuild the index; an index built under the other config never becomes current.
 *  - RERUN_VERIFICATION  — re-run the existing verification flow; earlier proof is never restamped.
 */
export const CONFIG_MIGRATION_REQUIRED_ACTIONS = ["RESTORE_RUN", "REBUILD_INDEX", "RERUN_VERIFICATION"] as const;

export type ConfigMigrationRequiredAction = (typeof CONFIG_MIGRATION_REQUIRED_ACTIONS)[number];

/** `<epoch-ms, 13+ digits>-<32 lowercase hex>`: the only run id shape ever allocated or admitted. */
export const CONFIG_MIGRATION_RUN_ID_PATTERN = /^[0-9]{13,}-[0-9a-f]{32}$/;

/**
 * The exact required actions for a report — one rule shared by the producer and the schema. A
 * completed apply/restore always requires a rebuild and re-verification; a refusal requires the
 * restore of the run it names (only ever an admitted, unfinished run), and nothing otherwise.
 */
export function configMigrationRequiredActions(
  status: ConfigMigrationStatus,
  runId: string | null,
): ConfigMigrationRequiredAction[] {
  if (status === "APPLIED" || status === "RESTORED") return ["REBUILD_INDEX", "RERUN_VERIFICATION"];
  if (status === "REFUSED" && runId !== null) return ["RESTORE_RUN"];
  return [];
}

export interface ConfigMigrationCandidateV1 {
  relPath: string;
  language: string;
  selectionDecision: "selected" | "excluded";
  analysisOutcome?: string;
  reason: string;
}

export interface ConfigMigrationDiscoveryLedgerV1 {
  candidates: readonly ConfigMigrationCandidateV1[];
}

/** Sorted, deterministic. An empty `added`/`removed` with a non-empty `unchanged` is a real answer. */
export interface ConfigMigrationSelectionDiffV1 {
  added: readonly string[];
  removed: readonly string[];
  unchanged: readonly string[];
}

export interface ConfigMigrationInventoryEntryV1 {
  relPath: string;
  /** Absence is a distinct, real answer from an unreadable entry; never coerced to one. */
  status: "present" | "absent" | "unreadable";
  digest: Sha256Hash | null;
}

/** A present baseline always carries its digest in the contract; an unreadable one refuses instead. */
export interface ConfigMigrationVerificationStateV1 {
  present: boolean;
  digest: Sha256Hash | null;
}

export interface ConfigMigrationPlanDetailsV1 {
  currentConfigDigest: Sha256Hash;
  proposedConfigDigest: Sha256Hash;
  legacyDiscovery: ConfigMigrationDiscoveryLedgerV1;
  proposedDiscovery: ConfigMigrationDiscoveryLedgerV1;
  selectionDiff: ConfigMigrationSelectionDiffV1;
  authoredInventory: readonly ConfigMigrationInventoryEntryV1[];
  verificationState: ConfigMigrationVerificationStateV1;
}

export interface ConfigMigrationReportV1 {
  schemaVersion: 1;
  kind: "config_migration_report";
  operation: ConfigMigrationOperation;
  status: ConfigMigrationStatus;
  repositoryRoot: string;
  /** Present on a trusted PLANNED/APPLIED report and on RESTORED (the run's plan); null on REFUSED. */
  planDigest: Sha256Hash | null;
  /**
   * Present once a run has been created (apply/restore); null for a bare plan. On a REFUSED report,
   * present only for an admitted run that still requires recovery — `RECOVERY_REQUIRED` or
   * `DIVERGENT_CONFIG` — never for an artifact that failed validation (see
   * `ConfigMigrationReportV1Schema`).
   */
  runId: string | null;
  /** Null on refusal and on restore, where the plan is not the trust-bearing artifact. */
  plan: ConfigMigrationPlanDetailsV1 | null;
  reasons: readonly ConfigMigrationRefusalReason[];
  /** Exactly `configMigrationRequiredActions(status, runId)`. */
  requiredActions: readonly ConfigMigrationRequiredAction[];
  /** `prepare-<run-id>` directories that were never published. Reported, never removed. */
  abandonedPreparations: readonly string[];
}

export type ConfigMigrationRunState = "PREPARED" | "APPLYING" | "APPLIED" | "RESTORING" | "RESTORED";

/**
 * Published under `runs/<run-id>/manifest.json`. Binds root, run id, the plan digest that
 * authorized the apply, and the fixed artifact digests — never incidental run history.
 */
export interface ConfigMigrationRunManifestV1 {
  schemaVersion: 1;
  kind: "config_migration_run_manifest";
  runId: string;
  repositoryRoot: string;
  planDigest: Sha256Hash;
  state: ConfigMigrationRunState;
  beforeDigest: Sha256Hash;
  afterDigest: Sha256Hash;
  createdAt: string;
}

export const CONFIG_MIGRATION_MANIFEST_FILE = "manifest.json";
export const CONFIG_MIGRATION_BEFORE_FILE = "before.json";
export const CONFIG_MIGRATION_AFTER_FILE = "after.json";

/** The one target the plan digest ever binds; fixed, so it need not be an input to the caller. */
export const CONFIG_MIGRATION_TARGET_CONFIG_PATH = ".semctx/config.json";
