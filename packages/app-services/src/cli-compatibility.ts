export const CLI_COMPATIBILITY_PROBE_TIMEOUT_MS = 2_000;

export type CliCompatibilityReason =
  | "CLI_NOT_FOUND"
  | "CLI_VERSION_COMPATIBLE"
  | "CLI_VERSION_MISMATCH"
  | "CLI_VERSION_MALFORMED"
  | "CLI_PROBE_TIMEOUT"
  | "CLI_PROBE_FAILED";

export interface CliCompatibilityReport {
  found: boolean;
  path: string | null;
  version: string | null;
  requiredVersion: string;
  compatible: boolean;
  reason: CliCompatibilityReason;
  upgradeCommand: string;
}

export interface CliCompatibilityProbeExecution {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface CliCompatibilityProbeDependencies {
  resolveExecutable(command: string): string | null;
  runVersionProbe(path: string, timeoutMs: number): CliCompatibilityProbeExecution;
}

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function probeCliCompatibility(
  requiredVersion: string,
  dependencies: Partial<CliCompatibilityProbeDependencies> = {},
): CliCompatibilityReport {
  const upgradeCommand = `bun install -g semctx@${requiredVersion}`;
  const resolveExecutable = dependencies.resolveExecutable ?? defaultResolveExecutable;
  const runVersionProbe = dependencies.runVersionProbe ?? defaultRunVersionProbe;

  let path: string | null;
  try {
    path = resolveExecutable("semctx");
  } catch {
    return report(false, null, null, requiredVersion, false, "CLI_PROBE_FAILED", upgradeCommand);
  }
  if (path === null) {
    return report(false, null, null, requiredVersion, false, "CLI_NOT_FOUND", upgradeCommand);
  }

  let execution: CliCompatibilityProbeExecution;
  try {
    execution = runVersionProbe(path, CLI_COMPATIBILITY_PROBE_TIMEOUT_MS);
  } catch {
    return report(true, path, null, requiredVersion, false, "CLI_PROBE_FAILED", upgradeCommand);
  }
  if (execution.timedOut) {
    return report(true, path, null, requiredVersion, false, "CLI_PROBE_TIMEOUT", upgradeCommand);
  }
  if (execution.exitCode !== 0) {
    return report(true, path, null, requiredVersion, false, "CLI_PROBE_FAILED", upgradeCommand);
  }

  const version = execution.stdout.trim();
  if (!VERSION_PATTERN.test(version)) {
    return report(true, path, null, requiredVersion, false, "CLI_VERSION_MALFORMED", upgradeCommand);
  }
  const compatible = version === requiredVersion;
  return report(
    true,
    path,
    version,
    requiredVersion,
    compatible,
    compatible ? "CLI_VERSION_COMPATIBLE" : "CLI_VERSION_MISMATCH",
    upgradeCommand,
  );
}

function defaultResolveExecutable(command: string): string | null {
  return Bun.which(command) ?? null;
}

function defaultRunVersionProbe(path: string, timeoutMs: number): CliCompatibilityProbeExecution {
  const process = Bun.spawnSync([path, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return {
    exitCode: process.exitCode,
    stdout: new TextDecoder().decode(process.stdout),
    timedOut: process.signalCode === "SIGTERM",
  };
}

function report(
  found: boolean,
  path: string | null,
  version: string | null,
  requiredVersion: string,
  compatible: boolean,
  reason: CliCompatibilityReason,
  upgradeCommand: string,
): CliCompatibilityReport {
  return {
    found,
    path,
    version,
    requiredVersion,
    compatible,
    reason,
    upgradeCommand,
  };
}
