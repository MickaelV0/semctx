import {
  probeCliCompatibility,
  type CliCompatibilityReason,
  type CliCompatibilityReport,
} from "@semantic-context/app-services";
import packageJson from "../package.json";

export interface CliCompatibilityPublicReport {
  schemaVersion: 1;
  kind: "cli_compatibility";
  found: boolean;
  version: string | null;
  requiredVersion: string;
  compatible: boolean;
  reason: CliCompatibilityReason;
  upgradeCommand: string;
}

/** Project the local probe into the path-free public MCP contract. */
export function cliCompatibilityTool(
  probe: () => CliCompatibilityReport = () => probeCliCompatibility(packageJson.version),
): CliCompatibilityPublicReport {
  const report = probe();
  return {
    schemaVersion: 1,
    kind: "cli_compatibility",
    found: report.found,
    version: report.version,
    requiredVersion: report.requiredVersion,
    compatible: report.compatible,
    reason: report.reason,
    upgradeCommand: report.upgradeCommand,
  };
}
