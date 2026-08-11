import {
  pluginDeliveryStatus,
  PLUGIN_DELIVERY_HOSTS,
  type HostPluginDeliveryV1,
  type PluginDeliveryHost,
  type PluginDeliveryReportV1,
  type PluginDeliveryScope,
} from "@semantic-context/app-services";
import { SemctxError } from "@semantic-context/core";
import packageJson from "../../package.json";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { c, heading, info, json } from "../output";

function parseScope(args: ParsedArgs): PluginDeliveryScope {
  const raw = args.flags.get("host");
  if (raw === true) {
    throw new SemctxError("INVALID_TASK_INPUT", "--host requires auto|codex|claude|all", { host: null });
  }
  const value = flagString(args, "host") ?? "auto";
  if (value === "auto" || value === "all" || value === "codex" || value === "claude") return value;
  throw new SemctxError(
    "INVALID_TASK_INPUT",
    `--host must be auto|codex|claude|all, got "${value}"`,
    { host: value },
  );
}

/**
 * Exit status reflects **delivery** — what is installed on disk — because that is the dimension a
 * caller can act on and prove. Activation is reported separately and never folded in: no supported
 * host exposes the plugin version a running session loaded, so gating the exit code on it would
 * make every run exit non-zero and say nothing.
 */
function exitCode(report: PluginDeliveryReportV1): 0 | 2 | 3 {
  if (report.delivery === "UP_TO_DATE") return 0;
  if (report.delivery === "UPDATE_AVAILABLE") return 2;
  return 3;
}

function label(host: PluginDeliveryHost): string {
  return host === "codex" ? "Codex" : "Claude";
}

function mark(verdict: PluginDeliveryReportV1["verdict"]): string {
  if (verdict === "UP_TO_DATE") return c.green("ok");
  return verdict === "UPDATE_AVAILABLE" ? c.yellow("!!") : c.dim("??");
}

function renderHost(host: PluginDeliveryHost, state: HostPluginDeliveryV1): void {
  if (!state.requested) return;
  info(`  ${mark(state.delivery)} ${label(host).padEnd(7)} ${state.delivery}`);
  if (!state.detected) {
    info(`             ${c.dim("not detected on PATH")}`);
    return;
  }
  info(
    `      marketplace  ${state.marketplace.name}`
      + ` ref ${state.marketplace.ref ?? "unknown"}`
      + ` (${state.marketplace.matchesSemctx === true ? "semctx" : "unverified source"})`,
  );
  info(`      snapshot     ${state.snapshot.version ?? "unknown"} @ ${state.snapshot.commit ?? "unknown"}`);
  info(
    `      installed    ${state.installed.version ?? "unknown"}`
      + ` (content ${state.installed.contentMatchesSnapshot === null
        ? "unproven"
        : state.installed.contentMatchesSnapshot ? "matches snapshot" : "DIVERGED"})`
      + ` ${c.dim(state.installed.path ?? "")}`,
  );
  info(`      session      ${state.session.status === "observed" ? state.session.version : "unknown"}`);
  if (state.reasons.length > 0) info(`      reasons      ${state.reasons.join(", ")}`);
}

/**
 * `semctx plugin-status` — cross-host plugin delivery report, read-only with respect to delivery state.
 *
 * By default it runs host `list` queries and local reads only, with no network operation at all.
 * `--attest` adds one: it fetches the canonical public release into a throwaway store outside the
 * project and deletes it afterwards. Nothing is ever added, updated, upgraded, removed, enabled or
 * promoted, Semctx itself writes neither the inspected project nor host trees, and the public
 * `stable` channel is never advanced. A queried host may keep its own process-usage bookkeeping.
 */
export function runPluginStatus(root: string, args: ParsedArgs): number {
  const report = pluginDeliveryStatus({
    repositoryRoot: root,
    version: packageJson.version,
    scope: parseScope(args),
    attest: flagBool(args, "attest"),
  });
  if (flagBool(args, "json")) {
    json(report);
    return exitCode(report);
  }

  heading(`semctx plugin-status  ${c.dim("·")}  delivery ${report.delivery}`);
  info(
    `  repository   ${report.repository.version} @ ${report.repository.commit ?? "unknown"}`
      + c.dim("  (informative; merging main delivers nothing)"),
  );
  info(
    `  stable       ${report.publicRelease.version ?? "unknown"}`
      + ` @ ${report.publicRelease.commit ?? "unknown"}`
      + c.dim(` [${report.publicRelease.authority}] (${report.publicRelease.source ?? report.publicRelease.status})`),
  );
  info("");
  for (const host of PLUGIN_DELIVERY_HOSTS) renderHost(host, report.hosts[host]);
  info("");
  info(`  overall      ${report.verdict} ${c.dim("(delivery + activation)")}`);
  for (const step of report.next) info(c.dim(`Next: ${step}`));
  return exitCode(report);
}
