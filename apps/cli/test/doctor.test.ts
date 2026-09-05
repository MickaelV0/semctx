import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexHealth, indexRepository } from "@semantic-context/app-services";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { dbPath, initWorkspace } from "@semantic-context/repository-store";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-doctor-cli-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

/** A real, disposable, git-backed, indexed workspace — not a mock of indexHealth's authority. */
function indexedRepository(empty = false): { root: string } {
  const root = temporaryRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "doctor-fixture" }, null, 2) + "\n");
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  if (!empty) writeFileSync(join(root, "src", "service.py"), ["def service():", "    return 1", ""].join("\n"));
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(root),
    include: ["src/**/*.py"],
    languages: { typescript: "on", python: "on", markdown: "on", sql: "on" },
  };
  initWorkspace(root, config);
  indexRepository(root, "2026-09-05T00:00:00.000Z");
  return { root };
}

/** Unlike `runDoctor` above, this preserves PATH: indexHealth's freshness check shells out to git. */
function runDoctorJson(root: string): { code: number; report: { healthy: boolean; checks: { name: string; ok: boolean; status?: string; detail: string }[] } } {
  const result = Bun.spawnSync([
    process.execPath, "run", CLI, "doctor", "--root", root, "--json",
  ], { stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    report: JSON.parse(new TextDecoder().decode(result.stdout)),
  };
}

function runDoctor(root: string, json = false): { code: number; out: string } {
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    CLI,
    "doctor",
    "--root",
    root,
    ...(json ? ["--json"] : []),
  ], {
    env: { ...process.env, PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    out: new TextDecoder().decode(result.stdout),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("doctor CLI compatibility advisory", () => {
  test("reports a missing global CLI in JSON without turning the advisory into authority", () => {
    const result = runDoctor(temporaryRoot(), true);
    const report = JSON.parse(result.out);

    expect(result.code).toBe(1);
    expect(report.cliCompatibility).toEqual({
      found: false,
      path: null,
      version: null,
      requiredVersion: report.version,
      compatible: false,
      reason: "CLI_NOT_FOUND",
      upgradeCommand: `bun install -g semctx@${report.version}`,
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.some((check: { name: string }) => check.name === "cliCompatibility"))
      .toBe(false);
  });

  test("prints one non-blocking upgrade advisory in human output", () => {
    const result = runDoctor(temporaryRoot());

    expect(result.out).toContain("[warn] global cli");
    expect(result.out).toContain("CLI_NOT_FOUND");
    expect(result.out).toContain("bun install -g semctx@");
  });
});

describe("doctor index status (delegates to app-services indexHealth/indexHealthStatus)", () => {
  test("a complete fresh index remains healthy", () => {
    const { root } = indexedRepository(true);
    expect(indexHealth(root).coverage.status).toBe("complete");
    const { code, report } = runDoctorJson(root);
    expect(report.healthy).toBe(true);
    expect(code).toBe(0);
  });
  test("reports degraded, not healthy, for a freshly indexed workspace with partial coverage", () => {
    const { root } = indexedRepository();
    const directHealth = indexHealth(root);
    expect(directHealth.binding.status).toBe("valid");
    expect(directHealth.freshness.canRunHighRiskControl).toBe(true);
    expect(directHealth.coverage.status).toBe("partial");

    const { code, report } = runDoctorJson(root);
    const indexCheck = report.checks.find((check) => check.name === "index")!;

    expect(indexCheck.status).toBe("degraded");
    expect(indexCheck.ok).toBe(false);
    expect(report.healthy).toBe(false);
    expect(code).toBe(1);
  });

  test("reports blocked, not healthy, when the working tree drifts from the sealed index", () => {
    const { root } = indexedRepository();
    writeFileSync(join(root, "src", "service.py"), ["def service():", "    return 2", ""].join("\n"));
    const directHealth = indexHealth(root);
    expect(directHealth.freshness.canRunHighRiskControl).toBe(false);

    const { code, report } = runDoctorJson(root);
    const indexCheck = report.checks.find((check) => check.name === "index")!;

    expect(indexCheck.status).toBe("blocked");
    expect(indexCheck.ok).toBe(false);
    expect(indexCheck.detail).toContain(`freshness ${directHealth.freshness.verdict}`);
    expect(report.healthy).toBe(false);
    expect(code).toBe(1);
  });

  test("missing database stays absent after diagnosis", () => {
    const { root } = indexedRepository();
    unlinkSync(dbPath(root));
    const { code, report } = runDoctorJson(root);
    expect(report.healthy).toBe(false);
    expect(code).toBe(1);
    expect(existsSync(dbPath(root))).toBe(false);
  });

  test("corrupt configuration produces a structured failure and preserves authored files", () => {
    const { root } = indexedRepository();
    const config = join(root, ".semctx", "config.json");
    const authored = join(root, ".semctx", "retained.sem");
    writeFileSync(config, "{broken");
    writeFileSync(authored, "authored state\n");
    const before = readFileSync(dbPath(root));
    const { code, report } = runDoctorJson(root);
    expect(code).toBe(1);
    expect(report.healthy).toBe(false);
    expect(report.checks.find((check) => check.name === "config")?.ok).toBe(false);
    expect(readFileSync(config, "utf8")).toBe("{broken");
    expect(readFileSync(authored, "utf8")).toBe("authored state\n");
    expect(readFileSync(dbPath(root)).equals(before)).toBe(true);
  });

  test("healthy diagnosis leaves database bytes and companion files unchanged", () => {
    const { root } = indexedRepository(true);
    const before = readFileSync(dbPath(root));
    const files = readdirSync(join(root, ".semctx")).sort();
    expect(runDoctorJson(root).report.healthy).toBe(true);
    expect(readFileSync(dbPath(root)).equals(before)).toBe(true);
    expect(readdirSync(join(root, ".semctx")).sort()).toEqual(files);
  });
});
