/** A subprocess result that is always finite and never lies about how it ended (ADR 0019 process-truth invariant). */
export interface BoundedRunResult {
  argv: readonly string[];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface BoundedRunOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/**
 * `-1` is a sentinel, never a real POSIX/Windows exit code: a timed-out child has no exit code to
 * report, and reusing `0` (or any real code) here would let a killed process read as a successful one.
 */
export const TIMED_OUT_EXIT_CODE = -1;

export function runBounded(argv: readonly string[], options: BoundedRunOptions): BoundedRunResult {
  const started = performance.now();
  const result = Bun.spawnSync([...argv], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    env: options.env,
  });
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const timedOut = result.exitedDueToTimeout === true;
  return {
    argv: [...argv],
    exitCode: timedOut ? TIMED_OUT_EXIT_CODE : result.exitCode,
    timedOut,
    durationMs,
    stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()),
  };
}
