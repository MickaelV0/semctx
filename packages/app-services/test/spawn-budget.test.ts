import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginDeliveryQuery } from "../src/plugin-delivery";
import { DEFERRED_PROCESS_SUPERVISOR } from "../../../plugins/shared/hooks/process-budget.mjs";
import { resolveRevisionObjectId } from "../src/verification-state";

test.skipIf(process.platform === "win32")("core Git kills a blocked executable and reports a named failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-git-budget-"));
  const pidFile = join(directory, "pid");
  try {
    const executable = join(directory, "git");
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" -e 'import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); await Bun.sleep(6500); console.log("a".repeat(40));'\n`);
    chmodSync(executable, 0o755);
    const started = performance.now();
    const modulePath = join(import.meta.dir, "../src/verification-state.ts");
    const result = Bun.spawnSync([process.execPath, "-e", `import { resolveRevisionObjectId } from ${JSON.stringify(modulePath)}; try { resolveRevisionObjectId(${JSON.stringify(directory)}, "HEAD"); } catch (error) { console.error(error.message); process.exit(1); }`], { env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 9000, killSignal: "SIGKILL" });
    expect(new TextDecoder().decode(result.stderr)).toContain("PROCESS_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(6000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test("host query forcibly kills a process that ignores SIGTERM", () => {
  const started = performance.now();
  const outcome = runPluginDeliveryQuery([process.execPath, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(1500); console.log("late")'], tmpdir(), { timeoutMs: 200, maxBytes: 4096 });
  expect(outcome.timedOut).toBe(true);
  expect(outcome.code).not.toBe(0);
  expect(outcome.out).toBe("");
  expect(performance.now() - started).toBeLessThan(1000);
});

test.skipIf(process.platform === "win32").each(["qualified-output", "filter-config"])("%s Git capture rejects a stalled executable within its budget", (boundary) => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-qualified-git-budget-"));
  try {
    const executable = join(directory, "git");
    const stub = 'const args = process.argv.slice(1); if (args.includes("check-attr")) { const rows = args.includes("--all") ? ["filter"] : ["filter", "ident", "working-tree-encoding"]; process.stdout.write(rows.map(name => `file.ts\\0${name}\\0${name === "filter" ? "hostile" : "unspecified"}\\0`).join("")); } else { process.on("SIGTERM", () => {}); await Bun.sleep(6500); console.log("late"); }';
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" -e '${stub}' -- "$@"\n`);
    chmodSync(executable, 0o755);
    const invocation = boundary === "qualified-output"
      ? `import { assertQualifiedReportOutput } from ${JSON.stringify(join(import.meta.dir, "../../../apps/cli/src/commands/verify.ts"))}; assertQualifiedReportOutput(${JSON.stringify(directory)}, ${JSON.stringify(join(tmpdir(), "outside-report.json"))});`
      : `import { retainedWorkingTreeFilterPaths } from ${JSON.stringify(join(import.meta.dir, "../src/verification-state.ts"))}; retainedWorkingTreeFilterPaths(${JSON.stringify(directory)}, ["file.ts"]);`;
    const started = performance.now();
    const result = Bun.spawnSync([process.execPath, "-e", invocation], {
      env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 9_000, killSignal: "SIGKILL",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("PROCESS_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(6_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test("core Git reads the requested repository despite ambient Git steering variables", () => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-git-environment-"));
  try {
    const initialized = Bun.spawnSync(["git", "init", "-q", directory]);
    expect(initialized.exitCode).toBe(0);
    const committed = Bun.spawnSync(["git", "-C", directory, "-c", "user.name=Semctx Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    expect(committed.exitCode).toBe(0);
    const expected = resolveRevisionObjectId(directory, "HEAD");
    // The variables must be in the child's real startup environment: Bun does not hand later
    // process.env mutations to the processes it spawns, so mutating them in-process proves nothing.
    const steering = { GIT_DIR: join(directory, "missing.git"), GIT_WORK_TREE: tmpdir(), GIT_CONFIG_COUNT: "invalid" };
    const steered = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"], { env: { ...process.env, ...steering } });
    expect(steered.exitCode).not.toBe(0);
    const modulePath = join(import.meta.dir, "../src/verification-state.ts");
    const entry = `import { resolveRevisionObjectId } from ${JSON.stringify(modulePath)}; try { console.log(JSON.stringify({ head: resolveRevisionObjectId(${JSON.stringify(directory)}, "HEAD") })); } catch (error) { console.log(JSON.stringify({ error: error.message, details: error.details })); }`;
    const result = Bun.spawnSync([process.execPath, "-e", entry], {
      env: { ...process.env, ...steering }, stdout: "pipe", stderr: "pipe", timeout: 9_000, killSignal: "SIGKILL",
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ head: expected });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detached cleanup supervision survives its launcher and kills a blocked process tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-cleanup-budget-"));
  const pidFile = join(directory, "pids");
  try {
    const worker = `const grandchild = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(30000)'], { stdout: "inherit", stderr: "inherit" }); await Bun.write(process.env.SEMCTX_TEST_PID_FILE, JSON.stringify([process.pid, grandchild.pid])); process.on("SIGTERM", () => {}); await Bun.sleep(30000);`;
    const payload = Buffer.from(JSON.stringify([1000, process.execPath, "-e", worker])).toString("base64url");
    const launcher = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(DEFERRED_PROCESS_SUPERVISOR)}, ${JSON.stringify(payload)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref();`;
    const launched = Bun.spawnSync([process.execPath, "-e", launcher], { env: { ...process.env, SEMCTX_TEST_PID_FILE: pidFile }, timeout: 2000, killSignal: "SIGKILL" });
    expect(launched.exitCode).toBe(0);
    const deadline = performance.now() + 4000;
    let pids: number[] = [];
    while (performance.now() < deadline) {
      try { pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[]; } catch { pids = []; }
      if (pids.length === 2) break;
      await Bun.sleep(20);
    }
    expect(pids).toHaveLength(2);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (pids.some(alive) && performance.now() < deadline) await Bun.sleep(20);
    expect(pids.some(alive)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
