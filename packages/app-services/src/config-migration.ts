/**
 * Config-migration orchestration (ADR 0028): the only layer that touches the filesystem and the
 * cooperative mutex to answer "what would change", "make it so", and "undo run <id>". Selection
 * comparison, policy-drift and crash-recovery decisions are pure and live in
 * `@semantic-context/control-engine`; the mutex and durable artifact writes live in
 * `@semantic-context/repository-store`. This module reads facts, calls those two, and assembles
 * the versioned report. It never opens the index store and never touches authored `.sem` files or
 * `verification-state.json` beyond inventorying them.
 *
 * Apply and restore each observe that inventory before and after replacing config.json and refuse
 * on any observed drift — an observation inside the supported quiescent worktree, not a global
 * compare-and-swap. Once a run is published, every refusal names it and every thrown failure
 * carries it as `recoveryRunId`, so a landed write is never left without its exact recovery.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  SemctxConfigV1Schema,
  SemctxConfigV2Schema,
  SemctxError,
  isSemctxError,
  normalizePath,
} from "@semantic-context/core";
import type { SemctxConfigV1, SemctxConfigV2 } from "@semantic-context/core";
import { discoverRepository } from "@semantic-context/ts-analyzer";
import {
  assertUnlinkedBelow,
  configMigrationsDir,
  configPath,
  generateConfigMigrationRunId,
  isConfigMigrationStructuralInvalidArtifact,
  isLinkedEntry,
  listAbandonedConfigMigrationPreparations,
  listConfigMigrationRuns,
  publishConfigMigrationRun,
  readConfigMigrationAfter,
  readConfigMigrationBefore,
  readConfigMigrationManifest,
  readCurrentConfigBytes,
  rewriteConfigMigrationManifest,
  runDir,
  swapCurrentConfigBytes,
  verificationStatePath,
  withConfigMigrationLock,
} from "@semantic-context/repository-store";
import {
  CONFIG_MIGRATION_REFUSAL_REASONS,
  CONFIG_MIGRATION_RUN_ID_PATTERN,
  ConfigMigrationReportV1Schema,
  ConfigMigrationRunManifestV1Schema,
  Sha256HashSchema,
  canonicalizeControlValue,
  configMigrationRequiredActions,
  sha256HashBytes,
} from "@semantic-context/control-model";
import type {
  ConfigMigrationDiscoveryLedgerV1,
  ConfigMigrationInventoryEntryV1,
  ConfigMigrationPlanDetailsV1,
  ConfigMigrationReportV1,
  ConfigMigrationRefusalReason,
  ConfigMigrationRunManifestV1,
  ConfigMigrationVerificationStateV1,
  Sha256Hash,
} from "@semantic-context/control-model";
import {
  computeConfigMigrationPlanDigest,
  decideConfigMigrationRestoreOutcome,
  diffConfigMigrationSelection,
  driftedConfigPolicyFields,
} from "@semantic-context/control-engine";
import { canonicalRepositoryRoot } from "./freshness";

function digestOf(bytes: Buffer): Sha256Hash {
  return sha256HashBytes(bytes);
}

function refused(
  operation: ConfigMigrationReportV1["operation"],
  repositoryRoot: string,
  reasons: readonly ConfigMigrationRefusalReason[],
  abandonedPreparations: readonly string[],
  runId: string | null = null,
): ConfigMigrationReportV1 {
  return {
    schemaVersion: 1,
    kind: "config_migration_report",
    operation,
    status: "REFUSED",
    repositoryRoot,
    planDigest: null,
    // Only an admitted run that still requires recovery is ever passed here (see
    // ConfigMigrationReportV1Schema); every pre-publication refusal passes the default `null`.
    runId,
    plan: null,
    reasons: CONFIG_MIGRATION_REFUSAL_REASONS.filter((reason) => reasons.includes(reason)),
    requiredActions: configMigrationRequiredActions("REFUSED", runId),
    abandonedPreparations,
  };
}

function isMutexBusy(error: unknown): boolean {
  return isSemctxError(error) && error.code === "STORE_ERROR" && error.details["reason"] === "MUTEX_BUSY";
}

function isPreimageDrifted(error: unknown): boolean {
  return isSemctxError(error) && error.code === "STORE_ERROR" && error.details["reason"] === "PREIMAGE_DRIFTED";
}

/**
 * Best-effort abandoned-preparation listing for a report that is already refusing for another,
 * unrelated reason (a malformed run-id or mutex contention) without mutating anything: a
 * structural defect elsewhere in `config-migrations/` must not itself crash that unrelated refusal
 * with an unclassified `STORE_ERROR`. The primary listing that actually gates a mutation never uses
 * this: see `listAbandonedPreparationsOrInvalid`.
 */
function abandonedPreparationsForRefusal(root: string): string[] {
  try {
    return listAbandonedConfigMigrationPreparations(root);
  } catch (error) {
    if (isConfigMigrationStructuralInvalidArtifact(error)) return [];
    throw error;
  }
}

/**
 * The gating listing for plan/apply/restore: a structural defect in `config-migrations/` (a
 * malformed, linked, dangling or non-directory `prepare-<run-id>`) must refuse `INVALID_ARTIFACT`
 * before any further read or write, never be silently dropped from the list and never let a
 * schema-shaped report reach `assertConfigMigrationReport` only to fail it after a mutation.
 */
function listAbandonedPreparationsOrInvalid(root: string): { abandoned: string[] } | { invalid: true } {
  try {
    return { abandoned: listAbandonedConfigMigrationPreparations(root) };
  } catch (error) {
    if (isConfigMigrationStructuralInvalidArtifact(error)) return { invalid: true };
    throw error;
  }
}

function errorEvidence(error: Error): Record<string, unknown> {
  const code = (error as NodeJS.ErrnoException).code;
  return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
}

/**
 * A failure thrown after run `runId` was published stays a thrown failure — it is never turned
 * into a REFUSED report — but gains the run's recovery identity in its SemctxError details. The
 * primary failure is kept as `cause` with its message and details, and any suppressed cleanup
 * failures stay attached, both as the `suppressed` property and in the details evidence.
 */
export function attachConfigMigrationRecovery(error: unknown, runId: string): SemctxError {
  const primary = error instanceof Error ? error : new Error(String(error));
  const carried = (primary as { suppressed?: unknown }).suppressed;
  const suppressed = Array.isArray(carried) ? carried.filter((item): item is Error => item instanceof Error) : [];
  const recovery = { recoveryRunId: runId, recoveryCommand: `semctx migrate config --restore ${runId}` };
  const annotated = isSemctxError(primary)
    ? new SemctxError(primary.code, primary.message, { ...primary.details, ...recovery })
    : new SemctxError("IO_ERROR", primary.message, {
      ...recovery,
      cause: errorEvidence(primary),
      ...(suppressed.length > 0 ? { suppressed: suppressed.map(errorEvidence) } : {}),
    });
  Object.defineProperty(annotated, "cause", { value: primary });
  if (suppressed.length > 0) Object.defineProperty(annotated, "suppressed", { value: suppressed });
  return annotated;
}

/**
 * A linked or otherwise unreadable entry is a present-but-refused fact, never an absent one: a
 * directory link over `.semctx/semantic` (or a linked child inside it) is reported as a single
 * `unreadable` inventory row rather than silently shrinking the count to zero, and recursion never
 * follows the link.
 */
function listAuthoredSemanticFiles(root: string): ConfigMigrationInventoryEntryV1[] {
  const semanticDir = join(root, ".semctx", "semantic");
  if (isLinkedEntry(semanticDir)) {
    return [{ relPath: normalizePath(relative(root, semanticDir)), status: "unreadable", digest: null }];
  }
  if (!existsSync(semanticDir)) return [];
  // A present, non-linked, non-directory entry (a plain file where a directory is expected) is a
  // structural refusal, not an absence: `readdirSync` below would throw ENOTDIR. A genuine stat
  // failure here (EACCES/EIO) is a real error and must not be caught and turned into a refusal.
  if (!statSync(semanticDir).isDirectory()) {
    return [{ relPath: normalizePath(relative(root, semanticDir)), status: "unreadable", digest: null }];
  }
  const entries: ConfigMigrationInventoryEntryV1[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const relPath = normalizePath(relative(root, abs));
      if (isLinkedEntry(abs)) {
        entries.push({ relPath, status: "unreadable", digest: null });
        continue;
      }
      let info;
      try {
        info = statSync(abs);
      } catch {
        entries.push({ relPath, status: "unreadable", digest: null });
        continue;
      }
      if (info.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!info.isFile()) {
        entries.push({ relPath, status: "unreadable", digest: null });
        continue;
      }
      if (!name.endsWith(".sem")) continue;
      try {
        entries.push({ relPath, status: "present", digest: digestOf(readFileSync(abs)) });
      } catch {
        entries.push({ relPath, status: "unreadable", digest: null });
      }
    }
  };
  walk(semanticDir);
  return entries.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));
}

/** A linked verification-state.json is present-but-refused, never treated as absent. */
function verificationStateSummary(root: string): ConfigMigrationVerificationStateV1 {
  const path = verificationStatePath(root);
  if (isLinkedEntry(path)) return { present: true, digest: null };
  if (!existsSync(path)) return { present: false, digest: null };
  try {
    return { present: true, digest: digestOf(readFileSync(path)) };
  } catch {
    return { present: true, digest: null };
  }
}

/** Authored `.sem` files and the verification baseline: observed, never written, by this workflow. */
interface ObservedInventory {
  authoredInventory: readonly ConfigMigrationInventoryEntryV1[];
  verificationState: ConfigMigrationVerificationStateV1;
}

function observeInventory(root: string): ObservedInventory {
  return { authoredInventory: listAuthoredSemanticFiles(root), verificationState: verificationStateSummary(root) };
}

/** Whether every observed entry was actually read; a present-but-unreadable fact is not trusted. */
function isReadableInventory(observed: ObservedInventory): boolean {
  return !observed.authoredInventory.some((entry) => entry.status === "unreadable")
    && !(observed.verificationState.present && observed.verificationState.digest === null);
}

/** Exact equality of what was read; an unreadable re-observation never equals a readable start. */
function sameInventory(left: ObservedInventory, right: ObservedInventory): boolean {
  return JSON.stringify(canonicalizeControlValue(left)) === JSON.stringify(canonicalizeControlValue(right));
}

/** Repository-relative, under root, never `config.json` itself and never under `config-migrations/`. */
function resolveProposalPath(root: string, proposalRelPath: string): string {
  if (isAbsolute(proposalRelPath)) {
    throw new SemctxError("CONFIG_INVALID", "proposal must be repository-relative", { proposalRelPath });
  }
  const normalized = normalizePath(proposalRelPath);
  const absolute = join(root, ...normalized.split("/"));
  assertUnlinkedBelow(root, absolute);
  if (absolute === configPath(root)) {
    throw new SemctxError("CONFIG_INVALID", "proposal must not be config.json itself", { path: absolute });
  }
  const insideMigrations = relative(configMigrationsDir(root), absolute);
  const isUnderMigrations = insideMigrations === "" || (!insideMigrations.startsWith("..") && !isAbsolute(insideMigrations));
  if (isUnderMigrations) {
    throw new SemctxError("CONFIG_INVALID", "proposal must not live under .semctx/config-migrations", { path: absolute });
  }
  return absolute;
}

interface ConfigMigrationPlanOk {
  ok: true;
  beforeBytes: Buffer;
  afterBytes: Buffer;
  details: ConfigMigrationPlanDetailsV1;
  planDigest: Sha256Hash;
}

interface ConfigMigrationPlanFailure {
  ok: false;
  reasons: readonly ConfigMigrationRefusalReason[];
}

/** Read-only: inventories current + proposed state and computes the plan digest. No writes. */
function computeConfigMigrationPlan(
  root: string,
  proposalRelPath: string,
): ConfigMigrationPlanOk | ConfigMigrationPlanFailure {
  const repositoryRoot = canonicalRepositoryRoot(root);

  let beforeBytes: Buffer;
  try {
    beforeBytes = readCurrentConfigBytes(root);
  } catch (error) {
    if (isSemctxError(error) && (error.code === "CONFIG_NOT_FOUND" || error.code === "CONFIG_INVALID")) {
      return { ok: false, reasons: ["INVALID_INPUT"] };
    }
    throw error;
  }

  let currentRaw: unknown;
  try {
    currentRaw = JSON.parse(beforeBytes.toString("utf8"));
  } catch {
    return { ok: false, reasons: ["INVALID_INPUT"] };
  }
  if (typeof currentRaw !== "object" || currentRaw === null || Array.isArray(currentRaw)) {
    return { ok: false, reasons: ["INVALID_INPUT"] };
  }
  const currentParsed = SemctxConfigV1Schema.safeParse(currentRaw);
  if (!currentParsed.success) return { ok: false, reasons: ["INVALID_INPUT"] };
  // Discovery walks `config.repositoryRoot` with `readdirSync`/`join`, exactly like `loadConfig`
  // feeds it elsewhere — the native-separator root, not the forward-slash canonical identity used
  // below for the report and the plan digest.
  const discoveryRoot = realpathSync.native(resolve(root));
  const currentConfig: SemctxConfigV1 = { ...currentParsed.data, repositoryRoot: discoveryRoot };

  let proposalAbsolute: string;
  try {
    proposalAbsolute = resolveProposalPath(root, proposalRelPath);
  } catch (error) {
    if (isSemctxError(error)) return { ok: false, reasons: ["INVALID_INPUT"] };
    throw error;
  }
  if (!existsSync(proposalAbsolute) || isLinkedEntry(proposalAbsolute) || !statSync(proposalAbsolute).isFile()) {
    return { ok: false, reasons: ["INVALID_INPUT"] };
  }
  let proposedRaw: unknown;
  try {
    proposedRaw = JSON.parse(readFileSync(proposalAbsolute, "utf8"));
  } catch {
    return { ok: false, reasons: ["INVALID_INPUT"] };
  }
  if (typeof proposedRaw !== "object" || proposedRaw === null || Array.isArray(proposedRaw)) {
    return { ok: false, reasons: ["INVALID_INPUT"] };
  }
  const proposedParsed = SemctxConfigV2Schema.safeParse(proposedRaw);
  if (!proposedParsed.success) return { ok: false, reasons: ["INVALID_INPUT"] };

  const drifted = driftedConfigPolicyFields(
    currentRaw as Record<string, unknown>,
    proposedRaw as Record<string, unknown>,
  );
  if (drifted.length > 0) return { ok: false, reasons: ["POLICY_CHANGE_REJECTED"] };

  const proposedConfig: SemctxConfigV2 = { ...proposedParsed.data, repositoryRoot: discoveryRoot };
  const { repositoryRoot: _proposedRoot, ...proposedRawForDisk } = proposedRaw as Record<string, unknown>;
  // Canonical key ordering, not the proposal file's insertion order: two proposals that agree on
  // every field but were typed in a different order must serialize identically.
  const canonicalProposedForDisk = canonicalizeControlValue(proposedRawForDisk) as Record<string, unknown>;
  const afterBytes = Buffer.from(`${JSON.stringify(canonicalProposedForDisk, null, 2)}\n`, "utf8");

  const legacyDiscovery: ConfigMigrationDiscoveryLedgerV1 = { candidates: discoverRepository(currentConfig).candidates };
  const proposedDiscovery: ConfigMigrationDiscoveryLedgerV1 = { candidates: discoverRepository(proposedConfig).candidates };
  const selectionDiff = diffConfigMigrationSelection(legacyDiscovery, proposedDiscovery);
  const observed = observeInventory(root);

  // A present-but-refused (linked or unreadable) authored file or baseline is never folded into an
  // otherwise-trusted plan: the whole plan is refused, so the caller never signs a digest, or later
  // applies a run, over facts this workflow could not actually read.
  if (!isReadableInventory(observed)) return { ok: false, reasons: ["INVALID_ARTIFACT"] };

  const details: ConfigMigrationPlanDetailsV1 = {
    currentConfigDigest: digestOf(beforeBytes),
    proposedConfigDigest: digestOf(afterBytes),
    legacyDiscovery,
    proposedDiscovery,
    selectionDiff,
    authoredInventory: observed.authoredInventory,
    verificationState: observed.verificationState,
  };
  const planDigest = computeConfigMigrationPlanDigest(repositoryRoot, details);

  return { ok: true, beforeBytes, afterBytes, details, planDigest };
}

/**
 * The report handed to any transport passes the same strict contract a consumer would apply, plus
 * the two facts a schema cannot know: the root is this repository's canonical root, and a trusted
 * plan's digest is the one its details actually hash to. A violation is a defect, never a refusal.
 */
function assertConfigMigrationReport(report: ConfigMigrationReportV1, repositoryRoot: string): ConfigMigrationReportV1 {
  const parsed = ConfigMigrationReportV1Schema.safeParse(report);
  const violations = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "(report)"}: ${issue.message}`);
  if (report.repositoryRoot !== repositoryRoot) violations.push("repositoryRoot: not this repository's canonical root");
  if (
    report.plan !== null
    && report.planDigest !== null
    && computeConfigMigrationPlanDigest(repositoryRoot, report.plan) !== report.planDigest
  ) {
    violations.push("planDigest: does not hash the reported plan");
  }
  if (violations.length > 0) {
    throw new SemctxError("STORE_ERROR", "config-migration report violates its strict contract", {
      reason: "REPORT_CONTRACT_VIOLATION",
      violations,
    });
  }
  return report;
}

/** Deterministic, zero-write comparison of the current v1 config against a v2 proposal. */
export function planConfigMigration(root: string, proposalRelPath: string): ConfigMigrationReportV1 {
  const repositoryRoot = canonicalRepositoryRoot(root);
  const listing = listAbandonedPreparationsOrInvalid(root);
  if ("invalid" in listing) {
    return assertConfigMigrationReport(refused("plan", repositoryRoot, ["INVALID_ARTIFACT"], []), repositoryRoot);
  }
  const abandoned = listing.abandoned;
  const result = computeConfigMigrationPlan(root, proposalRelPath);
  if (!result.ok) return assertConfigMigrationReport(refused("plan", repositoryRoot, result.reasons, abandoned), repositoryRoot);
  return assertConfigMigrationReport({
    schemaVersion: 1,
    kind: "config_migration_report",
    operation: "plan",
    status: "PLANNED",
    repositoryRoot,
    planDigest: result.planDigest,
    runId: null,
    plan: result.details,
    reasons: [],
    requiredActions: configMigrationRequiredActions("PLANNED", null),
    abandonedPreparations: abandoned,
  }, repositoryRoot);
}

/** Validates the manifest's own `runId` against the directory it was read from: a manifest copied
 * or linked from a different run's directory is a distinct-identity artifact, not this run's. */
function readManifest(root: string, runId: string): ConfigMigrationRunManifestV1 | undefined {
  let bytes: Buffer;
  try {
    bytes = readConfigMigrationManifest(root, runId);
  } catch (error) {
    // Unsafe id, missing, linked or non-regular: an invalid artifact. A genuine read failure stays one.
    if (isSemctxError(error)) return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = ConfigMigrationRunManifestV1Schema.safeParse(json);
  if (!parsed.success) return undefined;
  if (parsed.data.runId !== runId) return undefined;
  return parsed.data;
}

interface AdmittedRun {
  manifest: ConfigMigrationRunManifestV1;
  beforeBytes: Buffer;
  afterBytes: Buffer;
}

/**
 * A run is admitted only when its manifest is schema-valid, names this same run id and this
 * canonical root, and both stored config blobs still hash to the digests it binds. Anything less is
 * an invalid artifact: never a recovery identity handed back, and never a terminal RESTORED run
 * that a new apply may step over.
 */
function admitRun(root: string, repositoryRoot: string, runId: string): AdmittedRun | undefined {
  const manifest = readManifest(root, runId);
  if (manifest === undefined || manifest.repositoryRoot !== repositoryRoot) return undefined;
  let beforeBytes: Buffer;
  let afterBytes: Buffer;
  try {
    beforeBytes = readConfigMigrationBefore(root, runId);
    afterBytes = readConfigMigrationAfter(root, runId);
  } catch (error) {
    if (isSemctxError(error)) return undefined;
    throw error;
  }
  if (digestOf(beforeBytes) !== manifest.beforeDigest || digestOf(afterBytes) !== manifest.afterDigest) return undefined;
  return { manifest, beforeBytes, afterBytes };
}

function manifestBytes(manifest: ConfigMigrationRunManifestV1): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Recomputes the plan under the mutex and applies only when `suppliedPlanDigest` still matches. */
export function applyConfigMigration(
  root: string,
  proposalRelPath: string,
  suppliedPlanDigest: string,
): ConfigMigrationReportV1 {
  const repositoryRoot = canonicalRepositoryRoot(root);
  // A digest that is not even a sha256 value can never match: refuse before creating anything.
  if (!Sha256HashSchema.safeParse(suppliedPlanDigest).success) {
    const listing = listAbandonedPreparationsOrInvalid(root);
    return assertConfigMigrationReport("invalid" in listing
      ? refused("apply", repositoryRoot, ["INVALID_INPUT", "INVALID_ARTIFACT"], [])
      : refused("apply", repositoryRoot, ["INVALID_INPUT"], listing.abandoned), repositoryRoot);
  }
  // Set the moment `runs/<run-id>` exists, never before: from then on every refusal names that run
  // and every thrown failure carries it, so a landed write always keeps its exact recovery.
  const recovery: { runId: string | null } = { runId: null };
  try {
    const report = withConfigMigrationLock(root, (): ConfigMigrationReportV1 => {
      const listing = listAbandonedPreparationsOrInvalid(root);
      if ("invalid" in listing) return refused("apply", repositoryRoot, ["INVALID_ARTIFACT"], []);
      const abandoned = listing.abandoned;

      let runNames: string[];
      try {
        runNames = listConfigMigrationRuns(root);
      } catch (error) {
        if (isConfigMigrationStructuralInvalidArtifact(error)) {
          return refused("apply", repositoryRoot, ["INVALID_ARTIFACT"], abandoned);
        }
        throw error;
      }
      const unrestored: string[] = [];
      let invalidRun = false;
      for (const existing of runNames) {
        const run = admitRun(root, repositoryRoot, existing);
        if (run === undefined) invalidRun = true;
        else if (run.manifest.state !== "RESTORED") unrestored.push(existing);
      }
      if (unrestored.length > 0 || invalidRun) {
        const reasons: ConfigMigrationRefusalReason[] = [];
        if (unrestored.length > 0) reasons.push("RECOVERY_REQUIRED");
        if (invalidRun) reasons.push("INVALID_ARTIFACT");
        return refused("apply", repositoryRoot, reasons, abandoned, unrestored[0] ?? null);
      }

      const result = computeConfigMigrationPlan(root, proposalRelPath);
      if (!result.ok) return refused("apply", repositoryRoot, result.reasons, abandoned);
      if (result.planDigest !== suppliedPlanDigest) {
        return refused("apply", repositoryRoot, ["STALE_PLAN"], abandoned);
      }
      const observedAtStart: ObservedInventory = {
        authoredInventory: result.details.authoredInventory,
        verificationState: result.details.verificationState,
      };

      const runId = generateConfigMigrationRunId();
      const manifest: ConfigMigrationRunManifestV1 = {
        schemaVersion: 1,
        kind: "config_migration_run_manifest",
        runId,
        repositoryRoot,
        planDigest: result.planDigest,
        state: "PREPARED",
        beforeDigest: result.details.currentConfigDigest,
        afterDigest: result.details.proposedConfigDigest,
        createdAt: new Date().toISOString(),
      };
      try {
        publishConfigMigrationRun(root, runId, result.beforeBytes, result.afterBytes, manifestBytes(manifest));
      } finally {
        // A failure after the atomic rename (the runs/ directory sync) still published the run.
        if (existsSync(runDir(root, runId))) recovery.runId = runId;
      }
      const drifted = (): ConfigMigrationReportV1 =>
        refused("apply", repositoryRoot, ["STALE_PLAN", "RECOVERY_REQUIRED"], abandoned, runId);

      rewriteConfigMigrationManifest(root, runId, manifestBytes({ ...manifest, state: "APPLYING" }));
      if (!sameInventory(observedAtStart, observeInventory(root))) return drifted();
      try {
        swapCurrentConfigBytes(root, result.beforeBytes, result.afterBytes);
      } catch (error) {
        if (isPreimageDrifted(error)) return refused("apply", repositoryRoot, ["DIVERGENT_CONFIG"], abandoned, runId);
        throw error;
      }
      if (!sameInventory(observedAtStart, observeInventory(root))) return drifted();
      rewriteConfigMigrationManifest(root, runId, manifestBytes({ ...manifest, state: "APPLIED" }));

      return {
        schemaVersion: 1,
        kind: "config_migration_report",
        operation: "apply",
        status: "APPLIED",
        repositoryRoot,
        planDigest: result.planDigest,
        runId,
        plan: result.details,
        reasons: [],
        requiredActions: configMigrationRequiredActions("APPLIED", runId),
        abandonedPreparations: abandoned,
      };
    });
    return assertConfigMigrationReport(report, repositoryRoot);
  } catch (error) {
    if (recovery.runId !== null) throw attachConfigMigrationRecovery(error, recovery.runId);
    if (isConfigMigrationStructuralInvalidArtifact(error)) {
      return assertConfigMigrationReport(refused("apply", repositoryRoot, ["INVALID_ARTIFACT"], []), repositoryRoot);
    }
    if (isMutexBusy(error)) {
      const abandoned = abandonedPreparationsForRefusal(root);
      return assertConfigMigrationReport(refused("apply", repositoryRoot, ["ACTIVE_MIGRATION"], abandoned), repositoryRoot);
    }
    throw error;
  }
}

/**
 * Restore run `runId`. The manifest's `state` field is never the decision: current config bytes
 * compared against the run's recorded before/after digests are — which is what makes this the
 * same code path for an explicit restore and for recovering an interrupted apply or restore.
 */
export function restoreConfigMigration(root: string, runId: string): ConfigMigrationReportV1 {
  const repositoryRoot = canonicalRepositoryRoot(root);
  // A malformed run id can name no run: refuse before creating anything.
  if (!CONFIG_MIGRATION_RUN_ID_PATTERN.test(runId)) {
    const abandoned = abandonedPreparationsForRefusal(root);
    return assertConfigMigrationReport(refused("restore", repositoryRoot, ["INVALID_ARTIFACT"], abandoned), repositoryRoot);
  }
  const recovery: { runId: string | null } = { runId: null };
  try {
    const report = withConfigMigrationLock(root, () => {
      const listing = listAbandonedPreparationsOrInvalid(root);
      if ("invalid" in listing) return refused("restore", repositoryRoot, ["INVALID_ARTIFACT"], []);
      const abandoned = listing.abandoned;
      const run = admitRun(root, repositoryRoot, runId);
      if (run === undefined) return refused("restore", repositoryRoot, ["INVALID_ARTIFACT"], abandoned);
      const { manifest, beforeBytes, afterBytes } = run;
      const terminal = manifest.state === "RESTORED";
      // Admission establishes the recovery identity before any current-config read can fail.
      // A completed run owns nothing and must never become an active recovery again.
      if (!terminal) recovery.runId = runId;
      const restored = (): ConfigMigrationReportV1 => ({
        schemaVersion: 1,
        kind: "config_migration_report",
        operation: "restore",
        status: "RESTORED",
        repositoryRoot,
        planDigest: manifest.planDigest,
        runId,
        plan: null,
        reasons: [],
        requiredActions: configMigrationRequiredActions("RESTORED", runId),
        abandonedPreparations: abandoned,
      });

      let currentBytes: Buffer;
      try {
        currentBytes = readCurrentConfigBytes(root);
      } catch (error) {
        if (isSemctxError(error) && (error.code === "CONFIG_NOT_FOUND" || error.code === "CONFIG_INVALID")) {
          return terminal
            ? refused("restore", repositoryRoot, ["INVALID_ARTIFACT"], abandoned)
            : refused("restore", repositoryRoot, ["RECOVERY_REQUIRED", "INVALID_ARTIFACT"], abandoned, runId);
        }
        throw error;
      }
      const outcome = decideConfigMigrationRestoreOutcome(
        digestOf(currentBytes),
        manifest.beforeDigest,
        manifest.afterDigest,
        terminal,
      );
      // A completed run owns nothing any more: success is a pure observation with no write, and a
      // later value — even one equal to its old candidate — is refused without naming it for recovery.
      if (terminal) return outcome === "finalize" ? restored() : refused("restore", repositoryRoot, ["DIVERGENT_CONFIG"], abandoned);

      if (outcome === "refuse") return refused("restore", repositoryRoot, ["DIVERGENT_CONFIG"], abandoned, runId);

      // Compared with what this restore observes at its own start, never with the historic plan:
      // authored data and the baseline may legitimately evolve after an apply and are never rolled back.
      const observedAtStart = observeInventory(root);
      if (!isReadableInventory(observedAtStart)) {
        return refused("restore", repositoryRoot, ["RECOVERY_REQUIRED", "INVALID_ARTIFACT"], abandoned, runId);
      }
      const drifted = (): ConfigMigrationReportV1 =>
        refused("restore", repositoryRoot, ["RECOVERY_REQUIRED"], abandoned, runId);

      if (outcome === "rewrite") {
        rewriteConfigMigrationManifest(root, runId, manifestBytes({ ...manifest, state: "RESTORING" }));
        if (!sameInventory(observedAtStart, observeInventory(root))) return drifted();
        try {
          swapCurrentConfigBytes(root, afterBytes, beforeBytes);
        } catch (error) {
          if (isPreimageDrifted(error)) return refused("restore", repositoryRoot, ["DIVERGENT_CONFIG"], abandoned, runId);
          throw error;
        }
      }
      if (!sameInventory(observedAtStart, observeInventory(root))) return drifted();
      rewriteConfigMigrationManifest(root, runId, manifestBytes({ ...manifest, state: "RESTORED" }));
      return restored();
    });
    return assertConfigMigrationReport(report, repositoryRoot);
  } catch (error) {
    if (recovery.runId !== null) throw attachConfigMigrationRecovery(error, recovery.runId);
    if (isConfigMigrationStructuralInvalidArtifact(error)) {
      return assertConfigMigrationReport(refused("restore", repositoryRoot, ["INVALID_ARTIFACT"], []), repositoryRoot);
    }
    if (isMutexBusy(error)) {
      const abandoned = abandonedPreparationsForRefusal(root);
      return assertConfigMigrationReport(refused("restore", repositoryRoot, ["ACTIVE_MIGRATION"], abandoned), repositoryRoot);
    }
    throw error;
  }
}
