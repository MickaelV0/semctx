import { describe, expect, it } from "bun:test";
import {
  ConfigMigrationInventoryEntryV1Schema,
  ConfigMigrationPlanDetailsV1Schema,
  ConfigMigrationReportV1Schema,
  ConfigMigrationRunManifestV1Schema,
  ConfigMigrationVerificationStateV1Schema,
} from "@semantic-context/control-model";
import type {
  ConfigMigrationPlanDetailsV1,
  ConfigMigrationReportV1,
  ConfigMigrationRunManifestV1,
  Sha256Hash,
} from "@semantic-context/control-model";

const HASH_A: Sha256Hash = `sha256:${"a".repeat(64)}`;
const HASH_B: Sha256Hash = `sha256:${"b".repeat(64)}`;
const RUN_ID = `1700000000000-${"c".repeat(32)}`;
const REBUILD = ["REBUILD_INDEX", "RERUN_VERIFICATION"] as const;

const emptyLedger = { candidates: [] };

const validPlan: ConfigMigrationPlanDetailsV1 = {
  currentConfigDigest: HASH_A,
  proposedConfigDigest: HASH_B,
  legacyDiscovery: emptyLedger,
  proposedDiscovery: emptyLedger,
  selectionDiff: { added: [], removed: [], unchanged: [] },
  authoredInventory: [],
  verificationState: { present: false, digest: null },
};

function candidate(relPath: string, selectionDecision: "selected" | "excluded" = "selected") {
  return { relPath, language: "typescript", selectionDecision, reason: "SELECTED" };
}

function baseReport(overrides: Partial<ConfigMigrationReportV1>): ConfigMigrationReportV1 {
  return {
    schemaVersion: 1,
    kind: "config_migration_report",
    operation: "plan",
    status: "PLANNED",
    repositoryRoot: "/repo",
    planDigest: HASH_A,
    runId: null,
    plan: validPlan,
    reasons: [],
    requiredActions: [],
    abandonedPreparations: [],
    ...overrides,
  };
}

function refusal(overrides: Partial<ConfigMigrationReportV1>): ConfigMigrationReportV1 {
  return baseReport({ status: "REFUSED", plan: null, planDigest: null, ...overrides });
}

const accepts = (value: unknown): boolean => ConfigMigrationReportV1Schema.safeParse(value).success;

describe("ConfigMigrationInventoryEntryV1Schema", () => {
  it("accepts a present entry with a digest", () => {
    expect(ConfigMigrationInventoryEntryV1Schema.safeParse({ relPath: "a.sem", status: "present", digest: HASH_A }).success).toBe(true);
  });

  it("rejects a present entry without a digest", () => {
    expect(ConfigMigrationInventoryEntryV1Schema.safeParse({ relPath: "a.sem", status: "present", digest: null }).success).toBe(false);
  });

  it("rejects an absent entry carrying a digest", () => {
    expect(ConfigMigrationInventoryEntryV1Schema.safeParse({ relPath: "a.sem", status: "absent", digest: HASH_A }).success).toBe(false);
  });

  it("rejects an unreadable entry carrying a digest", () => {
    expect(ConfigMigrationInventoryEntryV1Schema.safeParse({ relPath: "a.sem", status: "unreadable", digest: HASH_A }).success).toBe(false);
  });

  it("rejects an unsafe or non-canonical repository path", () => {
    for (const relPath of ["../escape.sem", "/abs.sem", "C:/abs.sem", "a\\b.sem", "./a.sem", "a//b.sem", ""]) {
      expect(ConfigMigrationInventoryEntryV1Schema.safeParse({ relPath, status: "present", digest: HASH_A }).success).toBe(false);
    }
  });
});

describe("ConfigMigrationVerificationStateV1Schema", () => {
  it("accepts absent with a null digest", () => {
    expect(ConfigMigrationVerificationStateV1Schema.safeParse({ present: false, digest: null }).success).toBe(true);
  });

  it("rejects absent carrying a digest", () => {
    expect(ConfigMigrationVerificationStateV1Schema.safeParse({ present: false, digest: HASH_A }).success).toBe(false);
  });

  it("rejects a present baseline without its digest (an unreadable one refuses instead)", () => {
    expect(ConfigMigrationVerificationStateV1Schema.safeParse({ present: true, digest: null }).success).toBe(false);
    expect(ConfigMigrationVerificationStateV1Schema.safeParse({ present: true, digest: HASH_A }).success).toBe(true);
  });
});

describe("ConfigMigrationPlanDetailsV1Schema", () => {
  it("accepts a fully-formed plan", () => {
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse(validPlan).success).toBe(true);
  });

  it("rejects an unknown top-level or nested field (strict)", () => {
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse({ ...validPlan, extra: true }).success).toBe(false);
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse({
      ...validPlan,
      selectionDiff: { ...validPlan.selectionDiff, extra: [] },
    }).success).toBe(false);
  });

  it("never trusts a plan carrying an unreadable authored entry", () => {
    const plan = { ...validPlan, authoredInventory: [{ relPath: ".semctx/semantic", status: "unreadable", digest: null }] };
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse(plan).success).toBe(false);
  });

  it("rejects an unsorted or duplicated authored inventory", () => {
    const entry = (relPath: string) => ({ relPath, status: "present" as const, digest: HASH_A });
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse({ ...validPlan, authoredInventory: [entry("b.sem"), entry("a.sem")] }).success).toBe(false);
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse({ ...validPlan, authoredInventory: [entry("a.sem"), entry("a.sem")] }).success).toBe(false);
  });

  it("accepts a selection diff that is exactly the ledgers' difference, and rejects a contradictory one", () => {
    const ledgers = {
      legacyDiscovery: { candidates: [candidate("src/a.ts"), candidate("docs/r.md")] },
      proposedDiscovery: { candidates: [candidate("src/a.ts"), candidate("src/t.py"), candidate("docs/r.md", "excluded")] },
    };
    const consistent = { ...validPlan, ...ledgers, selectionDiff: { added: ["src/t.py"], removed: ["docs/r.md"], unchanged: ["src/a.ts"] } };
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse(consistent).success).toBe(true);
    const hidesRemoval = { ...consistent, selectionDiff: { added: ["src/t.py"], removed: [], unchanged: ["src/a.ts"] } };
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse(hidesRemoval).success).toBe(false);
    const doubleBucket = { ...consistent, selectionDiff: { added: ["src/a.ts", "src/t.py"], removed: ["docs/r.md"], unchanged: ["src/a.ts"] } };
    expect(ConfigMigrationPlanDetailsV1Schema.safeParse(doubleBucket).success).toBe(false);
  });
});

describe("ConfigMigrationReportV1Schema — trust boundary", () => {
  it("accepts a well-formed PLANNED plan report", () => {
    expect(accepts(baseReport({}))).toBe(true);
  });

  it("rejects an extra field, a malformed run id and a non-canonical root", () => {
    expect(accepts({ ...baseReport({}), extra: 1 })).toBe(false);
    for (const runId of ["1-abc", `../${RUN_ID}`, `${RUN_ID}/x`, RUN_ID.toUpperCase()]) {
      expect(accepts(baseReport({ operation: "apply", status: "APPLIED", runId, requiredActions: [...REBUILD] }))).toBe(false);
    }
    for (const repositoryRoot of ["repo", "C:\\repo", "/repo/", "/repo/../x", "/repo//x", ""]) {
      expect(accepts(baseReport({ repositoryRoot }))).toBe(false);
    }
    expect(accepts(baseReport({ repositoryRoot: "C:/Users/x/repo" }))).toBe(true);
  });

  it("rejects a REFUSED report carrying a plan digest", () => {
    expect(accepts(refusal({ planDigest: HASH_A, reasons: ["INVALID_INPUT"] }))).toBe(false);
  });

  it("rejects a REFUSED report carrying an unvalidated trusted plan", () => {
    expect(accepts(refusal({ plan: validPlan, reasons: ["INVALID_INPUT"] }))).toBe(false);
  });

  it("rejects a REFUSED report with no reasons, duplicate reasons, or reasons out of canonical order", () => {
    expect(accepts(refusal({ reasons: [] }))).toBe(false);
    expect(accepts(refusal({ reasons: ["INVALID_INPUT", "INVALID_INPUT"] }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", reasons: ["INVALID_ARTIFACT", "INVALID_INPUT"] }))).toBe(false);
  });

  it("rejects a reason the operation cannot observe", () => {
    expect(accepts(refusal({ operation: "restore", reasons: ["STALE_PLAN"] }))).toBe(false);
    expect(accepts(refusal({ operation: "restore", reasons: ["INVALID_INPUT"] }))).toBe(false);
    expect(accepts(refusal({ operation: "plan", reasons: ["ACTIVE_MIGRATION"] }))).toBe(false);
    expect(accepts(refusal({ operation: "plan", reasons: ["INVALID_ARTIFACT"] }))).toBe(true);
  });

  it("rejects a bare plan operation carrying a run id", () => {
    expect(accepts(baseReport({ runId: RUN_ID }))).toBe(false);
  });

  it("rejects an apply operation missing its run id", () => {
    expect(accepts(baseReport({ operation: "apply", status: "APPLIED", runId: null, requiredActions: [...REBUILD] }))).toBe(false);
  });

  it("accepts a well-formed APPLIED apply report", () => {
    expect(accepts(baseReport({ operation: "apply", status: "APPLIED", runId: RUN_ID, requiredActions: [...REBUILD] }))).toBe(true);
  });

  it("requires a completed report to name the rebuild and re-verification it leaves to the operator", () => {
    expect(accepts(baseReport({ operation: "apply", status: "APPLIED", runId: RUN_ID, requiredActions: [] }))).toBe(false);
    expect(accepts(baseReport({ requiredActions: [...REBUILD] }))).toBe(false);
  });

  it("rejects a restore operation carrying the plan", () => {
    const report = baseReport({ operation: "restore", status: "RESTORED", runId: RUN_ID, plan: validPlan, requiredActions: [...REBUILD] });
    expect(accepts(report)).toBe(false);
  });

  it("accepts a RESTORED report only with its exact admitted run and plan digest", () => {
    const report = baseReport({ operation: "restore", status: "RESTORED", runId: RUN_ID, plan: null, requiredActions: [...REBUILD] });
    expect(accepts(report)).toBe(true);
    expect(accepts({ ...report, planDigest: null })).toBe(false);
    expect(accepts({ ...report, runId: null })).toBe(false);
  });

  it("rejects a REFUSED report carrying a run id for a reason that names no recovery", () => {
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["STALE_PLAN"], requiredActions: ["RESTORE_RUN"] }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["INVALID_ARTIFACT"], requiredActions: ["RESTORE_RUN"] }))).toBe(false);
  });

  it("requires RECOVERY_REQUIRED to name the admitted run, with its restore action", () => {
    expect(accepts(refusal({ operation: "apply", reasons: ["RECOVERY_REQUIRED"] }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["RECOVERY_REQUIRED"] }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["RECOVERY_REQUIRED"], requiredActions: ["RESTORE_RUN"] }))).toBe(true);
    expect(accepts(refusal({
      operation: "apply",
      runId: RUN_ID,
      reasons: ["STALE_PLAN", "RECOVERY_REQUIRED"],
      requiredActions: ["RESTORE_RUN"],
    }))).toBe(true);
    expect(accepts(refusal({ operation: "restore", runId: RUN_ID, reasons: ["RECOVERY_REQUIRED"], requiredActions: ["RESTORE_RUN"] }))).toBe(true);
  });

  it("accepts a REFUSED apply report exposing its own published run when refusing DIVERGENT_CONFIG, and requires it", () => {
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["DIVERGENT_CONFIG"], requiredActions: ["RESTORE_RUN"] }))).toBe(true);
    expect(accepts(refusal({ operation: "apply", reasons: ["DIVERGENT_CONFIG"] }))).toBe(false);
  });

  it("accepts a REFUSED restore report refusing DIVERGENT_CONFIG with or without a recovery run", () => {
    expect(accepts(refusal({ operation: "restore", runId: RUN_ID, reasons: ["DIVERGENT_CONFIG"], requiredActions: ["RESTORE_RUN"] }))).toBe(true);
    expect(accepts(refusal({ operation: "restore", reasons: ["DIVERGENT_CONFIG"] }))).toBe(true);
  });

  it("rejects ACTIVE_MIGRATION combined with any other reason or a run id: the lock was never taken", () => {
    expect(accepts(refusal({
      operation: "apply",
      runId: RUN_ID,
      reasons: ["ACTIVE_MIGRATION", "DIVERGENT_CONFIG"],
      requiredActions: ["RESTORE_RUN"],
    }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", runId: RUN_ID, reasons: ["ACTIVE_MIGRATION"], requiredActions: ["RESTORE_RUN"] }))).toBe(false);
    expect(accepts(refusal({ operation: "apply", reasons: ["ACTIVE_MIGRATION"] }))).toBe(true);
  });

  it("rejects abandoned preparations that are not sorted prepare-<run-id> names", () => {
    const other = `1700000000001-${"d".repeat(32)}`;
    expect(accepts(baseReport({ abandonedPreparations: [`prepare-${RUN_ID}`, `prepare-${other}`] }))).toBe(true);
    expect(accepts(baseReport({ abandonedPreparations: [`prepare-${other}`, `prepare-${RUN_ID}`] }))).toBe(false);
    expect(accepts(baseReport({ abandonedPreparations: ["prepare-../x"] }))).toBe(false);
  });
});

describe("ConfigMigrationRunManifestV1Schema", () => {
  const manifest: ConfigMigrationRunManifestV1 = {
    schemaVersion: 1,
    kind: "config_migration_run_manifest",
    runId: RUN_ID,
    repositoryRoot: "/repo",
    planDigest: HASH_A,
    state: "PREPARED",
    beforeDigest: HASH_A,
    afterDigest: HASH_B,
    createdAt: "2026-09-13T12:00:00.000Z",
  };

  it("accepts a well-formed manifest", () => {
    expect(ConfigMigrationRunManifestV1Schema.safeParse(manifest).success).toBe(true);
  });

  it("rejects a malformed run id, a non-canonical root, a bad timestamp or an extra field", () => {
    expect(ConfigMigrationRunManifestV1Schema.safeParse({ ...manifest, runId: "1-abc" }).success).toBe(false);
    expect(ConfigMigrationRunManifestV1Schema.safeParse({ ...manifest, repositoryRoot: "relative" }).success).toBe(false);
    expect(ConfigMigrationRunManifestV1Schema.safeParse({ ...manifest, createdAt: "yesterday" }).success).toBe(false);
    expect(ConfigMigrationRunManifestV1Schema.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });
});
