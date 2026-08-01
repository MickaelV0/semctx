import packageJson from "../../package.json";
import { isSemctxError, SemctxError } from "@semantic-context/core";
import { Buffer } from "node:buffer";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { c, fail, heading, info, json, success } from "../output";

const SEMCTX_CODEX_SOURCE = "hoklims/semctx";
const MARKETPLACE_REF = "stable";
const SEMCTX_CLAUDE_SOURCE = `${SEMCTX_CODEX_SOURCE}@${MARKETPLACE_REF}`;
const CODEX_MARKETPLACE = "semctx-stable";
const LEGACY_CODEX_MARKETPLACES = ["personal", "semctx"] as const;
const CODEX_PLUGIN = "semctx-control";
const CLAUDE_MARKETPLACE = "semctx-stable";
const LEGACY_CLAUDE_MARKETPLACE = "semctx";
const CLAUDE_PLUGIN = "semctx";

type Host = "codex" | "claude";
type HostSelection = "auto" | Host | "all";

export type HostInstallStatus =
  | "not-requested"
  | "not-detected"
  | "missing"
  | "planned"
  | "installed"
  | "updated"
  | "migrated"
  | "conflict"
  | "failed";

export interface CommandResult {
  code: number;
  out: string;
  err: string;
}

export interface SetupExecution {
  code: number;
  report: Record<string, unknown> | null;
  err: string;
}

export interface InstallRuntime {
  run(command: readonly string[], cwd: string): CommandResult;
  setup(root: string, dryRun: boolean): SetupExecution;
  deferCodexCleanup(marketplaceNames: readonly string[], cwd: string): CommandResult;
}

interface InstallStep {
  action: string;
  status: "planned" | "ok" | "deferred" | "failed";
  command: string[];
  detail?: string;
}

interface HostInstallReport {
  requested: boolean;
  detected: boolean;
  status: HostInstallStatus;
  version?: string;
  restartRequired: boolean;
  cleanupDeferred?: boolean;
  steps: InstallStep[];
  error?: string;
}

type WorkspaceStatus =
  | "skipped"
  | "planned"
  | "not-a-repository"
  | "ready"
  | "failed";

interface WorkspaceInstallReport {
  status: WorkspaceStatus;
  root: string;
  report?: Record<string, unknown>;
  error?: string;
  next?: string;
}

export interface InstallReport {
  ok: boolean;
  version: string;
  dryRun: boolean;
  selection: HostSelection;
  hosts: Record<Host, HostInstallReport>;
  workspace: WorkspaceInstallReport;
  next: string[];
}

interface CodexMarketplace {
  name?: unknown;
  marketplaceSource?: {
    sourceType?: unknown;
    source?: unknown;
  };
}

interface CodexPlugin {
  pluginId?: unknown;
  installed?: unknown;
  enabled?: unknown;
  version?: unknown;
}

interface ClaudeMarketplace {
  name?: unknown;
  repo?: unknown;
  path?: unknown;
  ref?: unknown;
}

interface ClaudePlugin {
  id?: unknown;
  scope?: unknown;
  enabled?: unknown;
  version?: unknown;
}

function decode(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : new TextDecoder().decode(bytes);
}

function defaultRun(command: readonly string[], cwd: string): CommandResult {
  try {
    const process = Bun.spawnSync([...command], {
      cwd,
      ...(command[0] === "claude"
        ? {
            env: {
              ...globalThis.process.env,
              CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE:
                globalThis.process.env["CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE"] ?? "1",
            },
          }
        : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: process.exitCode ?? 1,
      out: decode(process.stdout),
      err: decode(process.stderr),
    };
  } catch (cause) {
    return {
      code: 1,
      out: "",
      err: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const DEFERRED_CODEX_CLEANUP_SCRIPT = String.raw`
const root = process.argv[1];
const payload = process.argv[2];
const allowed = new Set(["personal", "semctx"]);
let marketplaceNames;
try {
  marketplaceNames = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!Array.isArray(marketplaceNames)
    || marketplaceNames.length === 0
    || marketplaceNames.some((name) => typeof name !== "string" || !allowed.has(name))) {
    process.exit(2);
  }
} catch {
  process.exit(2);
}

const run = (command) => Bun.spawnSync(command, {
  cwd: root,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const parseObject = (result) => {
  if (result.exitCode !== 0) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(result.stdout));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const deadline = Date.now() + 12 * 60 * 60 * 1000;
while (Date.now() < deadline) {
  const pluginState = parseObject(run(["codex", "plugin", "list", "--json"]));
  const marketplaceState = parseObject(
    run(["codex", "plugin", "marketplace", "list", "--json"]),
  );
  const installed = pluginState?.installed;
  const marketplaces = marketplaceState?.marketplaces;
  let complete = Array.isArray(installed) && Array.isArray(marketplaces);

  if (complete) {
    for (const name of marketplaceNames) {
      const pluginId = "semctx-control@" + name;
      if (installed.some((plugin) => plugin?.pluginId === pluginId && plugin?.installed === true)) {
        const removed = run(["codex", "plugin", "remove", pluginId, "--json"]);
        if (removed.exitCode !== 0) {
          complete = false;
          break;
        }
      }
      if (marketplaces.some((marketplace) => marketplace?.name === name)) {
        const removed = run(["codex", "plugin", "marketplace", "remove", name, "--json"]);
        if (removed.exitCode !== 0) {
          complete = false;
          break;
        }
      }
    }
  }

  if (complete) process.exit(0);
  await Bun.sleep(5000);
}
process.exit(1);
`;

function defaultDeferCodexCleanup(
  marketplaceNames: readonly string[],
  cwd: string,
): CommandResult {
  try {
    const payload = Buffer.from(JSON.stringify(marketplaceNames), "utf8").toString("base64url");
    const child = Bun.spawn(
      [process.execPath, "-e", DEFERRED_CODEX_CLEANUP_SCRIPT, cwd, payload],
      {
        cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        windowsHide: true,
      },
    );
    child.unref();
    return {
      code: 0,
      out: JSON.stringify({ pid: child.pid }),
      err: "",
    };
  } catch (cause) {
    return {
      code: 1,
      out: "",
      err: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function parseJsonObject(out: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(out);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function defaultSetup(root: string, dryRun: boolean): SetupExecution {
  if (dryRun) {
    return { code: 0, report: null, err: "" };
  }
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return { code: 1, report: null, err: "cannot resolve the running semctx entrypoint" };
  }
  const result = defaultRun(
    [process.execPath, entrypoint, "setup", "--root", root, "--json"],
    root,
  );
  return {
    code: result.code,
    report: result.code === 0 ? parseJsonObject(result.out) : null,
    err: result.err || (result.code === 0 ? "" : result.out),
  };
}

const DEFAULT_RUNTIME: InstallRuntime = {
  run: defaultRun,
  setup: defaultSetup,
  deferCodexCleanup: defaultDeferCodexCleanup,
};

function hostReport(requested: boolean): HostInstallReport {
  return {
    requested,
    detected: false,
    status: requested ? "not-detected" : "not-requested",
    restartRequired: false,
    steps: [],
  };
}

function selected(selection: HostSelection, host: Host): boolean {
  return selection === "auto" || selection === "all" || selection === host;
}

function requestedExplicitly(selection: HostSelection, host: Host): boolean {
  return selection === "all" || selection === host;
}

function parseSelection(args: ParsedArgs): HostSelection {
  const raw = args.flags.get("host");
  if (raw === true) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--host requires auto|codex|claude|all",
      { host: null },
    );
  }
  const value = flagString(args, "host") ?? "auto";
  if (value === "auto" || value === "all" || value === "codex" || value === "claude") {
    return value;
  }
  throw new SemctxError(
    "INVALID_TASK_INPUT",
    `--host must be auto|codex|claude|all, got "${value}"`,
    { host: value },
  );
}

function compactError(result: CommandResult): string {
  return (result.err || result.out || `command exited ${result.code}`).trim();
}

function runMutation(
  runtime: InstallRuntime,
  root: string,
  report: HostInstallReport,
  action: string,
  command: readonly string[],
  dryRun: boolean,
): boolean {
  const step: InstallStep = {
    action,
    status: dryRun ? "planned" : "ok",
    command: [...command],
  };
  report.steps.push(step);
  if (dryRun) return true;

  const result = runtime.run(command, root);
  if (result.code === 0) return true;
  step.status = "failed";
  step.detail = compactError(result);
  report.status = "failed";
  report.error = `${action}: ${step.detail}`;
  return false;
}

interface CodexCleanupOperation {
  action: string;
  command: string[];
  marketplaceName: string;
}

function isLockedCodexCacheRemoval(result: CommandResult): boolean {
  const detail = compactError(result).toLowerCase();
  return detail.includes("failed to remove existing")
    && detail.includes("cache entry")
    && detail.includes("os error 32");
}

function runCodexLegacyCleanup(
  runtime: InstallRuntime,
  root: string,
  report: HostInstallReport,
  operations: readonly CodexCleanupOperation[],
  dryRun: boolean,
): boolean {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation === undefined) continue;
    const step: InstallStep = {
      action: operation.action,
      status: dryRun ? "planned" : "ok",
      command: [...operation.command],
    };
    report.steps.push(step);
    if (dryRun) continue;

    const result = runtime.run(operation.command, root);
    if (result.code === 0) continue;
    if (isLockedCodexCacheRemoval(result)) {
      const pendingNames = [...new Set(
        operations.slice(index).map((item) => item.marketplaceName),
      )];
      const deferred = runtime.deferCodexCleanup(pendingNames, root);
      if (deferred.code === 0) {
        const detail =
          "active Codex sessions are using the legacy cache; cleanup is retrying in the background";
        step.status = "deferred";
        step.detail = detail;
        for (const pending of operations.slice(index + 1)) {
          report.steps.push({
            action: pending.action,
            status: "deferred",
            command: [...pending.command],
            detail,
          });
        }
        report.cleanupDeferred = true;
        report.restartRequired = true;
        return true;
      }
      step.detail =
        `${compactError(result)}; could not schedule deferred cleanup: ${compactError(deferred)}`;
    } else {
      step.detail = compactError(result);
    }
    step.status = "failed";
    report.status = "failed";
    report.error = `${operation.action}: ${step.detail}`;
    return false;
  }
  return true;
}

function recordVerification(
  report: HostInstallReport,
  action: string,
  command: readonly string[],
  error: string | undefined,
): boolean {
  report.steps.push({
    action,
    status: error === undefined ? "ok" : "failed",
    command: [...command],
    detail: error,
  });
  if (error === undefined) return true;
  report.status = "failed";
  report.error = `${action}: ${error}`;
  return false;
}

function parseJsonArray<T>(result: CommandResult): T[] | null {
  if (result.code !== 0) return null;
  try {
    const value: unknown = JSON.parse(result.out);
    return Array.isArray(value) ? value as T[] : null;
  } catch {
    return null;
  }
}

function parseCodexMarketplaces(result: CommandResult): CodexMarketplace[] | null {
  const object = parseJsonObject(result.out);
  const marketplaces = object?.["marketplaces"];
  return result.code === 0 && Array.isArray(marketplaces)
    ? marketplaces as CodexMarketplace[]
    : null;
}

function parseCodexPlugins(result: CommandResult): CodexPlugin[] | null {
  const object = parseJsonObject(result.out);
  const installed = object?.["installed"];
  return result.code === 0 && Array.isArray(installed) ? installed as CodexPlugin[] : null;
}

function normalizeGitSource(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function isSemctxSource(value: unknown): boolean {
  const normalized = normalizeGitSource(value);
  return normalized === "hoklims/semctx"
    || normalized === "https://github.com/hoklims/semctx";
}

function installCodex(
  root: string,
  dryRun: boolean,
  runtime: InstallRuntime,
  report: HostInstallReport,
): void {
  const marketplacesResult = runtime.run(
    ["codex", "plugin", "marketplace", "list", "--json"],
    root,
  );
  const pluginsResult = runtime.run(["codex", "plugin", "list", "--json"], root);
  const marketplaces = parseCodexMarketplaces(marketplacesResult);
  const plugins = parseCodexPlugins(pluginsResult);
  if (marketplaces === null || plugins === null) {
    report.status = "failed";
    report.error = marketplaces === null
      ? `cannot inspect Codex marketplaces: ${compactError(marketplacesResult)}`
      : `cannot inspect Codex plugins: ${compactError(pluginsResult)}`;
    return;
  }

  const named = marketplaces.find((item) => item.name === CODEX_MARKETPLACE);
  if (named !== undefined && !isSemctxSource(named.marketplaceSource?.source)) {
    report.status = "conflict";
    report.error = `Codex marketplace "${CODEX_MARKETPLACE}" already points to another source`;
    return;
  }

  const legacyMarketplaces = marketplaces.filter(
    (item) => LEGACY_CODEX_MARKETPLACES.some((name) => item.name === name)
      && isSemctxSource(item.marketplaceSource?.source),
  );
  const installedNew = plugins.some(
    (item) => item.pluginId === `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}` && item.installed === true,
  );

  if (legacyMarketplaces.length > 0) {
    for (const legacy of legacyMarketplaces) {
      const legacyName = String(legacy.name);
      const otherLegacyPlugins = plugins
        .filter(
          (item) => item.installed === true
            && typeof item.pluginId === "string"
            && item.pluginId.endsWith(`@${legacyName}`)
            && item.pluginId !== `${CODEX_PLUGIN}@${legacyName}`,
        )
        .map((item) => String(item.pluginId));
      if (otherLegacyPlugins.length > 0) {
        report.status = "conflict";
        report.error = `cannot migrate Codex marketplace "${legacyName}" while these installed plugins still use it: ${otherLegacyPlugins.join(", ")}`;
        return;
      }
    }

    if (named === undefined) {
      if (!runMutation(
        runtime,
        root,
        report,
        "add Semctx Codex marketplace",
        ["codex", "plugin", "marketplace", "add", SEMCTX_CODEX_SOURCE, "--ref", MARKETPLACE_REF, "--json"],
        dryRun,
      )) return;
    } else if (!runMutation(
      runtime,
      root,
      report,
      "refresh Semctx Codex marketplace",
      ["codex", "plugin", "marketplace", "upgrade", CODEX_MARKETPLACE, "--json"],
      dryRun,
    )) return;

    if (!runMutation(
      runtime,
      root,
      report,
      installedNew ? "refresh Semctx Codex plugin" : "install Semctx Codex plugin",
      ["codex", "plugin", "add", `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`, "--json"],
      dryRun,
    )) return;
    if (!dryRun && !verifyCodexInstall(root, runtime, report)) return;

    const cleanupOperations: CodexCleanupOperation[] = [];
    for (const legacy of legacyMarketplaces) {
      const legacyName = String(legacy.name);
      const installedLegacy = plugins.some(
        (item) => item.pluginId === `${CODEX_PLUGIN}@${legacyName}`
          && item.installed === true,
      );
      if (installedLegacy) {
        cleanupOperations.push({
          action: "remove legacy Codex plugin",
          command: ["codex", "plugin", "remove", `${CODEX_PLUGIN}@${legacyName}`, "--json"],
          marketplaceName: legacyName,
        });
      }
      cleanupOperations.push({
        action: "remove legacy Codex marketplace",
        command: ["codex", "plugin", "marketplace", "remove", legacyName, "--json"],
        marketplaceName: legacyName,
      });
    }
    if (!runCodexLegacyCleanup(runtime, root, report, cleanupOperations, dryRun)) return;
    report.status = dryRun ? "planned" : "migrated";
    report.restartRequired = !dryRun;
    return;
  }

  if (named === undefined) {
    if (!runMutation(
      runtime,
      root,
      report,
      "add Semctx Codex marketplace",
      ["codex", "plugin", "marketplace", "add", SEMCTX_CODEX_SOURCE, "--ref", MARKETPLACE_REF, "--json"],
      dryRun,
    )) return;
  } else if (!runMutation(
    runtime,
    root,
    report,
    "refresh Semctx Codex marketplace",
    ["codex", "plugin", "marketplace", "upgrade", CODEX_MARKETPLACE, "--json"],
    dryRun,
  )) return;

  if (!runMutation(
    runtime,
    root,
    report,
    installedNew ? "refresh Semctx Codex plugin" : "install Semctx Codex plugin",
    ["codex", "plugin", "add", `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`, "--json"],
    dryRun,
  )) return;

  if (!dryRun && !verifyCodexInstall(root, runtime, report)) return;
  report.status = dryRun ? "planned" : installedNew ? "updated" : "installed";
  report.restartRequired = !dryRun;
}

function verifyCodexInstall(
  root: string,
  runtime: InstallRuntime,
  report: HostInstallReport,
): boolean {
  const command = ["codex", "plugin", "list", "--json"];
  const result = runtime.run(command, root);
  const plugins = parseCodexPlugins(result);
  let error: string | undefined;
  if (plugins === null) {
    error = `cannot inspect final Codex plugin state: ${compactError(result)}`;
  } else {
    const installed = plugins.find(
      (item) => item.pluginId === `${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`,
    );
    if (installed?.installed !== true) error = "plugin is not installed";
    else if (installed.enabled !== true) error = "plugin is installed but not enabled";
    else if (installed.version !== packageJson.version) {
      // Host JSON is untrusted; preserve its existing diagnostic string representation.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      error = `expected plugin v${packageJson.version}, found v${String(installed.version ?? "unknown")}`;
    }
  }
  return recordVerification(report, "verify Semctx Codex plugin", command, error);
}

function installClaude(
  root: string,
  dryRun: boolean,
  runtime: InstallRuntime,
  report: HostInstallReport,
): void {
  const marketplacesResult = runtime.run(
    ["claude", "plugin", "marketplace", "list", "--json"],
    root,
  );
  const pluginsResult = runtime.run(["claude", "plugin", "list", "--json"], root);
  const marketplaces = parseJsonArray<ClaudeMarketplace>(marketplacesResult);
  const plugins = parseJsonArray<ClaudePlugin>(pluginsResult);
  if (marketplaces === null || plugins === null) {
    report.status = "failed";
    report.error = marketplaces === null
      ? `cannot inspect Claude marketplaces: ${compactError(marketplacesResult)}`
      : `cannot inspect Claude plugins: ${compactError(pluginsResult)}`;
    return;
  }

  const named = marketplaces.find((item) => item.name === CLAUDE_MARKETPLACE);
  if (named !== undefined && !isSemctxSource(named.repo) && !isSemctxSource(named.path)) {
    report.status = "conflict";
    report.error = `Claude marketplace "${CLAUDE_MARKETPLACE}" already points to another source`;
    return;
  }
  const legacy = marketplaces.find(
    (item) => item.name === LEGACY_CLAUDE_MARKETPLACE
      && (isSemctxSource(item.repo) || isSemctxSource(item.path)),
  );
  const installedPlugin = plugins.find(
    (item) => item.id === `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}` && item.scope === "user",
  );
  const installed = installedPlugin !== undefined;

  if (named === undefined) {
    if (!runMutation(
      runtime,
      root,
      report,
      "add Semctx Claude marketplace",
      ["claude", "plugin", "marketplace", "add", SEMCTX_CLAUDE_SOURCE, "--scope", "user"],
      dryRun,
    )) return;
  } else if (!runMutation(
    runtime,
    root,
    report,
    "refresh Semctx Claude marketplace",
    ["claude", "plugin", "marketplace", "update", CLAUDE_MARKETPLACE],
    dryRun,
  )) return;

  const pluginCommand = installed
    ? ["claude", "plugin", "update", `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`, "--scope", "user"]
    : ["claude", "plugin", "install", `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`, "--scope", "user"];
  if (!runMutation(
    runtime,
    root,
    report,
    installed ? "update Semctx Claude plugin" : "install Semctx Claude plugin",
    pluginCommand,
    dryRun,
  )) return;
  if (installedPlugin?.enabled === false && !runMutation(
    runtime,
    root,
    report,
    "enable Semctx Claude plugin",
    ["claude", "plugin", "enable", `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`, "--scope", "user"],
    dryRun,
  )) return;

  if (!dryRun && !verifyClaudeInstall(root, runtime, report)) return;
  if (legacy !== undefined && !runMutation(
    runtime,
    root,
    report,
    "remove legacy Claude marketplace",
    ["claude", "plugin", "marketplace", "remove", LEGACY_CLAUDE_MARKETPLACE, "--scope", "user"],
    dryRun,
  )) return;
  report.status = dryRun ? "planned" : legacy !== undefined ? "migrated" : installed ? "updated" : "installed";
  report.restartRequired = !dryRun;
}

function verifyClaudeInstall(
  root: string,
  runtime: InstallRuntime,
  report: HostInstallReport,
): boolean {
  const command = ["claude", "plugin", "list", "--json"];
  const result = runtime.run(command, root);
  const plugins = parseJsonArray<ClaudePlugin>(result);
  let error: string | undefined;
  if (plugins === null) {
    error = `cannot inspect final Claude plugin state: ${compactError(result)}`;
  } else {
    const installed = plugins.find(
      (item) => item.id === `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`
        && item.scope === "user",
    );
    if (installed === undefined) error = "user-scoped plugin is not installed";
    else if (installed.enabled !== true) error = "plugin is installed but not enabled";
    else if (installed.version !== packageJson.version) {
      // Host JSON is untrusted; preserve its existing diagnostic string representation.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      error = `expected plugin v${packageJson.version}, found v${String(installed.version ?? "unknown")}`;
    }
  }
  return recordVerification(report, "verify Semctx Claude plugin", command, error);
}

function detectHost(
  host: Host,
  root: string,
  selection: HostSelection,
  runtime: InstallRuntime,
  report: HostInstallReport,
): boolean {
  const probe = runtime.run([host, "--version"], root);
  if (probe.code === 0) {
    report.detected = true;
    report.version = probe.out.trim() || undefined;
    return true;
  }
  report.status = requestedExplicitly(selection, host) ? "missing" : "not-detected";
  report.error = requestedExplicitly(selection, host)
    ? `${host} is not available on PATH`
    : undefined;
  return false;
}

function resolveGitRoot(root: string, runtime: InstallRuntime): string | undefined {
  const result = runtime.run(
    ["git", "rev-parse", "--show-toplevel"],
    root,
  );
  const resolved = result.out.trim();
  return result.code === 0 && resolved.length > 0 ? resolved : undefined;
}

function workspaceReport(
  root: string,
  args: ParsedArgs,
  runtime: InstallRuntime,
): WorkspaceInstallReport {
  if (flagBool(args, "skip-setup")) {
    return {
      status: "skipped",
      root,
      next: `run 'semctx setup --root "${root}"' when you want to prepare the repository`,
    };
  }
  const repositoryRoot = resolveGitRoot(root, runtime);
  if (repositoryRoot === undefined) {
    return {
      status: "not-a-repository",
      root,
      next: "open a Git repository and run 'semctx setup' once",
    };
  }
  if (flagBool(args, "dry-run")) {
    return { status: "planned", root: repositoryRoot };
  }

  const result = runtime.setup(repositoryRoot, false);
  if (result.code !== 0 || result.report === null) {
    return {
      status: "failed",
      root: repositoryRoot,
      error: result.err || "semctx setup failed without a structured report",
      next: `fix the reported issue, then run 'semctx setup --root "${repositoryRoot}"'`,
    };
  }
  return { status: "ready", root: repositoryRoot, report: result.report };
}

function hostOk(report: HostInstallReport): boolean {
  return report.status === "planned"
    || report.status === "installed"
    || report.status === "updated"
    || report.status === "migrated";
}

function nextSteps(
  hosts: Record<Host, HostInstallReport>,
  workspace: WorkspaceInstallReport,
  dryRun: boolean,
): string[] {
  if (dryRun) return ["re-run without --dry-run to apply this plan"];
  const next: string[] = [];
  if (hosts.codex.cleanupDeferred) {
    next.push(
      "open a new Codex task so the refreshed plugin is loaded; legacy cleanup will finish automatically",
    );
  } else if (hosts.codex.restartRequired) {
    next.push("open a new Codex task so the refreshed plugin is loaded");
  }
  if (hosts.claude.restartRequired) next.push("restart Claude Code so the refreshed plugin is loaded");
  for (const host of ["codex", "claude"] as const) {
    const report = hosts[host];
    const label = host === "codex" ? "Codex" : "Claude Code";
    if (report.status === "missing") {
      next.push(`install or update ${label}, then re-run with --host ${host}`);
    } else if (report.status === "conflict") {
      next.push(
        `resolve the ${label} marketplace conflict with '${host} plugin marketplace list --json', then re-run`,
      );
    } else if (report.status === "failed") {
      next.push(`resolve the ${label} command error above, then re-run`);
    }
  }
  if (hosts.codex.status === "not-detected" && hosts.claude.status === "not-detected") {
    next.push("install Codex or Claude Code, then re-run 'semctx install'");
  }
  if (workspace.next !== undefined) next.push(workspace.next);
  return next;
}

export function executeInstall(
  root: string,
  args: ParsedArgs,
  runtime: InstallRuntime = DEFAULT_RUNTIME,
): InstallReport {
  const selection = parseSelection(args);
  const dryRun = flagBool(args, "dry-run");
  const hosts: Record<Host, HostInstallReport> = {
    codex: hostReport(selected(selection, "codex")),
    claude: hostReport(selected(selection, "claude")),
  };

  for (const host of ["codex", "claude"] as const) {
    const report = hosts[host];
    if (!report.requested) continue;
    if (!detectHost(host, root, selection, runtime, report)) continue;
    if (host === "codex") installCodex(root, dryRun, runtime, report);
    else installClaude(root, dryRun, runtime, report);
  }

  const workspace = workspaceReport(root, args, runtime);
  const requestedReports = (Object.keys(hosts) as Host[])
    .map((host) => hosts[host])
    .filter((report) => report.requested);
  const successfulHosts = requestedReports.filter(hostOk);
  const explicitHostsOk = requestedReports.every(
    (report) => hostOk(report) || (selection === "auto" && report.status === "not-detected"),
  );
  const someHostReady = successfulHosts.length > 0;
  const workspaceOk = workspace.status !== "failed";
  const ok = explicitHostsOk && someHostReady && workspaceOk;

  return {
    ok,
    version: packageJson.version,
    dryRun,
    selection,
    hosts,
    workspace,
    next: nextSteps(hosts, workspace, dryRun),
  };
}

function renderHost(host: Host, report: HostInstallReport): void {
  const label = host === "codex" ? "Codex" : "Claude";
  const positive = report.status === "installed"
    || report.status === "updated"
    || report.status === "migrated"
    || report.status === "planned";
  const mark = positive ? c.green("ok") : report.status.startsWith("not-") ? c.dim("--") : c.red("!!");
  info(`  ${mark} ${label.padEnd(8)} ${report.status}${report.version ? c.dim(` (${report.version})`) : ""}`);
  if (report.error !== undefined) info(`             ${c.red(report.error)}`);
  for (const step of report.steps) {
    const stepMark = step.status === "failed"
      ? c.red("!!")
      : step.status === "planned" || step.status === "deferred"
        ? c.dim("··")
        : c.green("ok");
    info(`      ${stepMark} ${step.action}`);
  }
}

export function runInstall(
  root: string,
  args: ParsedArgs,
  runtime: InstallRuntime = DEFAULT_RUNTIME,
): number {
  let report: InstallReport;
  try {
    report = executeInstall(root, args, runtime);
  } catch (cause) {
    if (!flagBool(args, "json") || !isSemctxError(cause)) throw cause;
    json({
      ok: false,
      version: packageJson.version,
      error: {
        code: cause.code,
        message: cause.message,
        details: cause.details,
      },
    });
    return 1;
  }
  if (flagBool(args, "json")) {
    json(report);
    return report.ok ? 0 : 1;
  }

  heading(`semctx install  ${c.dim("·")}  v${report.version}`);
  renderHost("codex", report.hosts.codex);
  renderHost("claude", report.hosts.claude);
  const workspaceMark = report.workspace.status === "failed" ? c.red("!!") : c.green("ok");
  info(`  ${workspaceMark} Project  ${report.workspace.status} ${c.dim(report.workspace.root)}`);
  if (report.workspace.error !== undefined) info(`             ${c.red(report.workspace.error)}`);
  info("");
  if (report.ok) success(report.dryRun ? "installation plan is ready" : "Semctx is ready");
  else fail("installation is incomplete (see the recovery step below)");
  for (const step of report.next) info(c.dim(`Next: ${step}`));
  return report.ok ? 0 : 1;
}
