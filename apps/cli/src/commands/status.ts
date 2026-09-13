import { controlStatus } from "@semantic-context/app-services";
import { serializeControlReport } from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, warn } from "../output";

export function runStatus(root: string, args: ParsedArgs): number {
  const report = controlStatus(root);
  info(
    flagBool(args, "json")
      ? serializeControlReport(report)
      : `${report.verdict}${report.reasons.length === 0 ? "" : `: ${report.reasons.join(", ")}`}`,
  );
  if (report.reasons.includes("SEMANTIC_LIFECYCLE_INVALID")) {
    warn("Run semctx semantic check; for EVIDENCE_BASELINE_STALE, recover with semctx index --record.");
  }
  return report.canRunHighRiskControl ? 0 : 3;
}
