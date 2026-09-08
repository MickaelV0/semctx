/**
 * `contributor_check` schema version 1 — optional machine output for `scripts/contributor.ts`.
 *
 * This is local, private tooling data for one contributor's own machine, versioned independently
 * from any privacy-safe support-export surface: it is never intended to be pasted into an issue
 * or shared as-is, and carries no redaction guarantees.
 */

import type { PrerequisiteResult } from "./inspect";
import type { RecipeOutcome } from "./regression-recipe";

export const CONTRIBUTOR_CHECK_SCHEMA_VERSION = 1;
export const CONTRIBUTOR_CHECK_KIND = "contributor_check";

export const CONTRIBUTOR_CHECK_NOTE =
  "Local developer diagnostic only — not a safe public export. It is not the privacy-safe " +
  "support-report surface; do not paste this file into an issue without reviewing its contents.";

export type ContributorCommandKind = "inspect" | "check" | "full" | "recipe";

/**
 * Whether this run could ever stand in for `verify:pr`. Only `full` can; everything else must be
 * printed and read as incomplete, however clean its own result is.
 */
export type ContributorClassification = "read-only" | "targeted" | "full" | "recipe";

export interface ContributorCheckReport {
  readonly schemaVersion: typeof CONTRIBUTOR_CHECK_SCHEMA_VERSION;
  readonly kind: typeof CONTRIBUTOR_CHECK_KIND;
  readonly command: ContributorCommandKind;
  readonly classification: ContributorClassification;
  readonly argv: readonly string[];
  readonly scope: string | null;
  readonly covers: readonly string[];
  readonly omits: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reasons: readonly string[];
  readonly prerequisites: readonly PrerequisiteResult[];
  readonly note: string;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly verification: "incomplete" | "full";
  readonly humanTime: "NOT_MEASURED";
  readonly recipe?: RecipeOutcome;
}

export interface ContributorCheckReportInput {
  readonly recipe?: RecipeOutcome;
  readonly command: ContributorCommandKind;
  readonly classification: ContributorClassification;
  readonly argv: readonly string[];
  readonly scope: string | null;
  readonly covers: readonly string[];
  readonly omits: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reasons: readonly string[];
  readonly prerequisites: readonly PrerequisiteResult[];
}

export function buildContributorCheckReport(input: ContributorCheckReportInput): ContributorCheckReport {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) throw new Error("durationMs must be finite and non-negative");
  return {
    schemaVersion: CONTRIBUTOR_CHECK_SCHEMA_VERSION,
    kind: CONTRIBUTOR_CHECK_KIND,
    note: CONTRIBUTOR_CHECK_NOTE,
    toolVersions: { bun: Bun.version, ...Object.fromEntries(input.prerequisites.filter(p => p.status === "ok" && p.observed !== null).map(p => [p.id, p.observed!])) },
    verification: input.classification === "full" && input.ok ? "full" : "incomplete",
    humanTime: "NOT_MEASURED",
    ...input,
  };
}
