import { execFileSync as execute, spawnSync as spawn, spawn as spawnAsync } from "node:child_process";

export const GIT_PROCESS_TIMEOUT_MS = 5000;
export const PROCESS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
export const GUARD_PROCESS_BUDGET_MS = 15_000;
export const CODEX_CLEANUP_BUDGET_MS = 12 * 60 * 60 * 1000;
export const VERIFICATION_STEP_BUDGET_MS = 60 * 60 * 1000;
export const BENCHMARK_SAMPLE_BUDGET_MS = 10 * 60 * 1000;

/** @returns {{timeout: number, killSignal: "SIGKILL", maxBuffer: number}} */
export function processLimits(timeoutMs = GIT_PROCESS_TIMEOUT_MS, maxBuffer = PROCESS_MAX_BUFFER_BYTES) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("PROCESS_TIMEOUT: process budget exhausted");
  }
  return { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer };
}

export function gitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(GIT(?:_|$)|GCM_)/i.test(name)));
}

function boundedOptions(options) {
  return {
    ...options,
    ...processLimits(options.timeout ?? GIT_PROCESS_TIMEOUT_MS, options.maxBuffer ?? PROCESS_MAX_BUFFER_BYTES),
  };
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<Buffer | string>}
 */
export function spawnSyncWithinBudget(command, args, options = {}) {
  return spawn(command, args, boundedOptions(options));
}

/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions & {encoding: BufferEncoding}} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @returns {Buffer | string}
 */
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function execFileSyncWithinBudget(command, args, options = {}) {
  return execute(command, args, boundedOptions(options));
}

export const DEFERRED_PROCESS_SUPERVISOR = String.raw`
const { spawn } = await import("node:child_process");
const [budget, ...argv] = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
const stop = () => {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const limit = setTimeout(() => { killer.kill("SIGKILL"); process.exit(1); }, 5000);
    killer.on("error", () => { clearTimeout(limit); child.kill("SIGKILL"); process.exit(1); });
    killer.on("exit", () => { clearTimeout(limit); process.exit(1); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    process.exit(1);
  }
};
const timer = setTimeout(stop, budget);
child.on("error", () => { clearTimeout(timer); process.exit(1); });
child.on("exit", (code) => {
  clearTimeout(timer);
  if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  process.exit(code ?? 1);
});
`;

function killTree(pid) {
  if (pid === undefined) return;
  let failure;
  if (process.platform !== "win32") {
    try {
      const options = {
        encoding: "utf8", timeout: 500, maxBuffer: 4 * 1024 * 1024,
      };
      let inventory;
      try {
        inventory = execFileSyncWithinBudget("ps", ["-A", "-o", "pid=,ppid="], options);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        inventory = execFileSyncWithinBudget("/bin/ps", ["-A", "-o", "pid=,ppid="], options);
      }
      const children = new Map();
      for (const line of inventory.trim().split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (match === null) throw new Error("invalid process inventory");
        const child = Number(match[1]);
        const parent = Number(match[2]);
        if (!Number.isSafeInteger(child) || child <= 0 || !Number.isSafeInteger(parent) || parent < 0 || child === parent) {
          throw new Error("invalid process inventory");
        }
        children.set(parent, [...(children.get(parent) ?? []), child]);
      }
      const descendants = [pid];
      const seen = new Set(descendants);
      for (let index = 0; index < descendants.length; index++) {
        for (const child of children.get(descendants[index]) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          descendants.push(child);
        }
      }
      for (const child of descendants.slice(1).reverse()) {
        try { process.kill(-child, "SIGKILL"); } catch {
          try { process.kill(child, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    } catch (error) {
      failure = `PROCESS_TERMINATION_FAILED: ${error.message}`;
    }
  }
  try {
    if (process.platform === "win32") {
      const killer = spawnAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, ...processLimits() });
      killer.on("error", () => {
        try { process.kill(pid, "SIGKILL"); } catch { return; }
      });
      killer.unref();
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch (error) {
    if (error.code !== "ESRCH") failure = `PROCESS_TERMINATION_FAILED: ${error.message}`;
  }
  return failure;
}

/**
 * @param {readonly string[]} argv
 * @param {{cwd: string, budgetMs: number, env?: NodeJS.ProcessEnv, stdin?: "inherit" | "ignore", stdout?: number, maxBytes?: number, inheritOutput?: boolean, onMessage?: (message: unknown) => void}} options
 * @returns {Promise<{kind: "exited", exitCode: number, stdout: string, stderr: string, elapsedMs: number} | {kind: "timeout", elapsedMs: number}>}
 */
export async function runProcessWithinBudget(argv, options) {
  const started = performance.now();
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("bounded process requires a command");
  const child = spawnAsync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? "ignore", options.stdout ?? (options.inheritOutput ? "inherit" : "pipe"), options.inheritOutput ? "inherit" : "pipe", ...(options.onMessage ? ["ipc"] : [])],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (options.onMessage) child.on("message", options.onMessage);
  const elapsed = () => Math.round(performance.now() - started);

  return await new Promise((resolveOutcome) => {
    let settled = false;
    let overflowed = false;
    let terminationFailure;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const collect = (sink) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
        if (!overflowed) {
          overflowed = true;
          terminationFailure = killTree(child.pid);
        }
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    const timer = setTimeout(() => {
      const failure = terminationFailure ?? killTree(child.pid);
      settle(failure === undefined
        ? { kind: "timeout", elapsedMs: elapsed() }
        : { kind: "exited", exitCode: 1, stdout: "", stderr: failure, elapsedMs: elapsed() });
    }, options.budgetMs);
    child.on("error", (error) => {
      settle({ kind: "exited", exitCode: 1, stdout: "", stderr: String(error), elapsedMs: elapsed() });
    });
    child.on("close", (code) => {
      if (overflowed) {
        settle({ kind: "exited", exitCode: code === 0 || code === null ? 1 : code, stdout: "", stderr: terminationFailure ?? "bounded child output exceeded its byte limit", elapsedMs: elapsed() });
        return;
      }
      settle({
        kind: "exited",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: elapsed(),
      });
    });
  });
}
