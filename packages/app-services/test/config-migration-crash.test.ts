/**
 * ADR 0028 preservation and crash evidence. In-process tests use the internal checkpoint observer
 * to perturb the real filesystem at one exact persistence boundary. Crash tests run the real
 * service in a real child process that the same observer holds at a boundary; the parent kills it,
 * awaits its exit, inspects what it left, and recovers only through the real apply/restore API —
 * which also proves the killed owner's cooperative lock was released.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SemctxError, attachSuppressedError, isSemctxError } from "@semantic-context/core";
import {
  configMigrationsDir,
  configPath,
  dbPath,
  initWorkspace,
  listAbandonedConfigMigrationPreparations,
  listConfigMigrationRuns,
  readConfigMigrationAfter,
  readConfigMigrationBefore,
  readConfigMigrationManifest,
  runDir,
  semctxDir,
  verificationStatePath,
} from "@semantic-context/repository-store";
import type { ConfigMigrationReportV1 } from "@semantic-context/control-model";
import { setConfigMigrationCheckpointObserver } from "../../repository-store/src/config-migration-checkpoint";
import type { ConfigMigrationCheckpoint } from "../../repository-store/src/config-migration-checkpoint";
import {
  applyConfigMigration,
  attachConfigMigrationRecovery,
  planConfigMigration,
  restoreConfigMigration,
} from "../src/config-migration";

const REPO_ROOT = process.cwd();
const MARKER_DEADLINE_MS = 45_000;
const CRASH_TEST_TIMEOUT_MS = 90_000;
const roots: string[] = [];

afterEach(() => {
  setConfigMigrationCheckpointObserver(undefined);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Authored intent, a verification baseline and an index — none of which this command may change. */
function setUpRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-config-migration-crash-"));
  roots.push(root);
  initWorkspace(root);
  writeFile(root, "src/a.ts", "export const value = 1;\n");
  writeFile(root, "src/tool.py", "value = 1\n");
  writeFile(root, ".semctx/semantic/intent.sem", "intent: keep config migration explicit\n");
  writeFile(root, ".semctx/semantic/nested/deep.sem", "invariant: authored data is never rewritten\n");
  writeFileSync(verificationStatePath(root), '{"seeded":"baseline"}\n', "utf8");
  // Deliberately not a database: opening it as the index store would fail or rewrite it.
  writeFileSync(dbPath(root), Buffer.from("seeded index bytes \x00\x01\x02 never opened\n", "utf8"));
  const currentRaw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
  writeFile(root, "proposal.json", JSON.stringify({
    ...currentRaw,
    version: 2,
    selectionMode: "globs-v1",
    include: ["src/**/*.{ts,py}"],
    exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"],
    languages: { typescript: "on", python: "on", markdown: "off", sql: "off" },
  }, null, 2));
  return root;
}

/** Full bytes of everything under `.semctx` except config.json, its temps and this command's own tree. */
function protectedSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(semctxDir(root), abs).replaceAll("\\", "/");
      if (rel === "config.json" || rel === "config-migrations" || /^config\.json\..+\.tmp$/.test(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else snapshot[rel] = readFileSync(abs).toString("base64");
    }
  };
  walk(semctxDir(root));
  return snapshot;
}

function expectProtected(root: string, before: Record<string, string>): void {
  expect(Object.keys(before)).toEqual(
    expect.arrayContaining(["semantic/intent.sem", "semantic/nested/deep.sem", "verification-state.json", "semctx.db"]),
  );
  expect(protectedSnapshot(root)).toEqual(before);
}

function manifestState(root: string, runId: string): string {
  return (JSON.parse(readConfigMigrationManifest(root, runId).toString("utf8")) as { state: string }).state;
}

function onlyRun(root: string): string {
  const runs = listConfigMigrationRuns(root);
  expect(runs).toHaveLength(1);
  return runs[0] as string;
}

function planned(root: string): string {
  const plan = planConfigMigration(root, "proposal.json");
  expect(plan.status).toBe("PLANNED");
  return plan.planDigest as string;
}

function applied(root: string, digest: string): ConfigMigrationReportV1 {
  const report = applyConfigMigration(root, "proposal.json", digest);
  expect(report.status).toBe("APPLIED");
  return report;
}

/** Runs `action` the first time this process reaches `checkpoint`; `afterEach` removes the observer. */
function atCheckpoint(checkpoint: ConfigMigrationCheckpoint, action: () => void): { fired: () => number } {
  let fired = 0;
  setConfigMigrationCheckpointObserver((reached) => {
    if (reached !== checkpoint || fired > 0) return;
    fired += 1;
    action();
  });
  return { fired: () => fired };
}

describe("observed preservation of authored data, baseline and index", () => {
  test("nominal plan -> apply -> restore keeps every protected byte and restores exact config bytes", () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const report = applied(root, planned(root));
    expect(report.requiredActions).toEqual(["REBUILD_INDEX", "RERUN_VERIFICATION"]);
    expectProtected(root, protectedBefore);
    const restored = restoreConfigMigration(root, report.runId as string);
    expect(restored.status).toBe("RESTORED");
    expect(restored.planDigest).toBe(report.planDigest);
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  });

  test("authored drift after publication, before the swap: refused with the published run, config untouched", () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const digest = planned(root);
    const probe = atCheckpoint("publish:before-rename", () => writeFile(root, ".semctx/semantic/intent.sem", "edited concurrently\n"));
    const report = applyConfigMigration(root, "proposal.json", digest);
    expect(probe.fired()).toBe(1);
    const runId = onlyRun(root);
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["STALE_PLAN", "RECOVERY_REQUIRED"]);
    expect(report.runId).toBe(runId);
    expect(report.requiredActions).toEqual(["RESTORE_RUN"]);
    expect(readFileSync(configPath(root))).toEqual(original);
    expect(manifestState(root, runId)).toBe("APPLYING");

    setConfigMigrationCheckpointObserver(undefined);
    const blocked = applyConfigMigration(root, "proposal.json", digest);
    expect(blocked.reasons).toEqual(["RECOVERY_REQUIRED"]);
    expect(blocked.runId).toBe(runId);
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    // Restore compares with its own start: the later authored edit is kept, never rolled back.
    expect(readFileSync(join(semctxDir(root), "semantic", "intent.sem"), "utf8")).toBe("edited concurrently\n");
  });

  test("baseline drift after the config swap: refused with the landed run, and restore undoes only config", () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const digest = planned(root);
    const probe = atCheckpoint("config:after-rename", () => writeFileSync(verificationStatePath(root), '{"seeded":"moved"}\n', "utf8"));
    const report = applyConfigMigration(root, "proposal.json", digest);
    expect(probe.fired()).toBe(1);
    const runId = onlyRun(root);
    expect(report.reasons).toEqual(["STALE_PLAN", "RECOVERY_REQUIRED"]);
    expect(report.runId).toBe(runId);
    expect(readFileSync(configPath(root))).toEqual(Buffer.from(readConfigMigrationAfter(root, runId)));

    setConfigMigrationCheckpointObserver(undefined);
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expect(readFileSync(verificationStatePath(root), "utf8")).toBe('{"seeded":"moved"}\n');
  });

  test("authored drift during a restore: refused with the run still unrestored, and a re-run finalizes", () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const runId = applied(root, planned(root)).runId as string;
    const probe = atCheckpoint("config:before-rename", () => writeFile(root, ".semctx/semantic/added.sem", "added mid-restore\n"));
    const interrupted = restoreConfigMigration(root, runId);
    expect(probe.fired()).toBe(1);
    expect(interrupted.status).toBe("REFUSED");
    expect(interrupted.reasons).toEqual(["RECOVERY_REQUIRED"]);
    expect(interrupted.runId).toBe(runId);
    expect(manifestState(root, runId)).toBe("RESTORING");
    expect(readFileSync(configPath(root))).toEqual(original);

    setConfigMigrationCheckpointObserver(undefined);
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(manifestState(root, runId)).toBe("RESTORED");
    expect(readFileSync(join(semctxDir(root), "semantic", "added.sem"), "utf8")).toBe("added mid-restore\n");
  });
});

describe("recovery identity of a genuine I/O failure", () => {
  const sites = [
    { name: "nested stat", method: "statSync", path: ".semctx/semantic/nested/deep.sem" },
    { name: "authored read", method: "readFileSync", path: ".semctx/semantic/nested/deep.sem" },
    { name: "baseline read", method: "readFileSync", path: ".semctx/verification-state.json" },
  ] as const;

  function withInventoryFailure(
    root: string,
    site: (typeof sites)[number],
    failure: NodeJS.ErrnoException,
    action: () => void,
    enabled: () => boolean = () => true,
  ): void {
    const target = join(root, ...site.path.split("/"));
    const original = fs[site.method];
    let injections = 0;
    const probe = spyOn(fs, site.method).mockImplementation((...args: unknown[]) => {
      if (String(args[0]) === target && enabled()) {
        injections += 1;
        throw failure;
      }
      return Reflect.apply(original, fs, args);
    });
    try {
      action();
    } finally {
      probe.mockRestore();
    }
    expect(injections).toBeGreaterThan(0);
  }

  for (const site of sites) {
    for (const code of ["EACCES", "EIO"]) {
      test(`inventory I/O: ${site.name} preserves ${code} before publication`, () => {
        const root = setUpRepository();
        const configBefore = readFileSync(configPath(root));
        const protectedBefore = protectedSnapshot(root);
        const failure = Object.assign(new Error(`${code}: injected ${site.name}`), { code });
        withInventoryFailure(root, site, failure, () => {
          let caught: unknown;
          try { planConfigMigration(root, "proposal.json"); } catch (error) { caught = error; }
          expect(caught).toBe(failure);
        });
        expect(readFileSync(configPath(root))).toEqual(configBefore);
        expectProtected(root, protectedBefore);
        expect(listConfigMigrationRuns(root)).toEqual([]);
      });

      test(`inventory I/O: ${site.name} preserves ${code} and recovery identity after the config swap`, () => {
        const root = setUpRepository();
        const original = readFileSync(configPath(root));
        const protectedBefore = protectedSnapshot(root);
        const digest = planned(root);
        const restoring = site.name === "baseline read";
        const existingRun = restoring ? applied(root, digest).runId as string : undefined;
        let armed = false;
        const checkpoint = atCheckpoint("config:after-rename", () => { armed = true; });
        const failure = Object.assign(new Error(`${code}: injected ${site.name}`), { code });
        let caught: unknown;
        withInventoryFailure(root, site, failure, () => {
          try {
            if (existingRun !== undefined) restoreConfigMigration(root, existingRun);
            else applyConfigMigration(root, "proposal.json", digest);
          } catch (error) { caught = error; }
        }, () => armed);
        expect(checkpoint.fired()).toBe(1);
        const runId = onlyRun(root);
        expect(isSemctxError(caught)).toBe(true);
        const error = caught as SemctxError;
        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toBe(failure.message);
        expect(error.cause).toBe(failure);
        expect((error.cause as NodeJS.ErrnoException).code).toBe(code);
        expect(error.details["recoveryRunId"]).toBe(runId);
        expect(error.details["recoveryCommand"]).toBe(`semctx migrate config --restore ${runId}`);
        expect(manifestState(root, runId)).toBe(restoring ? "RESTORING" : "APPLYING");
        expect(readConfigMigrationBefore(root, runId)).toEqual(original);
        expect(readFileSync(configPath(root))).toEqual(Buffer.from(restoring ? original : readConfigMigrationAfter(root, runId)));
        expectProtected(root, protectedBefore);
        setConfigMigrationCheckpointObserver(undefined);
        expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
        expect(readFileSync(configPath(root))).toEqual(original);
        expectProtected(root, protectedBefore);
      });
    }

    for (const code of ["ENOENT", "ENOTDIR", "EISDIR"]) {
      test(`inventory I/O: ${site.name} keeps structural ${code} as an invalid artifact`, () => {
        const root = setUpRepository();
        const configBefore = readFileSync(configPath(root));
        const protectedBefore = protectedSnapshot(root);
        const failure = Object.assign(new Error(`${code}: injected ${site.name}`), { code });
        withInventoryFailure(root, site, failure, () => {
          const report = planConfigMigration(root, "proposal.json");
          expect(report.status).toBe("REFUSED");
          expect(report.reasons).toContain("INVALID_ARTIFACT");
        });
        expect(readFileSync(configPath(root))).toEqual(configBefore);
        expectProtected(root, protectedBefore);
        expect(listConfigMigrationRuns(root)).toEqual([]);
      });
    }
  }

  test("a write failure after publication and the config rename is thrown, not refused, and names the run", () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const digest = planned(root);
    const aside = join(configMigrationsDir(root), "moved-aside");
    let runId = "";
    atCheckpoint("config:after-rename", () => {
      runId = onlyRun(root);
      // The run directory disappears under the apply: its APPLIED manifest write then fails for real.
      renameSync(runDir(root, runId), aside);
    });
    let caught: unknown;
    try {
      applyConfigMigration(root, "proposal.json", digest);
    } catch (error) {
      caught = error;
    }
    expect(isSemctxError(caught)).toBe(true);
    const error = caught as SemctxError;
    expect(error.code).toBe("IO_ERROR");
    expect(error.details["recoveryRunId"]).toBe(runId);
    expect(error.details["recoveryCommand"]).toBe(`semctx migrate config --restore ${runId}`);
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(error.message).toBe((error.cause as Error).message);

    setConfigMigrationCheckpointObserver(undefined);
    renameSync(aside, runDir(root, runId));
    expect(manifestState(root, runId)).toBe("APPLYING");
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
  });

  test("the recovery annotation keeps the primary failure and every suppressed cleanup failure", () => {
    const runId = `1700000000000-${"e".repeat(32)}`;
    const combined = attachSuppressedError(new SemctxError("STORE_ERROR", "primary write failed", { path: "x" }), new Error("rollback failed"));
    const annotated = attachConfigMigrationRecovery(combined, runId);
    expect(annotated.code).toBe("STORE_ERROR");
    expect(annotated.message).toBe("primary write failed");
    expect(annotated.details["path"]).toBe("x");
    expect(annotated.details["recoveryRunId"]).toBe(runId);
    expect(annotated.details["suppressed"]).toEqual([{ name: "Error", message: "rollback failed" }]);
    expect((annotated as unknown as { suppressed: Error[] }).suppressed.map((item) => item.message)).toEqual(["rollback failed"]);
    expect(annotated.cause).toBe(combined);

    const raw = attachSuppressedError(new Error("disk full"), new Error("close failed"));
    const wrapped = attachConfigMigrationRecovery(raw, runId);
    expect(wrapped.code).toBe("IO_ERROR");
    expect(wrapped.message).toBe("disk full");
    expect(wrapped.details["suppressed"]).toEqual([{ name: "Error", message: "close failed" }]);
    expect(wrapped.cause).toBe(raw);
  });
});

function crashChildSource(): string {
  return `
    import { writeSync } from "node:fs";
    import { setConfigMigrationCheckpointObserver } from "./packages/repository-store/src/config-migration-checkpoint.ts";
    import { applyConfigMigration, restoreConfigMigration } from "./packages/app-services/src/config-migration.ts";
    const [operation, root, checkpoint, first, second] = process.argv.slice(1);
    setConfigMigrationCheckpointObserver((reached) => {
      if (reached !== checkpoint) return;
      writeSync(1, "CHECKPOINT:" + reached + "\\n");
      // Rendezvous: hold the real mutation, and the real lock, at this boundary until killed.
      while (true) Bun.sleepSync(50);
    });
    const report = operation === "apply" ? applyConfigMigration(root, first, second) : restoreConfigMigration(root, first);
    writeSync(1, "COMPLETED:" + report.status + "\\n");
  `;
}

async function readUntil(stream: ReadableStream<Uint8Array>, seen: { text: string }, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + MARKER_DEADLINE_MS;
  while (!seen.text.includes(marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${marker}; observed: ${seen.text}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}; observed: ${seen.text}`)), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.done) throw new Error(`child stdout closed before ${marker}; observed: ${seen.text}`);
    seen.text += decoder.decode(result.value, { stream: true });
  }
}

/**
 * Run the real service in a child held at `checkpoint`, optionally act while it still owns the
 * lock, then SIGKILL it before it can complete and await its exit. The child is always reaped.
 */
async function killAtCheckpoint(
  operation: "apply" | "restore",
  root: string,
  checkpoint: ConfigMigrationCheckpoint,
  operands: readonly string[],
  whileHeld?: () => void,
): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", crashChildSource(), operation, root, checkpoint, ...operands], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  let reaped = false;
  try {
    const seen = { text: "" };
    await readUntil(child.stdout, seen, `CHECKPOINT:${checkpoint}`);
    expect(child.exitCode).toBeNull();
    whileHeld?.();
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    reaped = true;
    expect(seen.text).not.toContain("COMPLETED:");
  } finally {
    if (!reaped) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

describe("real process interruption at each persistence boundary", () => {
  test("killed before PREPARED publication: the preparation stays, no run exists, a new run proceeds", async () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const digest = planned(root);
    await killAtCheckpoint("apply", root, "publish:before-rename", ["proposal.json", digest]);

    expect(listConfigMigrationRuns(root)).toEqual([]);
    const abandoned = listAbandonedConfigMigrationPreparations(root);
    expect(abandoned).toHaveLength(1);
    const preparation = join(configMigrationsDir(root), abandoned[0] as string);
    expect(readdirSync(preparation).sort()).toEqual(["after.json", "before.json", "manifest.json"]);
    expect(readFileSync(configPath(root))).toEqual(original);

    // The killed owner's lock is gone, and a stopped PREPARING attempt never blocks a new run.
    const report = applied(root, digest);
    expect(`prepare-${report.runId}`).not.toBe(abandoned[0]);
    expect(report.abandonedPreparations).toEqual(abandoned);
    expect(existsSync(preparation)).toBe(true);
    expect(restoreConfigMigration(root, report.runId as string).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  }, CRASH_TEST_TIMEOUT_MS);

  test("killed after APPLYING, before the config rename: config untouched, temp kept, run blocks until restored", async () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const digest = planned(root);
    await killAtCheckpoint("apply", root, "config:before-rename", ["proposal.json", digest], () => {
      // While the child owns the lock, a competing process is refused within the bounded busy timeout.
      const busy = restoreConfigMigration(root, onlyRun(root));
      expect(busy.reasons).toEqual(["ACTIVE_MIGRATION"]);
      expect(busy.runId).toBeNull();
    });

    const runId = onlyRun(root);
    expect(manifestState(root, runId)).toBe("APPLYING");
    expect(readFileSync(configPath(root))).toEqual(original);
    const temps = readdirSync(semctxDir(root)).filter((name) => /^config\.json\..+\.tmp$/.test(name));
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(semctxDir(root), temps[0] as string))).toEqual(Buffer.from(readConfigMigrationAfter(root, runId)));

    const blocked = applyConfigMigration(root, "proposal.json", digest);
    expect(blocked.reasons).toEqual(["RECOVERY_REQUIRED"]);
    expect(blocked.runId).toBe(runId);
    expect(blocked.requiredActions).toEqual(["RESTORE_RUN"]);

    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(manifestState(root, runId)).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);

    // The same plan after RESTORED is still valid and is applied as a new run.
    expect(planned(root)).toBe(digest);
    const again = applied(root, digest);
    expect(again.runId).not.toBe(runId);
    expect(restoreConfigMigration(root, again.runId as string).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  }, CRASH_TEST_TIMEOUT_MS);

  test("killed after the config rename: the candidate is live, and restore returns the exact original bytes", async () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const digest = planned(root);
    await killAtCheckpoint("apply", root, "config:after-rename", ["proposal.json", digest]);

    const runId = onlyRun(root);
    expect(manifestState(root, runId)).toBe("APPLYING");
    expect(readFileSync(configPath(root))).toEqual(Buffer.from(readConfigMigrationAfter(root, runId)));
    const blocked = applyConfigMigration(root, "proposal.json", digest);
    expect(blocked.reasons).toEqual(["RECOVERY_REQUIRED"]);
    expect(blocked.runId).toBe(runId);

    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  }, CRASH_TEST_TIMEOUT_MS);

  test("killed during restore, before its config rename: RESTORING with the candidate live, then recovered exactly", async () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const runId = applied(root, planned(root)).runId as string;
    await killAtCheckpoint("restore", root, "config:before-rename", [runId]);

    expect(manifestState(root, runId)).toBe("RESTORING");
    expect(readFileSync(configPath(root))).toEqual(Buffer.from(readConfigMigrationAfter(root, runId)));
    expect(applyConfigMigration(root, "proposal.json", `sha256:${"0".repeat(64)}`).reasons).toEqual(["RECOVERY_REQUIRED"]);

    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  }, CRASH_TEST_TIMEOUT_MS);

  test("killed during restore, after its config rename: original bytes are back and restore finalizes", async () => {
    const root = setUpRepository();
    const original = readFileSync(configPath(root));
    const protectedBefore = protectedSnapshot(root);
    const runId = applied(root, planned(root)).runId as string;
    await killAtCheckpoint("restore", root, "config:after-rename", [runId]);

    expect(manifestState(root, runId)).toBe("RESTORING");
    expect(readFileSync(configPath(root))).toEqual(original);
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(manifestState(root, runId)).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(original);
    expectProtected(root, protectedBefore);
  }, CRASH_TEST_TIMEOUT_MS);
});
