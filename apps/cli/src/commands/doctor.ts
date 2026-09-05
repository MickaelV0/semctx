import { probeCliCompatibility, workspaceHealth, type WorkspaceHealthCheck } from "@semantic-context/app-services";
import packageJson from "../../package.json";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, heading, json, c, success, fail } from "../output";

/** `semctx doctor` — report workspace health without modifying it. */
export function runDoctor(root: string, args: ParsedArgs): number {
  const cliCompatibility = probeCliCompatibility(packageJson.version);
  const { healthy, checks: workspaceChecks } = workspaceHealth(root);
  const checks: WorkspaceHealthCheck[] = [
    { name: "cli", ok: true, detail: `semctx ${packageJson.version}` },
    ...workspaceChecks,
    { name: "runtime", ok: true, detail: `bun ${Bun.version}` },
  ];
  if (flagBool(args, "json")) {
    json({ healthy, version: packageJson.version, cliCompatibility, checks });
    return healthy ? 0 : 1;
  }

  heading("Doctor");
  for (const chk of checks) {
    const mark = chk.ok ? c.green("ok ") : chk.status === "degraded" ? c.yellow("warn") : c.red("bad");
    info(`  [${mark}] ${chk.name.padEnd(10)} ${c.dim(chk.detail)}`);
  }
  const globalCliMark = cliCompatibility.compatible ? c.green("ok  ") : c.yellow("warn");
  const globalCliDetail = cliCompatibility.compatible
    ? `${cliCompatibility.version ?? "unknown"}${cliCompatibility.path === null ? "" : ` (${cliCompatibility.path})`}`
    : `${cliCompatibility.reason}; ${cliCompatibility.upgradeCommand}`;
  info(`  [${globalCliMark}] global cli ${c.dim(globalCliDetail)}`);
  info("");
  if (healthy) success("workspace healthy");
  else fail("workspace has issues (see above)");
  return healthy ? 0 : 1;
}
