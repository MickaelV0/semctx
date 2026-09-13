/**
 * `semctx migrate config` proved at the CLI surface: flag validation, exit codes, and a real
 * plan -> apply -> restore round trip through JSON output, not just the underlying service.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigMigrationReportV1 } from "@semantic-context/control-model";
import { configMigrationsDir, configPath, initWorkspace, listConfigMigrationRuns } from "@semantic-context/repository-store";
import { parseArgs } from "../src/args";
import { runMigrate } from "../src/commands/migrate";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-migrate-config-cli-"));
  roots.push(root);
  return root;
}

function run(root: string, argv: string[]): { code: number; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    const code = runMigrate(root, parseArgs(argv));
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function jsonReport(out: string): ConfigMigrationReportV1 {
  return JSON.parse(out) as ConfigMigrationReportV1;
}

function setUpRepository(): string {
  const root = tempRoot();
  initWorkspace(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const value = 1;\n", "utf8");
  return root;
}

/**
 * Built from the actual raw config.json on disk, not a hand-typed shape: only the five
 * migratable fields are overridden, so policy fields such as `blockingRules` (populated by
 * `initWorkspace` with `DEFAULT_BLOCKING_RULES`) match the real current config exactly.
 */
function writeProposal(root: string, overrides: Record<string, unknown> = {}): void {
  const currentRaw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
  writeFileSync(
    join(root, "proposal.json"),
    JSON.stringify({
      ...currentRaw,
      version: 2,
      selectionMode: "globs-v1",
      include: ["src/**/*.ts"],
      languages: { typescript: "on", python: "off", markdown: "off", sql: "off" },
      ...overrides,
    }),
    "utf8",
  );
}

describe("migrate config — flag validation", () => {
  test("requires --proposal or --restore", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "--root", root]);
    expect(result.code).toBe(2);
  });

  test("--apply requires --plan", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "--proposal", "p.json", "--apply", "--root", root]);
    expect(result.code).toBe(2);
  });

  test("--restore rejects being combined with --proposal", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "--restore", "1-abc", "--proposal", "p.json", "--root", root]);
    expect(result.code).toBe(2);
  });

  test("rejects an unknown flag before touching the service", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "--proposal", "p.json", "--bogus", "x", "--root", root]);
    expect(result.code).toBe(2);
  });

  test("rejects --dry-run combined with --apply", () => {
    const root = tempRoot();
    const result = run(root, [
      "migrate", "config", "--proposal", "p.json", "--dry-run", "--apply", "--plan", "sha256:x", "--root", root,
    ]);
    expect(result.code).toBe(2);
  });

  test("rejects an invalid --format value", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "--proposal", "p.json", "--format", "yaml", "--root", root]);
    expect(result.code).toBe(2);
  });

  test("rejects an extra positional argument", () => {
    const root = tempRoot();
    const result = run(root, ["migrate", "config", "extra", "--proposal", "p.json", "--root", root]);
    expect(result.code).toBe(2);
  });
});

describe("migrate config — plan, apply, restore", () => {
  test("round-trips through the real CLI with --format json", () => {
    const root = setUpRepository();
    writeProposal(root);
    const originalBytes = readFileSync(configPath(root));

    const plan = run(root, ["migrate", "config", "--proposal", "proposal.json", "--format", "json", "--root", root]);
    expect(plan.code).toBe(0);
    const planReport = jsonReport(plan.out);
    expect(planReport.status).toBe("PLANNED");
    expect(planReport.planDigest).not.toBeNull();

    const apply = run(root, [
      "migrate",
      "config",
      "--proposal",
      "proposal.json",
      "--apply",
      "--plan",
      planReport.planDigest as string,
      "--format",
      "json",
      "--root",
      root,
    ]);
    expect(apply.code).toBe(0);
    const applyReport = jsonReport(apply.out);
    expect(applyReport.status).toBe("APPLIED");
    expect(JSON.parse(readFileSync(configPath(root), "utf8")).version).toBe(2);

    const restore = run(root, [
      "migrate",
      "config",
      "--restore",
      applyReport.runId as string,
      "--format",
      "json",
      "--root",
      root,
    ]);
    expect(restore.code).toBe(0);
    expect(jsonReport(restore.out).status).toBe("RESTORED");
    expect(readFileSync(configPath(root))).toEqual(originalBytes);
  });

  test("a refused plan exits non-zero and writes nothing", () => {
    const root = setUpRepository();
    writeProposal(root, { docsDirs: ["changed"] });

    const result = run(root, ["migrate", "config", "--proposal", "proposal.json", "--format", "json", "--root", root]);
    expect(result.code).toBe(1);
    expect(jsonReport(result.out).reasons).toEqual(["POLICY_CHANGE_REJECTED"]);
  });
});

const RUN_ID = `1700000000000-${"a".repeat(32)}`;

function planDigestOf(root: string): string {
  const plan = run(root, ["migrate", "config", "--proposal", "proposal.json", "--format", "json", "--root", root]);
  return jsonReport(plan.out).planDigest as string;
}

describe("parseArgs duplicate-flag metadata", () => {
  test("keeps last-value-wins flags and positionals, and names each repeated flag once, sorted", () => {
    const parsed = parseArgs(["migrate", "--plan", "a", "config", "--plan=b", "--apply", "--apply", "-v", "-v"]);
    expect(parsed.positionals).toEqual(["migrate", "config"]);
    expect(parsed.flags.get("plan")).toBe("b");
    expect(parsed.flags.get("apply")).toBe(true);
    expect(parsed.duplicateFlags).toEqual(["apply", "plan", "v"]);
  });

  test("is absent when no flag repeats", () => {
    expect("duplicateFlags" in parseArgs(["migrate", "config", "--proposal", "p.json", "--apply"])).toBe(false);
  });
});

describe("migrate config — ambiguous flags refuse before any service call", () => {
  const cases: Array<[string, (digest: string, root: string) => string[]]> = [
    ["--proposal twice", () => ["--proposal", "proposal.json", "--proposal", "proposal.json"]],
    ["--plan twice", (digest) => ["--proposal", "proposal.json", "--apply", "--plan", digest, "--plan", digest]],
    ["--apply twice", (digest) => ["--proposal", "proposal.json", "--apply", "--apply", "--plan", digest]],
    ["--restore twice", () => ["--restore", RUN_ID, "--restore", RUN_ID]],
    ["--format twice", () => ["--proposal", "proposal.json", "--format", "json", "--format", "text"]],
    ["--dry-run twice", () => ["--proposal", "proposal.json", "--dry-run", "--dry-run"]],
    ["--root twice", (_digest, root) => ["--proposal", "proposal.json", "--root", root]],
    ["--apply=true", (digest) => ["--proposal", "proposal.json", "--apply=true", "--plan", digest]],
    ["--apply=false", (digest) => ["--proposal", "proposal.json", "--apply=false", "--plan", digest]],
    ["--apply <digest>", (digest) => ["--proposal", "proposal.json", "--apply", digest]],
    ["--dry-run=false", (digest) => ["--proposal", "proposal.json", "--dry-run=false", "--apply", "--plan", digest]],
    ["--dry-run true", () => ["--proposal", "proposal.json", "--dry-run", "true"]],
    ["--dry-run with --restore", () => ["--restore", RUN_ID, "--dry-run"]],
    ["a bare --format", () => ["--proposal", "proposal.json", "--format"]],
  ];
  for (const [name, argv] of cases) {
    test(`${name} exits 2, prints no report and creates nothing`, () => {
      const root = setUpRepository();
      writeProposal(root);
      const before = readFileSync(configPath(root));
      const digest = planDigestOf(root);
      const result = run(root, ["migrate", "config", ...argv(digest, root), "--root", root]);
      expect(result.code).toBe(2);
      expect(result.out).toBe("");
      expect(readFileSync(configPath(root))).toEqual(before);
      expect(existsSync(configMigrationsDir(root))).toBe(false);
    });
  }
});

describe("migrate config — text and JSON name exact recovery and rebuild actions", () => {
  test("a published unrestored run: JSON names it with RESTORE_RUN, text gives the exact command", () => {
    const root = setUpRepository();
    writeProposal(root);
    const digest = planDigestOf(root);
    const applyArgs = ["migrate", "config", "--proposal", "proposal.json", "--apply", "--plan", digest, "--root", root];
    const applied = jsonReport(run(root, [...applyArgs, "--format", "json"]).out);
    expect(applied.requiredActions).toEqual(["REBUILD_INDEX", "RERUN_VERIFICATION"]);

    const blockedJson = run(root, [...applyArgs, "--format", "json"]);
    expect(blockedJson.code).toBe(1);
    const blocked = jsonReport(blockedJson.out);
    expect(blocked.reasons).toEqual(["RECOVERY_REQUIRED"]);
    expect(blocked.runId).toBe(applied.runId);
    expect(blocked.requiredActions).toEqual(["RESTORE_RUN"]);

    const blockedText = run(root, applyArgs);
    expect(blockedText.code).toBe(1);
    expect(blockedText.out).toContain(`semctx migrate config --restore ${applied.runId}`);
    expect(blockedText.out).not.toContain("nothing was written");
  });

  test("an apply refused after taking the lock never claims zero writes; a refused plan does", () => {
    const root = setUpRepository();
    writeProposal(root);
    const stale = run(root, [
      "migrate", "config", "--proposal", "proposal.json", "--apply", "--plan", `sha256:${"0".repeat(64)}`, "--root", root,
    ]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("STALE_PLAN");
    expect(stale.out).toContain("coordinator.db");
    expect(stale.out).not.toContain("nothing was written");

    writeProposal(root, { docsDirs: ["changed"] });
    const refusedPlan = run(root, ["migrate", "config", "--proposal", "proposal.json", "--root", root]);
    expect(refusedPlan.code).toBe(1);
    expect(refusedPlan.out).toContain("nothing was written");
  });

  test("applied and restored text name the undo command and the rebuild and verification actions", () => {
    const root = setUpRepository();
    writeProposal(root);
    const digest = planDigestOf(root);
    const applied = run(root, ["migrate", "config", "--proposal", "proposal.json", "--apply", "--plan", digest, "--root", root]);
    expect(applied.code).toBe(0);
    const [runId] = listConfigMigrationRuns(root);
    expect(applied.out).toContain(`semctx migrate config --restore ${runId}`);
    expect(applied.out).toContain("semctx index");

    const restored = run(root, ["migrate", "config", "--restore", runId as string, "--root", root]);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain("semctx index");
    expect(restored.out).toContain("re-run verification");
  });
});
