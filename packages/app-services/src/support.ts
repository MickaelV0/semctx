/**
 * Privacy-safe support/diagnostic report composition (ADR 0021 / HOK-644).
 *
 * Reuses the existing `workspaceHealth`/`indexHealth` services without copying their raw detail:
 * only a bounded, allowlisted status/reason projection crosses into `SupportReportV1`. Never calls
 * a private host API, never touches the network, never mutates anything.
 */
import {
  SUPPORT_REPORT_SCHEMA_VERSION,
  SupportReportSchema,
  type SupportHealthSectionV1,
  type SupportReasonCode,
  type SupportReportV1,
} from "@semantic-context/core";
import { workspaceHealth, type WorkspaceHealthCheck } from "./doctor";
import { indexHealth, indexHealthStatus, type IndexHealthReportV1 } from "./index-health";

export interface SupportReportDependencies {
  semctxVersion: string;
  bunVersion: string;
  platform: string;
  arch: string;
  /** Injected observation time (ISO 8601), never `Date.now()` inside this pure-ish builder. */
  now: () => string;
}

function projectWorkspaceSection(checks: WorkspaceHealthCheck[]): SupportHealthSectionV1 {
  const workspaceCheck = checks.find((check) => check.name === "workspace");
  if (workspaceCheck?.ok !== true) {
    return { status: "unknown", reasons: ["WORKSPACE_NOT_INITIALIZED"] };
  }
  const configCheck = checks.find((check) => check.name === "config");
  if (configCheck?.ok !== true) {
    return { status: "blocked", reasons: ["CONFIG_INVALID"] };
  }
  return { status: "healthy", reasons: [] };
}

/**
 * An absent index (never indexed) is reported `unknown`, distinct from `blocked`: `blocked` means
 * the health machinery ran and found a concrete problem with a real index; `unknown` means there is
 * nothing yet to evaluate, so no default (healthy or otherwise) is asserted in its place.
 */
function projectIndexSection(report: IndexHealthReportV1): SupportHealthSectionV1 {
  if (report.binding.status === "absent") {
    return { status: "unknown", reasons: ["INDEX_ABSENT"] };
  }
  const reasons: SupportReasonCode[] = [];
  if (report.binding.status === "invalid") reasons.push("INDEX_BINDING_INVALID");
  if (report.freshness.verdict === "UNSEALED") reasons.push("FRESHNESS_UNSEALED");
  if (report.freshness.verdict === "STALE") reasons.push("FRESHNESS_STALE");
  if (report.coverage.status === "partial") reasons.push("INDEX_COVERAGE_PARTIAL");
  if (report.coverage.status === "insufficient") reasons.push("INDEX_COVERAGE_INSUFFICIENT");
  return { status: indexHealthStatus(report), reasons };
}

export function buildSupportReport(root: string, deps: SupportReportDependencies): SupportReportV1 {
  let workspaceSection: SupportHealthSectionV1;
  try {
    workspaceSection = projectWorkspaceSection(workspaceHealth(root).checks);
  } catch {
    workspaceSection = { status: "unknown", reasons: ["HEALTH_CHECK_UNAVAILABLE"] };
  }

  let indexSection: SupportHealthSectionV1;
  try {
    indexSection = projectIndexSection(indexHealth(root));
  } catch {
    indexSection = { status: "unknown", reasons: ["HEALTH_CHECK_UNAVAILABLE"] };
  }

  return SupportReportSchema.parse({
    schemaVersion: SUPPORT_REPORT_SCHEMA_VERSION,
    kind: "support_report",
    observedAt: deps.now(),
    semctxVersion: deps.semctxVersion,
    bunVersion: deps.bunVersion,
    platform: deps.platform,
    arch: deps.arch,
    workspace: workspaceSection,
    index: indexSection,
  });
}
