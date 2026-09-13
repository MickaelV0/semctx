import { z } from "zod";
import { compareCodeUnits } from "./ordering";
import { Sha256HashSchema } from "./primitive-schemas";
import { CanonicalRepoRelativePathSchema } from "./task-envelope-schemas";
import {
  CONFIG_MIGRATION_REFUSAL_REASONS,
  CONFIG_MIGRATION_REQUIRED_ACTIONS,
  CONFIG_MIGRATION_RUN_ID_PATTERN,
  configMigrationRequiredActions,
} from "./config-migration-types";
import type { ConfigMigrationOperation, ConfigMigrationRefusalReason } from "./config-migration-types";

export const ConfigMigrationRefusalReasonSchema = z.enum(CONFIG_MIGRATION_REFUSAL_REASONS);

export const ConfigMigrationRequiredActionSchema = z.enum(CONFIG_MIGRATION_REQUIRED_ACTIONS);

/** Exactly the shape the store allocates; anything else never names a run. */
export const ConfigMigrationRunIdSchema = z
  .string()
  .regex(CONFIG_MIGRATION_RUN_ID_PATTERN, "expected <epoch-ms>-<32 lowercase hex>");

/**
 * The `canonicalRepositoryRoot` shape: absolute, forward-slash, no empty/dot segments and no
 * trailing slash. No shared control-model schema names a canonical root yet, so this is the
 * narrowest check that still rejects a relative, backslashed or dotted identity. Whether it is the
 * *right* root is the service's comparison against the live canonical root; a schema cannot know.
 */
export const ConfigMigrationRepositoryRootSchema = z.string().min(1).superRefine((value, ctx) => {
  const prefixLength = /^[A-Za-z]:\//.test(value) ? 3 : value.startsWith("//") ? 2 : value.startsWith("/") ? 1 : -1;
  const rest = prefixLength < 0 ? "" : value.slice(prefixLength);
  const canonical = prefixLength >= 0
    && !value.includes("\0")
    && !value.includes("\\")
    && (rest === "" || rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
  if (!canonical) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a canonical absolute forward-slash repository root" });
  }
});

const PREPARATION_PREFIX = "prepare-";

const ConfigMigrationPreparationNameSchema = z.string().refine(
  (name) => name.startsWith(PREPARATION_PREFIX) && CONFIG_MIGRATION_RUN_ID_PATTERN.test(name.slice(PREPARATION_PREFIX.length)),
  "expected prepare-<run-id>",
);

function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareCodeUnits(values[index - 1] as string, value) < 0);
}

export const ConfigMigrationCandidateV1Schema = z
  .object({
    relPath: CanonicalRepoRelativePathSchema,
    language: z.string(),
    selectionDecision: z.enum(["selected", "excluded"]),
    analysisOutcome: z.string().optional(),
    reason: z.string(),
  })
  .strict();

export const ConfigMigrationDiscoveryLedgerV1Schema = z
  .object({
    candidates: z.array(ConfigMigrationCandidateV1Schema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.candidates.map((candidate) => candidate.relPath);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a discovery ledger lists each path once", path: ["candidates"] });
    }
  });

/** Each bucket sorted and unique, and no path in two buckets. */
export const ConfigMigrationSelectionDiffV1Schema = z
  .object({
    added: z.array(CanonicalRepoRelativePathSchema),
    removed: z.array(CanonicalRepoRelativePathSchema),
    unchanged: z.array(CanonicalRepoRelativePathSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const bucket of ["added", "removed", "unchanged"] as const) {
      if (!isStrictlyAscending(value[bucket])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "selection paths must be sorted and unique", path: [bucket] });
      }
    }
    const all = [...value.added, ...value.removed, ...value.unchanged];
    if (new Set(all).size !== all.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a path belongs to exactly one selection bucket" });
    }
  });

/** Presence itself matters: a `present` entry must carry a digest; anything else must not. */
export const ConfigMigrationInventoryEntryV1Schema = z
  .object({
    relPath: CanonicalRepoRelativePathSchema,
    status: z.enum(["present", "absent", "unreadable"]),
    digest: Sha256HashSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "present" && value.digest === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a present inventory entry must carry a digest",
        path: ["digest"],
      });
    }
    if (value.status !== "present" && value.digest !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an absent or unreadable inventory entry must not carry a digest",
        path: ["digest"],
      });
    }
  });

/** A present baseline carries its digest; an unreadable one is refused upstream, never reported. */
export const ConfigMigrationVerificationStateV1Schema = z
  .object({
    present: z.boolean(),
    digest: Sha256HashSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.present && value.digest === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a present verification state must carry its digest",
        path: ["digest"],
      });
    }
    if (!value.present && value.digest !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an absent verification state must not carry a digest",
        path: ["digest"],
      });
    }
  });

function selectedPaths(candidates: readonly { relPath: string; selectionDecision: string }[]): Set<string> {
  return new Set(candidates.filter((candidate) => candidate.selectionDecision === "selected").map((candidate) => candidate.relPath));
}

function sameMembers(values: readonly string[], expected: ReadonlySet<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

/**
 * A trusted plan: never an unreadable authored row (planning refuses those), a sorted unique
 * inventory, and a selection diff that is exactly the difference of the two ledgers' selections.
 */
export const ConfigMigrationPlanDetailsV1Schema = z
  .object({
    currentConfigDigest: Sha256HashSchema,
    proposedConfigDigest: Sha256HashSchema,
    legacyDiscovery: ConfigMigrationDiscoveryLedgerV1Schema,
    proposedDiscovery: ConfigMigrationDiscoveryLedgerV1Schema,
    selectionDiff: ConfigMigrationSelectionDiffV1Schema,
    authoredInventory: z.array(ConfigMigrationInventoryEntryV1Schema),
    verificationState: ConfigMigrationVerificationStateV1Schema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const issue = (message: string, path: string[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    if (plan.authoredInventory.some((entry) => entry.status === "unreadable")) {
      issue("a trusted plan never carries an unreadable authored entry", ["authoredInventory"]);
    }
    if (!isStrictlyAscending(plan.authoredInventory.map((entry) => entry.relPath))) {
      issue("the authored inventory must be sorted and unique", ["authoredInventory"]);
    }
    const legacy = selectedPaths(plan.legacyDiscovery.candidates);
    const proposed = selectedPaths(plan.proposedDiscovery.candidates);
    const { added, removed, unchanged } = plan.selectionDiff;
    const consistent = sameMembers([...added, ...unchanged], proposed)
      && sameMembers([...removed, ...unchanged], legacy)
      && added.every((path) => !legacy.has(path))
      && removed.every((path) => !proposed.has(path));
    if (!consistent) issue("the selection diff contradicts the two discovery ledgers", ["selectionDiff"]);
  });

/** Which operation can legitimately observe each refusal reason. */
const REASON_OPERATIONS: Readonly<Record<ConfigMigrationRefusalReason, readonly ConfigMigrationOperation[]>> = {
  INVALID_INPUT: ["plan", "apply"],
  POLICY_CHANGE_REJECTED: ["plan", "apply"],
  STALE_PLAN: ["apply"],
  ACTIVE_MIGRATION: ["apply", "restore"],
  RECOVERY_REQUIRED: ["apply", "restore"],
  INVALID_ARTIFACT: ["plan", "apply", "restore"],
  DIVERGENT_CONFIG: ["apply", "restore"],
};

/**
 * The operation/status/nullability/reasons matrix is the trust boundary: a refused report never
 * carries a plan or plan digest, a bare plan never carries a run id, and a restore never carries
 * the plan (it is keyed by the admitted run, whose plan digest it reports). A refused report may
 * carry a run id only for an admitted run that still requires recovery — `RECOVERY_REQUIRED`
 * (which must name it) or `DIVERGENT_CONFIG` (which an apply only reaches after publishing its own
 * run) — so a run id on a refusal is always an already-validated identity, never one lifted from an
 * artifact that failed validation. `ACTIVE_MIGRATION` means the lock was never taken, so no other
 * fact can accompany it.
 */
export const ConfigMigrationReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("config_migration_report"),
    operation: z.enum(["plan", "apply", "restore"]),
    status: z.enum(["PLANNED", "APPLIED", "RESTORED", "REFUSED"]),
    repositoryRoot: ConfigMigrationRepositoryRootSchema,
    planDigest: Sha256HashSchema.nullable(),
    runId: ConfigMigrationRunIdSchema.nullable(),
    plan: ConfigMigrationPlanDetailsV1Schema.nullable(),
    reasons: z.array(ConfigMigrationRefusalReasonSchema),
    requiredActions: z.array(ConfigMigrationRequiredActionSchema),
    abandonedPreparations: z.array(ConfigMigrationPreparationNameSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: string[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    if (!isStrictlyAscending(value.abandonedPreparations)) {
      issue("abandoned preparations must be sorted and unique", ["abandonedPreparations"]);
    }
    const expectedActions = configMigrationRequiredActions(value.status, value.runId);
    if (
      value.requiredActions.length !== expectedActions.length
      || value.requiredActions.some((action, index) => action !== expectedActions[index])
    ) {
      issue(`required actions must be exactly [${expectedActions.join(", ")}]`, ["requiredActions"]);
    }
    if (value.status === "REFUSED") {
      if (value.planDigest !== null) issue("a refused report must not carry a plan digest", ["planDigest"]);
      if (value.plan !== null) issue("a refused report must not carry an unvalidated trusted plan", ["plan"]);
      if (value.reasons.length === 0) issue("a refused report must name at least one reason", ["reasons"]);
      const ranks = value.reasons.map((reason) => CONFIG_MIGRATION_REFUSAL_REASONS.indexOf(reason));
      if (!ranks.every((rank, index) => index === 0 || (ranks[index - 1] as number) < rank)) {
        issue("refusal reasons must be unique and in canonical order", ["reasons"]);
      }
      for (const reason of value.reasons) {
        if (!REASON_OPERATIONS[reason].includes(value.operation)) {
          issue(`${reason} cannot refuse a ${value.operation} operation`, ["reasons"]);
        }
      }
      if (value.reasons.includes("ACTIVE_MIGRATION") && value.reasons.length > 1) {
        issue("ACTIVE_MIGRATION means the lock was never taken; no other reason can accompany it", ["reasons"]);
      }
      const namesRecoveryRun = value.reasons.includes("RECOVERY_REQUIRED") || value.reasons.includes("DIVERGENT_CONFIG");
      if (value.runId !== null && !namesRecoveryRun) {
        issue("a refused report may only carry an admitted run that requires recovery", ["runId"]);
      }
      if (value.runId === null && value.reasons.includes("RECOVERY_REQUIRED")) {
        issue("RECOVERY_REQUIRED must name the admitted run to restore", ["runId"]);
      }
      if (value.runId === null && value.operation === "apply" && value.reasons.includes("DIVERGENT_CONFIG")) {
        issue("an apply only diverges after publishing its own run, which it must name", ["runId"]);
      }
      return;
    }
    if (value.reasons.length > 0) issue("a non-refused report must not carry refusal reasons", ["reasons"]);
    if (value.operation === "plan") {
      if (value.status !== "PLANNED") issue("a plan operation must report PLANNED or REFUSED", ["status"]);
      if (value.plan === null) issue("a planned report must carry a validated plan", ["plan"]);
      if (value.planDigest === null) issue("a planned report must carry a plan digest", ["planDigest"]);
      if (value.runId !== null) issue("a bare plan must not carry a run id", ["runId"]);
    }
    if (value.operation === "apply") {
      if (value.status !== "APPLIED") issue("an apply operation must report APPLIED or REFUSED", ["status"]);
      if (value.plan === null) issue("an applied report must carry a validated plan", ["plan"]);
      if (value.planDigest === null) issue("an applied report must carry a plan digest", ["planDigest"]);
      if (value.runId === null) issue("an applied report must carry a run id", ["runId"]);
    }
    if (value.operation === "restore") {
      if (value.status !== "RESTORED") issue("a restore operation must report RESTORED or REFUSED", ["status"]);
      if (value.plan !== null) issue("a restore report must not carry the plan", ["plan"]);
      if (value.runId === null) issue("a restored report must carry the exact admitted run", ["runId"]);
      if (value.planDigest === null) issue("a restored report must carry the admitted run's plan digest", ["planDigest"]);
    }
  });

export const ConfigMigrationRunStateSchema = z.enum([
  "PREPARED",
  "APPLYING",
  "APPLIED",
  "RESTORING",
  "RESTORED",
]);

export const ConfigMigrationRunManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("config_migration_run_manifest"),
    runId: ConfigMigrationRunIdSchema,
    repositoryRoot: ConfigMigrationRepositoryRootSchema,
    planDigest: Sha256HashSchema,
    state: ConfigMigrationRunStateSchema,
    beforeDigest: Sha256HashSchema,
    afterDigest: Sha256HashSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
