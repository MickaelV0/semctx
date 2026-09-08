import packageJson from "../../package.json";
import { buildSupportReport } from "@semantic-context/app-services";
import { SemctxError } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagString } from "../args";
import { json, nowIso } from "../output";
import { writeNewLocalReportFile } from "../report-output";
import { resolve } from "node:path";

/** Privacy-safe, read-only support preview; writing requires an explicit new output path. */
export function runSupport(root: string, args: ParsedArgs): number {
  const report = buildSupportReport(root, {
    semctxVersion: packageJson.version,
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    now: nowIso,
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = flagString(args, "output");
  if (args.flags.has("output") && output === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", "--output requires a new local file path");
  }
  if (output !== undefined) writeNewLocalReportFile(resolve(process.cwd(), output), serialized);
  json(report);
  return 0;
}
