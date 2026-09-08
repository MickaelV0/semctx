/** Real child-process execution. No mocked runner: every command here actually spawns. */

export interface ChildOutcome {
  argv: readonly string[];
  cwd: string;
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function sanitizedEnvironment(): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(key) && key.toUpperCase() !== "SEMCTX_ROOT") {
      sanitized[key] = value;
    }
  }
  return {
    ...sanitized,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
}

/** Spawn a real process and capture its exit code and raw output verbatim. */
export function runChild(
  argv: readonly string[],
  options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): ChildOutcome {
  const proc = Bun.spawnSync([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    argv,
    cwd: options.cwd,
    code: proc.exitCode,
    signal: proc.signalCode ?? null,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Run the packaged CLI as a real Bun-hosted process: `bun <cliPath> <args...>`. */
export function runPackagedCli(
  cliPath: string,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
): ChildOutcome {
  return runChild([process.execPath, cliPath, ...args], { cwd, env: sanitizedEnvironment(), timeoutMs });
}

export function runGit(args: readonly string[], cwd: string): ChildOutcome {
  return runChild(["git", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    env: sanitizedEnvironment(),
  });
}
