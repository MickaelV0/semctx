import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFERRED_PROCESS_SUPERVISOR, runProcessWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";

test.skipIf(process.platform === "win32").each(["invalid", "failed"])(
  "a %s process inventory cannot keep a settled supervisor alive through descendant pipes", (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-budget-pipes-"));
    const pidFile = join(directory, "pids.json");
    try {
      writeFileSync(join(directory, "ps"), `#!/bin/sh\n${mode === "invalid" ? 'echo "invalid inventory"' : "exit 1"}\n`);
      chmodSync(join(directory, "ps"), 0o755);
      const worker = [
        'const { spawn } = await import("node:child_process");',
        'const descendant = spawn(process.execPath, ["-e", "await Bun.sleep(30_000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
        `await Bun.write(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));`,
        "await Bun.sleep(30_000);",
      ].join("\n");
      const entry = [
        `import { runProcessWithinBudget } from ${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))};`,
        `console.log(JSON.stringify(await runProcessWithinBudget([process.execPath, "-e", ${JSON.stringify(worker)}], { cwd: ${JSON.stringify(directory)}, budgetMs: 500 })));`,
      ].join("\n");
      const supervisor = Bun.spawnSync([process.execPath, "-e", entry], {
        env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL",
      });
      // The promise already settled on the broken implementation; only natural process exit
      // proves that the surviving descendant's inherited pipes no longer hold its caller open.
      expect(JSON.parse(supervisor.stdout.toString())).toMatchObject({
        kind: "timeout", terminationWarning: expect.stringContaining("nested process groups may have survived"),
      });
      expect(supervisor.exitCode).toBe(0);
      expect(supervisor.stderr.toString()).toBe("");
      expect(JSON.parse(readFileSync(pidFile, "utf8"))).toHaveLength(2);
    } finally {
      if (existsSync(pidFile)) {
        for (const pid of JSON.parse(readFileSync(pidFile, "utf8")) as number[]) {
          try { process.kill(-pid, "SIGKILL"); } catch { /* group already stopped */ }
          try { process.kill(pid, "SIGKILL"); } catch { /* process already stopped */ }
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 5_000,
);

test("successful captured output and IPC are complete before settlement", async () => {
  const messages: unknown[] = [];
  const outcome = await runProcessWithinBudget([process.execPath, "-e", [
    'process.send({ ready: true });',
    'process.stdout.write("captured stdout");',
    'process.stderr.write("captured stderr");',
    "process.disconnect();",
  ].join("\n")], { cwd: tmpdir(), budgetMs: 5_000, onMessage: (message) => messages.push(message) });
  expect(outcome).toMatchObject({ kind: "exited", exitCode: 0, stdout: "captured stdout", stderr: "captured stderr" });
  expect(messages).toEqual([{ ready: true }]);
});

test.skipIf(process.platform === "win32").each(["failed", "hung"])(
  "deferred Windows cleanup stops its direct child when taskkill %s", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-deferred-fallback-"));
    const pidFile = join(directory, "child.pid");
    try {
      writeFileSync(join(directory, "taskkill"), `#!/bin/sh\n${mode === "failed" ? "exit 1" : 'exec /bin/sleep 30'}\n`);
      chmodSync(join(directory, "taskkill"), 0o755);
      const worker = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`;
      const payload = Buffer.from(JSON.stringify([500, process.execPath, "-e", worker])).toString("base64url");
      const entry = `Object.defineProperty(process, "platform", { value: "win32" });\n${DEFERRED_PROCESS_SUPERVISOR}`;
      const supervisor = Bun.spawnSync([process.execPath, "-e", entry, payload], {
        env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 8_000, killSignal: "SIGKILL",
      });
      expect(supervisor.exitCode).toBe(1);
      const pid = Number(readFileSync(pidFile, "utf8"));
      // Reaping can lag the supervisor's exit slightly; a zombie has no executing worker.
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000,
);

test.skipIf(process.platform === "win32").each(["overflow", "deadline"])("%s stays the first outcome while tree termination crosses the deadline", (first) => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-overflow-first-"));
  const pidFile = join(directory, "child.pid");
  try {
    writeFileSync(join(directory, "taskkill"), '#!/bin/sh\n/bin/sleep 0.5\nkill -9 "$2"\n');
    chmodSync(join(directory, "taskkill"), 0o755);
    const worker = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); ${first === "deadline" ? "await Bun.sleep(400);" : ""} process.stdout.write("overflow"); await Bun.sleep(30_000);`;
    const entry = [
      'Object.defineProperty(process, "platform", { value: "win32" });',
      `const { runProcessWithinBudget } = await import(${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))});`,
      `console.log(JSON.stringify(await runProcessWithinBudget([process.execPath, "-e", ${JSON.stringify(worker)}], { cwd: ${JSON.stringify(directory)}, budgetMs: 300, maxBytes: 1 })));`,
    ].join("\n");
    const supervisor = Bun.spawnSync([process.execPath, "-e", entry], {
      env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL",
    });
    expect(supervisor.exitCode).toBe(0);
    expect(JSON.parse(supervisor.stdout.toString())).toMatchObject(first === "deadline" ? { kind: "timeout" } : {
      kind: "exited", exitCode: 1, stdout: "", stderr: "bounded child output exceeded its byte limit",
    });
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
