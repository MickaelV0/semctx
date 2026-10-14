import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";

const DISCOVERY = join(import.meta.dir, "../src/discovery.ts");

/** On Windows a killed launcher's sleeper keeps its working directory open for a moment. */
function removeWhenReleased(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      Bun.sleepSync(250);
    }
  }
}

const environmentWithoutGit = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !/^GIT_/i.test(entry[0])));

/** Runs `createQualifiedPathEligibility` in a child, so the caller's real environment is observed. */
function eligibilityProgram(root: string, probe: string): string {
  const config = {
    ...createGlobSelectionConfig(root),
    include: ["src/**/*.ts"],
    selectionMode: "qualified-static-v1",
    analysisProfile: "public-monorepo-static-v1",
  };
  return `import { createQualifiedPathEligibility } from ${JSON.stringify(DISCOVERY)};
const config = ${JSON.stringify(config)};
${probe}`;
}

test("qualified eligibility reads the requested repository despite a GIT_DIR in the caller's environment", () => {
  const base = mkdtempSync(join(tmpdir(), "semctx-eligibility-git-"));
  const environment = environmentWithoutGit();
  const git = (cwd: string, ...args: string[]): void => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Eligibility", "-c", "user.email=eligibility@example.invalid", ...args], {
      cwd, env: environment, stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    const target = join(base, "target");
    const foreign = join(base, "foreign");
    for (const directory of [target, foreign]) {
      mkdirSync(directory);
      git(directory, "init", "--quiet");
    }
    // `dist/lib.ts` is tracked although `.gitignore` hides its directory: only the Git index of the
    // requested repository makes it an authored input of the qualified profile.
    mkdirSync(join(target, "dist"));
    writeFileSync(join(target, ".gitignore"), "dist/\n");
    writeFileSync(join(target, "dist", "lib.ts"), "export const lib = 1;\n");
    git(target, "add", ".gitignore");
    git(target, "add", "-f", "dist/lib.ts");
    git(target, "commit", "--quiet", "-m", "target");
    writeFileSync(join(foreign, "other.txt"), "x\n");
    git(foreign, "add", ".");
    git(foreign, "commit", "--quiet", "-m", "foreign");

    const program = eligibilityProgram(
      target,
      'console.log(JSON.stringify({ trackedOutput: createQualifiedPathEligibility(config)("dist/lib.ts") }));',
    );
    const run = (extra: Record<string, string>) => Bun.spawnSync([process.execPath, "-e", program], {
      env: { ...environment, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
    });
    const control = run({});
    expect(control.stderr.toString()).toBe("");
    expect(JSON.parse(control.stdout.toString())).toEqual({ trackedOutput: true });
    const steered = run({ GIT_DIR: join(foreign, ".git") });
    expect(steered.stderr.toString()).toBe("");
    expect(JSON.parse(steered.stdout.toString())).toEqual({ trackedOutput: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 40_000);

test("qualified eligibility refuses a stalled Git within its deadline with a named GIT_ERROR", () => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-eligibility-budget-"));
  try {
    const sleeper = `"${process.execPath}" -e "await Bun.sleep(6500)"`;
    if (process.platform === "win32") {
      writeFileSync(join(directory, "git.cmd"), `@echo off\r\n${sleeper}\r\n`);
    } else {
      writeFileSync(join(directory, "git"), `#!/bin/sh\nexec ${sleeper}\n`);
      chmodSync(join(directory, "git"), 0o755);
    }
    // Timed inside the child so that startup load cannot masquerade as a missed deadline.
    const program = eligibilityProgram(directory, `const started = performance.now();
try {
  createQualifiedPathEligibility(config);
  console.log(JSON.stringify({ outcome: "returned", elapsed: performance.now() - started }));
} catch (error) {
  console.log(JSON.stringify({ outcome: "threw", code: error.code, message: error.message, elapsed: performance.now() - started }));
}`);
    const result = Bun.spawnSync([process.execPath, "-e", program], {
      env: { ...process.env, PATH: directory }, stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
    });
    const outcome = JSON.parse(result.stdout.toString()) as { outcome: string; code?: string; message?: string; elapsed: number };
    expect(outcome.outcome).toBe("threw");
    expect(outcome.code).toBe("GIT_ERROR");
    expect(outcome.message).toContain("PROCESS_TIMEOUT");
    expect(outcome.elapsed).toBeLessThan(6_000);
  } finally {
    removeWhenReleased(directory);
  }
}, 40_000);
