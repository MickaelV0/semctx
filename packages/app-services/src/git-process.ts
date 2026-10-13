import { SemctxError } from "@semantic-context/core";
import { gitEnvironment, processLimits } from "../../../plugins/shared/hooks/process-budget.mjs";

export function spawnGitSync(command: string[], options: { cwd: string; stdin?: Uint8Array; stdout?: "pipe"; stderr?: "pipe"; env?: NodeJS.ProcessEnv }): Bun.SyncSubprocess<"pipe", "pipe"> {
  const limits = processLimits();
  const result = Bun.spawnSync(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...gitEnvironment(), ...options.env },
    ...limits,
  });
  if (result.exitedDueToTimeout || result.exitedDueToMaxBuffer
    || result.stdout.byteLength >= limits.maxBuffer
    || result.stderr.byteLength >= limits.maxBuffer) {
    const reason = result.exitedDueToTimeout ? "PROCESS_TIMEOUT" : "PROCESS_OUTPUT_LIMIT";
    throw new SemctxError("GIT_ERROR", `${reason}: Git capture refused`, { command, reason, timeoutMs: limits.timeout });
  }
  return result;
}
