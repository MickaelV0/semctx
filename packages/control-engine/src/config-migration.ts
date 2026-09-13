/**
 * Pure config-migration decisions (ADR 0028). No filesystem, no clock, no randomness: every
 * function here is a total, deterministic mapping from already-read facts to a verdict. The
 * orchestration that reads those facts and the mutex/persistence that publishes them live in
 * `app-services` and `repository-store` respectively.
 */

import { compareIds } from "@semantic-context/core";
import {
  CONFIG_MIGRATION_TARGET_CONFIG_PATH,
  canonicalizeControlValue,
  sha256HashCanonicalJson,
} from "@semantic-context/control-model";
import type {
  ConfigMigrationCandidateV1,
  ConfigMigrationDiscoveryLedgerV1,
  ConfigMigrationPlanDetailsV1,
  ConfigMigrationSelectionDiffV1,
} from "@semantic-context/control-model";
import type { Sha256Hash } from "@semantic-context/control-model";

/** Only these fields may differ between the current v1 config and a v2 proposal. */
export const CONFIG_MIGRATION_MIGRATABLE_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "include",
  "exclude",
  "selectionMode",
  "languages",
]);

function selectedPaths(ledger: ConfigMigrationDiscoveryLedgerV1): Set<string> {
  return new Set(
    ledger.candidates
      .filter((candidate: ConfigMigrationCandidateV1) => candidate.selectionDecision === "selected")
      .map((candidate) => candidate.relPath),
  );
}

/** Deterministic added/removed/unchanged over the two full candidate ledgers' selected paths. */
export function diffConfigMigrationSelection(
  legacy: ConfigMigrationDiscoveryLedgerV1,
  proposed: ConfigMigrationDiscoveryLedgerV1,
): ConfigMigrationSelectionDiffV1 {
  const before = selectedPaths(legacy);
  const after = selectedPaths(proposed);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const path of after) (before.has(path) ? unchanged : added).push(path);
  for (const path of before) if (!after.has(path)) removed.push(path);
  return {
    added: added.sort(compareIds),
    removed: removed.sort(compareIds),
    unchanged: unchanged.sort(compareIds),
  };
}

const NOT_PRESENT = Symbol("config-migration-field-not-present");

/** Own-property presence, safe for prototype-named keys (`__proto__`, `hasOwnProperty`, ...). */
function fieldValueOrSentinel(raw: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : NOT_PRESENT;
}

/**
 * Every top-level key present on either side, other than `repositoryRoot` (runtime-only, never
 * serialized) and the five migratable fields, that does not compare canonically equal. Includes
 * unknown fields present in the raw parsed JSON — the caller must pass the *unstripped* object,
 * not a value that has already round-tripped through a schema that drops unrecognized keys.
 * Presence itself is part of the comparison: an explicit `null` and an absent key are distinct,
 * so a field silently dropped (or silently added with a null value) is drift, not a no-op.
 */
export function driftedConfigPolicyFields(
  currentRaw: Readonly<Record<string, unknown>>,
  proposedRaw: Readonly<Record<string, unknown>>,
): string[] {
  const keys = new Set([...Object.keys(currentRaw), ...Object.keys(proposedRaw)]);
  const drifted: string[] = [];
  for (const key of keys) {
    if (key === "repositoryRoot" || CONFIG_MIGRATION_MIGRATABLE_FIELDS.has(key)) continue;
    const leftValue = fieldValueOrSentinel(currentRaw, key);
    const rightValue = fieldValueOrSentinel(proposedRaw, key);
    if (leftValue === NOT_PRESENT && rightValue === NOT_PRESENT) continue;
    if (leftValue === NOT_PRESENT || rightValue === NOT_PRESENT) {
      drifted.push(key);
      continue;
    }
    const left = JSON.stringify(canonicalizeControlValue(leftValue));
    const right = JSON.stringify(canonicalizeControlValue(rightValue));
    if (left !== right) drifted.push(key);
  }
  return drifted.sort(compareIds);
}

/** Whether a caller-supplied plan digest still matches the digest recomputed under the mutex. */
export function isConfigMigrationPlanStale(suppliedDigest: string, recomputedDigest: string): boolean {
  return suppliedDigest !== recomputedDigest;
}

export type ConfigMigrationRestoreOutcome = "finalize" | "rewrite" | "refuse";

/**
 * The crash-recovery rule for a run that is not yet terminal: current config bytes equal to
 * `before` mean the config was never (or no longer) replaced — finalize RESTORED without writing.
 * Equal to `after` means the applied value is still live — rewrite it back to `before` and
 * finalize RESTORED. Anything else is a config that moved for a reason this run cannot know, and
 * must never be overwritten.
 *
 * A run already terminal (`alreadyRestored`) gets a narrower rule: idempotent success only while
 * config still equals `before`; anything else — including a value that happens to equal `after` —
 * is refused. A completed run must never apply a second write, even one that would coincidentally
 * reproduce its own effect; that write could just as well be an unrelated later change.
 */
export function decideConfigMigrationRestoreOutcome(
  currentConfigDigest: string,
  beforeDigest: string,
  afterDigest: string,
  alreadyRestored: boolean,
): ConfigMigrationRestoreOutcome {
  if (currentConfigDigest === beforeDigest) return "finalize";
  if (alreadyRestored) return "refuse";
  if (currentConfigDigest === afterDigest) return "rewrite";
  return "refuse";
}

/**
 * Binds canonical root, the one fixed target config path, both config digests, the complete
 * discovery ledgers and selection diff, and the sorted authored/baseline inventory — never an
 * incidental run id or history, so replanning identical facts always yields the same digest.
 */
export function computeConfigMigrationPlanDigest(
  repositoryRoot: string,
  plan: ConfigMigrationPlanDetailsV1,
): Sha256Hash {
  return sha256HashCanonicalJson({
    repositoryRoot,
    targetConfigPath: CONFIG_MIGRATION_TARGET_CONFIG_PATH,
    currentConfigDigest: plan.currentConfigDigest,
    proposedConfigDigest: plan.proposedConfigDigest,
    legacyDiscovery: plan.legacyDiscovery,
    proposedDiscovery: plan.proposedDiscovery,
    selectionDiff: plan.selectionDiff,
    authoredInventory: plan.authoredInventory,
    verificationState: plan.verificationState,
  });
}
