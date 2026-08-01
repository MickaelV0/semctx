import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-doctor-cli-"));
  roots.push(root);
  return root;
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
