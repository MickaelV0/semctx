import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";

test("completed concurrent budgets release their signal listeners", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const outcomes = await Promise.all([1, 2].map(() => runProcessWithinBudget(
    [process.execPath, "-e", "await Bun.sleep(40)"], { cwd: tmpdir(), budgetMs: 5000 },
  )));
  expect(outcomes.every((outcome) => outcome.kind === "exited" && outcome.exitCode === 0)).toBe(true);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

test.skipIf(process.platform === "win32").each([
  ["SIGINT", "default"], ["SIGTERM", "default"],
  ["SIGTERM", "host"], ["SIGTERM", "host-exit"],
] as const)(
  "%s cancellation with %s handling stops detached descendants", async (signal, handling) => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-cancellation-"));
    const pidsFile = join(directory, "pids.json");
    const beats = [join(directory, "leaf.beat"), join(directory, "grandchild.beat")];
    const handledFile = join(directory, "handled");
    const heartbeat = (path: string) => `const {appendFileSync}=await import('node:fs'); setInterval(()=>appendFileSync(${JSON.stringify(path)}, 'x'),25);`;
    const leaf = `const {spawn}=await import('node:child_process'); const {writeFileSync}=await import('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(heartbeat(beats[1]!))}],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid])); ${heartbeat(beats[0]!)}`;
    const hostHandler = handling === "default" ? "" : `process.on(${JSON.stringify(signal)},()=>{require('node:fs').appendFileSync(${JSON.stringify(handledFile)},'x'); ${handling === "host-exit" ? "process.exit(0);" : ""}});`;
    const supervisorCode = `import {runProcessWithinBudget} from ${JSON.stringify(join(import.meta.dir, "../../../plugins/shared/hooks/process-budget.mjs"))}; ${hostHandler} await runProcessWithinBudget([process.execPath,'-e',${JSON.stringify(leaf)}],{cwd:${JSON.stringify(directory)},budgetMs:20000});`;
    const supervisor = spawn(process.execPath, ["-e", supervisorCode], { detached: true, stdio: "ignore" });
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    let pids: number[] = [];
    try {
      const readyBy = performance.now() + 5000;
      while ((!existsSync(pidsFile) || beats.some((path) => !existsSync(path) || readFileSync(path).length < 2)) && performance.now() < readyBy) await Bun.sleep(25);
      expect(existsSync(pidsFile)).toBe(true);
      pids = JSON.parse(readFileSync(pidsFile, "utf8"));
      expect(beats.every((path) => existsSync(path) && readFileSync(path).length >= 2)).toBe(true);
      process.kill(-supervisor.pid!, signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("supervisor did not stop")), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (handling === "default") expect(outcome.signal).toBe(signal);
      else {
        expect(outcome).toEqual({ code: 0, signal: null });
        expect(readFileSync(handledFile, "utf8")).toBe("x");
      }
      await Bun.sleep(250);
      const stopped = beats.map((path) => readFileSync(path, "utf8"));
      await Bun.sleep(200);
      expect(beats.map((path) => readFileSync(path, "utf8"))).toEqual(stopped);
    } finally {
      for (const pid of [supervisor.pid, ...pids]) {
        if (pid === undefined) continue;
        try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* process already gone */ }
      }
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000,
);
