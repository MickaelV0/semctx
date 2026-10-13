import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStatusPreflightReportSchema, ControlStatusTimeoutReportSchema } from "@semantic-context/control-model";
import { controlStatusTimeout, runProcessWithinBudget } from "../src";

const bun = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runProcessWithinBudget", () => {
  test.skipIf(process.platform === "win32").each(["invalid", "blocked", "overflow"])(
    "a %s process inventory fails closed and still kills the direct process group", (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "semctx-budget-inventory-"));
      const pidFile = join(directory, "child.pid");
      try {
        {
          const body = mode === "invalid" ? 'console.log("not a process inventory")'
            : mode === "blocked" ? "await Bun.sleep(30_000)"
              : 'process.stdout.write("x".repeat(5 * 1024 * 1024))';
          writeFileSync(join(directory, "ps"), `#!/bin/sh\nexec "${bun}" -e '${body}'\n`);
          chmodSync(join(directory, "ps"), 0o755);
        }
        const worker = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`;
        const entry = `import { runProcessWithinBudget } from ${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))}; console.log(JSON.stringify(await runProcessWithinBudget([process.execPath, "-e", ${JSON.stringify(worker)}], { cwd: ${JSON.stringify(directory)}, budgetMs: 200 })));`;
        const child = Bun.spawnSync([bun, "-e", entry], {
          env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL",
        });
        expect(child.exitCode).toBe(0);
        const outcome = JSON.parse(child.stdout.toString());
        expect(outcome).toMatchObject({ kind: "exited", exitCode: 1, stdout: "" });
        expect(outcome.stderr).toContain("PROCESS_TERMINATION_FAILED");
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")("an isolated PATH retains native process-tree termination", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-budget-native-inventory-"));
    try {
      const entry = `import { runProcessWithinBudget } from ${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))}; console.log(JSON.stringify(await runProcessWithinBudget([process.execPath, "-e", "await Bun.sleep(30_000)"], { cwd: ${JSON.stringify(directory)}, budgetMs: 200 })));`;
      const child = Bun.spawnSync([bun, "-e", entry], {
        env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL",
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toMatchObject({ kind: "timeout" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an outer deadline also kills a child owned by a nested budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-nested-budget-"));
    const pidFile = join(directory, "nested.pid");
    let pid: number | undefined;
    try {
      const leaf = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30_000);`;
      const middle = `import { runProcessWithinBudget } from ${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))}; await runProcessWithinBudget([process.execPath, "-e", ${JSON.stringify(leaf)}], { cwd: ${JSON.stringify(directory)}, budgetMs: 20_000 });`;
      const outcome = await runProcessWithinBudget([bun, "-e", middle], { cwd: directory, budgetMs: 400 });
      expect(outcome.kind).toBe("timeout");
      pid = Number(readFileSync(pidFile, "utf8"));
      const deadline = performance.now() + 1_000;
      while (alive(pid) && performance.now() < deadline) await Bun.sleep(20);
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a child that outlives its budget is stopped and answered as a timeout within the budget", async () => {
    const started = performance.now();
    const outcome = await runProcessWithinBudget([bun, "-e", "await Bun.sleep(30_000)"], { cwd: tmpdir(), budgetMs: 300 });
    const elapsed = performance.now() - started;
    expect(outcome.kind).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a child that finishes in time returns its exit code and output", async () => {
    const outcome = await runProcessWithinBudget([bun, "-e", "process.stdout.write('{\"ok\":true}'); process.exit(3)"], { cwd: tmpdir(), budgetMs: 20_000 });
    expect(outcome).toMatchObject({ kind: "exited", exitCode: 3, stdout: '{"ok":true}' });
  });

  test("a grandchild cannot delay the deadline and does not outlive it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-bounded-tree-"));
    const pidFile = join(directory, "grandchild.pid");
    try {
      const script = [
        "const grandchild = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30_000)'], { stdout: 'inherit', stderr: 'inherit' });",
        `await Bun.write(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
        "await Bun.sleep(30_000);",
      ].join(" ");
      const started = performance.now();
      const outcome = await runProcessWithinBudget([bun, "-e", script], { cwd: tmpdir(), budgetMs: 1_500 });
      expect(outcome.kind).toBe("timeout");
      expect(performance.now() - started).toBeLessThan(2_500);
      const grandchild = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(grandchild)).toBe(true);
      // The tree kill runs after the answer; it must complete promptly, not at the grandchild's leisure.
      const deadline = performance.now() + 3_000;
      while (alive(grandchild) && performance.now() < deadline) await Bun.sleep(50);
      expect(alive(grandchild)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("TIMEOUT preflight report", () => {
  test("is a typed, schema-valid status that authorizes nothing and names its reason", () => {
    const report = controlStatusTimeout(5_000, 5_012);
    expect(ControlStatusTimeoutReportSchema.parse(report)).toEqual(report);
    expect(ControlStatusPreflightReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      verdict: "TIMEOUT",
      canRunHighRiskControl: false,
      reasons: ["STATUS_BUDGET_EXCEEDED"],
      freshnessSeal: null,
      budget: { budgetMs: 5_000, elapsedMs: 5_012 },
    });
    expect(report.explanation[0]?.detail).toContain("5000 ms");
  });

  test("cannot claim a high-risk permission", () => {
    const forged = { ...controlStatusTimeout(5_000, 5_012), canRunHighRiskControl: true };
    expect(ControlStatusPreflightReportSchema.safeParse(forged).success).toBe(false);
  });

  test("cannot explain itself with a freshness reason it does not carry", () => {
    const report = controlStatusTimeout(5_000, 5_012);
    const forged = { ...report, explanation: [{ ...report.explanation[0], reason: "HEAD_MISMATCH" }] };
    expect(ControlStatusPreflightReportSchema.safeParse(forged).success).toBe(false);
  });
});
