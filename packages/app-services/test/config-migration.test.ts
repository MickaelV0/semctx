import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configMigrationsDir, configPath, initWorkspace, runDir, runsDir, semctxDir } from "@semantic-context/repository-store";
import { applyConfigMigration, planConfigMigration, restoreConfigMigration } from "../src/config-migration";

/** A directory link; junctions need no privilege on Windows. */
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

const linksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-config-migration-app-link-probe-"));
  try {
    link(probe, join(probe, "self"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const linked = test.skipIf(!linksSupported);

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-config-migration-app-"));
  roots.push(root);
  return root;
}

function writeSource(root: string, relPath: string, content = "export const value = 1;\n"): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function writeProposal(root: string, relPath: string, proposal: unknown): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(proposal, null, 2), "utf8");
}

/**
 * Built from the actual raw config.json on disk, not a hand-typed shape: only the five
 * migratable fields are overridden, so every other policy field (including `blockingRules`,
 * which `initWorkspace` populates with `DEFAULT_BLOCKING_RULES`) matches the real current config
 * and never trips `POLICY_CHANGE_REJECTED` by accident.
 */
function v2Proposal(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const currentRaw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
  return {
    ...currentRaw,
    version: 2,
    selectionMode: "globs-v1",
    include: ["src/**/*.{ts,py}"],
    exclude: ["node_modules", "dist", ".semctx", ".git", "coverage"],
    languages: { typescript: "on", python: "on", markdown: "off", sql: "off" },
    ...overrides,
  };
}

/**
 * Deliberately exercises all three selection-diff buckets: `src/a.ts` and `src/nested/b.ts` are
 * selected under both v1 and v2 (unchanged); `docs/readme.md` is legacy-selected but misses the
 * v2 `include` (removed); `src/tool.py` is invisible to v1 (unsupported extension) but selected
 * once v2 enables Python (added).
 */
function setUpRepository(): string {
  const root = tempRoot();
  initWorkspace(root);
  writeSource(root, "src/a.ts");
  writeSource(root, "src/nested/b.ts");
  writeSource(root, "docs/readme.md", "# doc\n");
  writeSource(root, "src/tool.py", "value = 1\n");
  return root;
}

describe("planConfigMigration", () => {
  test("is a zero-write dry comparison that reports the selection diff and a stable digest", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));

    const before = readFileSync(configPath(root), "utf8");
    const report = planConfigMigration(root, "proposal.json");

    expect(report.status).toBe("PLANNED");
    expect(report.reasons).toEqual([]);
    expect(report.runId).toBeNull();
    expect(readFileSync(configPath(root), "utf8")).toBe(before);
    expect(existsSync(join(semctxDir(root), "config-migrations"))).toBe(false);
    expect(report.plan?.selectionDiff.added).toEqual(["src/tool.py"]);
    expect(report.plan?.selectionDiff.removed).toEqual(["docs/readme.md"]);
    expect([...(report.plan?.selectionDiff.unchanged ?? [])].sort()).toEqual(["src/a.ts", "src/nested/b.ts"]);

    const again = planConfigMigration(root, "proposal.json");
    expect(again.planDigest).toBe(report.planDigest);
  });

  test("treats an explicit empty include as an explicit empty selection, not a guess", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root, { include: [] }));

    const report = planConfigMigration(root, "proposal.json");
    expect(report.status).toBe("PLANNED");
    expect(report.plan?.selectionDiff.added).toEqual([]);
    expect([...(report.plan?.selectionDiff.removed ?? [])].sort()).toEqual(["docs/readme.md", "src/a.ts", "src/nested/b.ts"]);
  });

  test("refuses when a non-migratable field would silently change", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root, { docsDirs: ["changed"] }));

    const report = planConfigMigration(root, "proposal.json");
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["POLICY_CHANGE_REJECTED"]);
    expect(report.planDigest).toBeNull();
  });

  test("refuses a proposal path that escapes the repository root", () => {
    const root = setUpRepository();
    const report = planConfigMigration(root, "../outside.json");
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["INVALID_INPUT"]);
  });

  linked("refuses planning outright when the authored semantic inventory is a link, never folding an unreadable row into an otherwise-trusted plan", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const outside = mkdtempSync(join(tmpdir(), "semctx-config-migration-app-outside-"));
    roots.push(outside);
    link(outside, join(semctxDir(root), "semantic"));

    const report = planConfigMigration(root, "proposal.json");
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(report.plan).toBeNull();
    expect(report.planDigest).toBeNull();
  });

  test("refuses planning outright when .semctx/semantic is a regular file rather than a directory", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    writeFileSync(join(semctxDir(root), "semantic"), "not a directory", "utf8");

    const report = planConfigMigration(root, "proposal.json");
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(report.plan).toBeNull();
    expect(report.planDigest).toBeNull();
    expect(readFileSync(join(semctxDir(root), "semantic"), "utf8")).toBe("not a directory");
  });

  test("refuses applying outright when .semctx/semantic is a regular file, before any run is published", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    writeFileSync(join(semctxDir(root), "semantic"), "not a directory", "utf8");

    const report = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(report.runId).toBeNull();
    // The coordinator database may exist (the mutex directory is created before this refusal fires),
    // but no run was ever published and config.json was never touched.
    expect(existsSync(runsDir(root))).toBe(false);
    expect(JSON.parse(readFileSync(configPath(root), "utf8")).version).toBe(1);
  });
});

describe("applyConfigMigration / restoreConfigMigration", () => {
  test("applies exactly the planned digest, then restores byte-identical original bytes", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const originalBytes = readFileSync(configPath(root));

    const plan = planConfigMigration(root, "proposal.json");
    expect(plan.status).toBe("PLANNED");

    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("APPLIED");
    expect(applied.runId).not.toBeNull();
    const afterApply = JSON.parse(readFileSync(configPath(root), "utf8"));
    expect(afterApply.version).toBe(2);

    const restored = restoreConfigMigration(root, applied.runId as string);
    expect(restored.status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(originalBytes);

    // Idempotent: restoring an already-RESTORED run again is a safe no-op.
    const restoredAgain = restoreConfigMigration(root, applied.runId as string);
    expect(restoredAgain.status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(originalBytes);
  });

  test("refuses a stale plan when the repository changed since the digest was computed", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");

    writeSource(root, "src/new-after-plan.ts");

    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("REFUSED");
    expect(applied.reasons).toEqual(["STALE_PLAN"]);
    expect(JSON.parse(readFileSync(configPath(root), "utf8")).version).toBe(1);
  });

  test("refuses a new apply while a previous run is not yet restored", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("APPLIED");

    writeProposal(root, "proposal2.json", v2Proposal(root));
    const secondPlan = planConfigMigration(root, "proposal2.json");
    // planning is still allowed (read-only); but current config is v2, so it refuses at the input check.
    expect(secondPlan.status).toBe("REFUSED");

    const secondApply = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(secondApply.status).toBe("REFUSED");
    expect(secondApply.reasons).toEqual(["RECOVERY_REQUIRED"]);
    void secondPlan;
  });

  test("refuses restore with DIVERGENT_CONFIG and writes nothing when config matches neither before nor after", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("APPLIED");

    writeFileSync(configPath(root), '{"version":2,"tampered":true}\n', "utf8");
    const beforeRestoreBytes = readFileSync(configPath(root));

    const restored = restoreConfigMigration(root, applied.runId as string);
    expect(restored.status).toBe("REFUSED");
    expect(restored.reasons).toEqual(["DIVERGENT_CONFIG"]);
    // The run identity was already validated (manifest + both digests) before this refusal fires,
    // so it is exposed rather than dropped: the caller knows exactly which run needs attention.
    expect(restored.runId).toBe(applied.runId);
    expect(readFileSync(configPath(root))).toEqual(beforeRestoreBytes);
  });

  test("refuses restore of an unknown run id as an invalid artifact", () => {
    const root = setUpRepository();
    const restored = restoreConfigMigration(root, "not-a-real-run");
    expect(restored.status).toBe("REFUSED");
    expect(restored.reasons).toEqual(["INVALID_ARTIFACT"]);
    // A malformed run id names no run: refused before the lock, so nothing is created.
    expect(existsSync(configMigrationsDir(root))).toBe(false);
  });
});

describe("abandoned preparation directories are never filtered out — plan/apply/restore all refuse first", () => {
  function appliedForRestore(root: string) {
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("APPLIED");
    const runId = applied.runId as string;
    return { runId, config: readFileSync(configPath(root)), manifest: readFileSync(join(runDir(root, runId), "manifest.json")) };
  }

  const shapes: Array<[string, (root: string) => string]> = [
    [
      "a malformed prepare-<run-id> suffix",
      (root) => {
        const path = join(configMigrationsDir(root), "prepare-not-a-run-id");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "before.json"), "kept", "utf8");
        return path;
      },
    ],
    [
      "a non-directory prepare-<run-id>",
      (root) => {
        const id = `1700000000000-${"b".repeat(32)}`;
        const path = join(configMigrationsDir(root), `prepare-${id}`);
        mkdirSync(configMigrationsDir(root), { recursive: true });
        writeFileSync(path, "not a directory", "utf8");
        return path;
      },
    ],
  ];

  for (const [name, seed] of shapes) {
    test(`invalid arguments keep structural evidence visible when ${name} is present`, () => {
      const root = setUpRepository();
      const path = seed(root);
      const retainedPath = lstatSync(path).isDirectory() ? join(path, "before.json") : path;
      const retainedBytes = readFileSync(retainedPath);
      const before = readFileSync(configPath(root));
      const applied = applyConfigMigration(root, "proposal.json", "not-a-digest");
      expect(applied.reasons).toEqual(["INVALID_INPUT", "INVALID_ARTIFACT"]);
      const restored = restoreConfigMigration(root, "not-a-run-id");
      expect(restored.reasons).toEqual(["INVALID_ARTIFACT"]);
      expect(readFileSync(configPath(root))).toEqual(before);
      expect(readFileSync(retainedPath)).toEqual(retainedBytes);
      expect(existsSync(runsDir(root))).toBe(false);
    });

    test(`plan refuses INVALID_ARTIFACT before any write when ${name} is present, and preserves it`, () => {
      const root = setUpRepository();
      writeProposal(root, "proposal.json", v2Proposal(root));
      const path = seed(root);
      const before = readFileSync(configPath(root));

      const report = planConfigMigration(root, "proposal.json");

      expect(report.status).toBe("REFUSED");
      expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
      expect(report.plan).toBeNull();
      expect(readFileSync(configPath(root))).toEqual(before);
      expect(existsSync(path)).toBe(true);
    });

    test(`apply refuses INVALID_ARTIFACT before publishing a run when ${name} is present, and preserves it`, () => {
      const root = setUpRepository();
      writeProposal(root, "proposal.json", v2Proposal(root));
      const plan = planConfigMigration(root, "proposal.json");
      const before = readFileSync(configPath(root));
      const path = seed(root);

      const report = applyConfigMigration(root, "proposal.json", plan.planDigest as string);

      expect(report.status).toBe("REFUSED");
      expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
      expect(report.runId).toBeNull();
      expect(existsSync(runsDir(root))).toBe(false);
      expect(readFileSync(configPath(root))).toEqual(before);
      expect(existsSync(path)).toBe(true);
    });

    test(`restore refuses INVALID_ARTIFACT before touching config.json when ${name} is present, and preserves it`, () => {
      const root = setUpRepository();
      const original = appliedForRestore(root);
      const path = seed(root);
      const retainedPath = lstatSync(path).isDirectory() ? join(path, "before.json") : path;
      const retainedBytes = readFileSync(retainedPath);

      const report = restoreConfigMigration(root, original.runId);

      expect(report.status).toBe("REFUSED");
      expect(report.reasons).toEqual(["INVALID_ARTIFACT"]);
      expect(readFileSync(configPath(root))).toEqual(original.config);
      expect(readFileSync(join(runDir(root, original.runId), "manifest.json"))).toEqual(original.manifest);
      expect(readFileSync(retainedPath)).toEqual(retainedBytes);
    });
  }

  linked(`plan/apply/restore refuse INVALID_ARTIFACT before any write when a linked prepare-<run-id> is present, and preserve it`, () => {
    const id = `1700000000000-${"c".repeat(32)}`;

    const planRoot = setUpRepository();
    writeProposal(planRoot, "proposal.json", v2Proposal(planRoot));
    const outsidePlan = tempRoot();
    writeFileSync(join(outsidePlan, "before.json"), "leaked", "utf8");
    mkdirSync(configMigrationsDir(planRoot), { recursive: true });
    link(outsidePlan, join(configMigrationsDir(planRoot), `prepare-${id}`));
    const planReport = planConfigMigration(planRoot, "proposal.json");
    expect(planReport.status).toBe("REFUSED");
    expect(planReport.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(applyConfigMigration(planRoot, "proposal.json", "not-a-digest").reasons).toEqual(["INVALID_INPUT", "INVALID_ARTIFACT"]);
    expect(restoreConfigMigration(planRoot, "not-a-run-id").reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(readFileSync(join(outsidePlan, "before.json"), "utf8")).toBe("leaked");

    const applyRoot = setUpRepository();
    writeProposal(applyRoot, "proposal.json", v2Proposal(applyRoot));
    const plan = planConfigMigration(applyRoot, "proposal.json");
    const beforeApply = readFileSync(configPath(applyRoot));
    const outsideApply = tempRoot();
    writeFileSync(join(outsideApply, "before.json"), "leaked", "utf8");
    mkdirSync(configMigrationsDir(applyRoot), { recursive: true });
    link(outsideApply, join(configMigrationsDir(applyRoot), `prepare-${id}`));
    const applyReport = applyConfigMigration(applyRoot, "proposal.json", plan.planDigest as string);
    expect(applyReport.status).toBe("REFUSED");
    expect(applyReport.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(applyReport.runId).toBeNull();
    expect(existsSync(runsDir(applyRoot))).toBe(false);
    expect(readFileSync(configPath(applyRoot))).toEqual(beforeApply);
    expect(readFileSync(join(outsideApply, "before.json"), "utf8")).toBe("leaked");

    const restoreRoot = setUpRepository();
    const original = appliedForRestore(restoreRoot);
    const outsideRestore = tempRoot();
    writeFileSync(join(outsideRestore, "before.json"), "leaked", "utf8");
    mkdirSync(configMigrationsDir(restoreRoot), { recursive: true });
    link(outsideRestore, join(configMigrationsDir(restoreRoot), `prepare-${id}`));
    const restoreReport = restoreConfigMigration(restoreRoot, original.runId);
    expect(restoreReport.status).toBe("REFUSED");
    expect(restoreReport.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(readFileSync(configPath(restoreRoot))).toEqual(original.config);
    expect(readFileSync(join(runDir(restoreRoot, original.runId), "manifest.json"))).toEqual(original.manifest);
    expect(lstatSync(join(configMigrationsDir(restoreRoot), `prepare-${id}`)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outsideRestore, "before.json"), "utf8")).toBe("leaked");
  });
});

describe("migration container admission before lock or run traversal", () => {
  for (const container of ["config-migrations", "runs"] as const) {
    test(`apply and restore refuse a regular-file ${container} container without changing config`, () => {
      const root = setUpRepository();
      writeProposal(root, "proposal.json", v2Proposal(root));
      const plan = planConfigMigration(root, "proposal.json");
      const before = readFileSync(configPath(root));
      const path = container === "runs" ? runsDir(root) : configMigrationsDir(root);
      if (container === "runs") mkdirSync(configMigrationsDir(root), { recursive: true });
      writeFileSync(path, "retained container bytes", "utf8");
      const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
      expect(applied.status).toBe("REFUSED");
      expect(applied.reasons).toEqual(["INVALID_ARTIFACT"]);
      const restored = restoreConfigMigration(root, `1700000000000-${"e".repeat(32)}`);
      expect(restored.status).toBe("REFUSED");
      expect(restored.reasons).toEqual(["INVALID_ARTIFACT"]);
      expect(readFileSync(configPath(root))).toEqual(before);
      expect(readFileSync(path, "utf8")).toBe("retained container bytes");
    });
  }
});

describe("run admission, terminal runs and policy preservation", () => {
  function appliedRun(root: string): { planDigest: string; runId: string } {
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("APPLIED");
    return { planDigest: plan.planDigest as string, runId: applied.runId as string };
  }

  linked("restore preserves the admitted recovery identity when authored inventory becomes linked", () => {
    const root = setUpRepository();
    const { runId } = appliedRun(root);
    const candidateBytes = readFileSync(configPath(root));
    const manifestPath = join(runDir(root, runId), "manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    const outside = tempRoot();
    const authoredPath = join(outside, "keep.sem");
    writeFileSync(authoredPath, "authored data remains untouched\n", "utf8");
    const authoredBytes = readFileSync(authoredPath);
    link(outside, join(semctxDir(root), "semantic"));

    const report = restoreConfigMigration(root, runId);

    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["RECOVERY_REQUIRED", "INVALID_ARTIFACT"]);
    expect(report.runId).toBe(runId);
    expect(report.requiredActions).toEqual(["RESTORE_RUN"]);
    expect(readFileSync(configPath(root))).toEqual(candidateBytes);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(readFileSync(authoredPath)).toEqual(authoredBytes);
  });

  test("restore preserves the admitted recovery identity when authored inventory becomes a regular file", () => {
    const root = setUpRepository();
    const { runId } = appliedRun(root);
    const candidateBytes = readFileSync(configPath(root));
    const manifestPath = join(runDir(root, runId), "manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    writeFileSync(join(semctxDir(root), "semantic"), "not a directory", "utf8");

    const report = restoreConfigMigration(root, runId);

    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["RECOVERY_REQUIRED", "INVALID_ARTIFACT"]);
    expect(report.runId).toBe(runId);
    expect(report.requiredActions).toEqual(["RESTORE_RUN"]);
    expect(readFileSync(configPath(root))).toEqual(candidateBytes);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(readFileSync(join(semctxDir(root), "semantic"), "utf8")).toBe("not a directory");
  });

  test("a runs/<id> entry that is a regular file is never filtered out: apply refuses INVALID_ARTIFACT and names no runId", () => {
    const root = setUpRepository();
    writeProposal(root, "proposal.json", v2Proposal(root));
    const plan = planConfigMigration(root, "proposal.json");
    const before = readFileSync(configPath(root));
    const fileRunId = `1700000000000-${"d".repeat(32)}`;
    mkdirSync(join(semctxDir(root), "config-migrations", "runs"), { recursive: true });
    writeFileSync(runDir(root, fileRunId), "not a directory", "utf8");

    const applied = applyConfigMigration(root, "proposal.json", plan.planDigest as string);
    expect(applied.status).toBe("REFUSED");
    expect(applied.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(applied.runId).toBeNull();
    expect(readFileSync(configPath(root))).toEqual(before);
    expect(readFileSync(runDir(root, fileRunId), "utf8")).toBe("not a directory");

    const restored = restoreConfigMigration(root, fileRunId);
    expect(restored.status).toBe("REFUSED");
    expect(restored.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(readFileSync(configPath(root))).toEqual(before);
    expect(readFileSync(runDir(root, fileRunId), "utf8")).toBe("not a directory");
  });

  for (const terminal of [false, true]) {
    for (const shape of ["missing", "directory", "linked"] as const) {
      (shape === "linked" ? linked : test)(`restore ${terminal ? "terminal" : "unfinished"} run refuses ${shape} current config with the correct recovery identity`, () => {
        const root = setUpRepository();
        const { runId } = appliedRun(root);
        if (terminal) expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
        const manifestPath = join(runDir(root, runId), "manifest.json");
        const manifestBytes = readFileSync(manifestPath);
        const outside = tempRoot();
        const outsidePath = join(outside, "keep.json");
        writeFileSync(outsidePath, "third-party bytes remain untouched\n", "utf8");
        const outsideBytes = readFileSync(outsidePath);
        rmSync(configPath(root));
        if (shape === "directory") mkdirSync(configPath(root));
        if (shape === "linked") link(outside, configPath(root));

        const report = restoreConfigMigration(root, runId);

        expect(report.status).toBe("REFUSED");
        expect(report.reasons).toEqual(terminal ? ["INVALID_ARTIFACT"] : ["RECOVERY_REQUIRED", "INVALID_ARTIFACT"]);
        expect(report.runId).toBe(terminal ? null : runId);
        expect(report.requiredActions).toEqual(terminal ? [] : ["RESTORE_RUN"]);
        expect(readFileSync(manifestPath)).toEqual(manifestBytes);
        expect(readFileSync(outsidePath)).toEqual(outsideBytes);
        if (shape === "missing") expect(existsSync(configPath(root))).toBe(false);
        if (shape === "directory") expect(lstatSync(configPath(root)).isDirectory()).toBe(true);
        if (shape === "linked") expect(lstatSync(configPath(root)).isSymbolicLink()).toBe(true);
      });
    }
  }

  test("restore preserves the admitted recovery identity when the baseline is unreadable", () => {
    const root = setUpRepository();
    const { runId } = appliedRun(root);
    const candidateBytes = readFileSync(configPath(root));
    const manifestPath = join(runDir(root, runId), "manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    mkdirSync(join(semctxDir(root), "verification-state.json"));

    const report = restoreConfigMigration(root, runId);

    expect(report.status).toBe("REFUSED");
    expect(report.reasons).toEqual(["RECOVERY_REQUIRED", "INVALID_ARTIFACT"]);
    expect(report.runId).toBe(runId);
    expect(report.requiredActions).toEqual(["RESTORE_RUN"]);
    expect(readFileSync(configPath(root))).toEqual(candidateBytes);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
  });

  test("an unrestored run whose manifest fails validation is never offered as a recovery identity", () => {
    const root = setUpRepository();
    const { planDigest, runId } = appliedRun(root);
    const manifestPath = join(runDir(root, runId), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, repositoryRoot: "/elsewhere" }), "utf8");

    const blocked = applyConfigMigration(root, "proposal.json", planDigest);
    expect(blocked.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(blocked.runId).toBeNull();
    expect(blocked.requiredActions).toEqual([]);
    const restore = restoreConfigMigration(root, runId);
    expect(restore.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(restore.runId).toBeNull();
  });

  test("a RESTORED run whose stored bytes no longer match its digests is not accepted as terminal", () => {
    const root = setUpRepository();
    const originalBytes = readFileSync(configPath(root));
    const { planDigest, runId } = appliedRun(root);
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    writeFileSync(join(runDir(root, runId), "before.json"), "tampered", "utf8");

    const again = applyConfigMigration(root, "proposal.json", planDigest);
    expect(again.status).toBe("REFUSED");
    expect(again.reasons).toEqual(["INVALID_ARTIFACT"]);
    expect(again.runId).toBeNull();
    expect(readFileSync(configPath(root))).toEqual(originalBytes);
  });

  test("a terminal RESTORED run never overwrites a later value, even its own old candidate", () => {
    const root = setUpRepository();
    const { runId } = appliedRun(root);
    const candidateBytes = readFileSync(configPath(root));
    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    writeFileSync(configPath(root), candidateBytes);

    const again = restoreConfigMigration(root, runId);
    expect(again.status).toBe("REFUSED");
    expect(again.reasons).toEqual(["DIVERGENT_CONFIG"]);
    expect(again.runId).toBeNull();
    expect(again.requiredActions).toEqual([]);
    expect(readFileSync(configPath(root))).toEqual(candidateBytes);
  });

  test("preserves unknown and prototype-named policy fields in canonical serialization", () => {
    const root = setUpRepository();
    const withUnknown = readFileSync(configPath(root), "utf8")
      .replace(/\n}\s*$/, ',\n  "__proto__": { "polluted": true },\n  "futureField": { "keep": [1, 2] }\n}\n');
    writeFileSync(configPath(root), withUnknown, "utf8");
    const { runId } = appliedRun(root);

    const written = readFileSync(configPath(root), "utf8");
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(parsed["__proto__"]).toEqual({ polluted: true });
    expect(parsed["futureField"]).toEqual({ keep: [1, 2] });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());

    expect(restoreConfigMigration(root, runId).status).toBe("RESTORED");
    expect(readFileSync(configPath(root), "utf8")).toBe(withUnknown);

    // Dropping the prototype-named field is policy drift, never a silent strip.
    const dropped = Object.fromEntries(Object.entries(v2Proposal(root)).filter(([key]) => key !== "__proto__"));
    writeProposal(root, "dropped.json", dropped);
    expect(planConfigMigration(root, "dropped.json").reasons).toEqual(["POLICY_CHANGE_REJECTED"]);
  });
});
