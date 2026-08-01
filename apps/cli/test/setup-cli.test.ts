import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { saveConfig } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { parseArgs } from "../src/args";
import { runSetup } from "../src/commands/setup";

let root: string;

function git(repositoryRoot: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-setup-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("semctx setup — one-command bootstrap", () => {
  it("configures, indexes, scaffolds and validates in a single call", () => {
    const code = runSetup(root, parseArgs(["setup", "--root", root]));
    expect(code).toBe(0);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semctx.db"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
  });

  it("is idempotent — a second run keeps everything and scaffolds nothing new", () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let out = "";
    (process.stdout.write as unknown) = (chunk: string): boolean => ((out += chunk), true);
    let code: number;
    try {
      code = runSetup(root, parseArgs(["setup", "--json", "--root", root]));
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("setup");
    expect(report.verdict).toBe("SETUP_READY");
    expect(report.check.ok).toBe(true);
    expect(report.semanticFilesCreated).toBe(0);
    expect(report.nodes).toBeGreaterThan(0);
    expect(report.indexHealth.binding.status).toBe("valid");
  });

  it("refuses polyglot against an existing v1 config with setup_refused envelope", () => {
    const polyRoot = mkdtempSync(join(tmpdir(), "semctx-setup-poly-v1-"));
    try {
      mkdirSync(join(polyRoot, "src"), { recursive: true });
      writeFileSync(join(polyRoot, "src", "value.ts"), "export const value = 1;\n");
      writeFileSync(join(polyRoot, ".gitignore"), ".semctx/\n");
      git(polyRoot, "init", "-q");
      git(polyRoot, "add", ".");
      git(
        polyRoot,
        "-c",
        "user.name=Semctx Test",
        "-c",
        "user.email=semctx@example.test",
        "commit",
        "-q",
        "-m",
        "fixture",
      );
      // First setup writes default (v1) config
      expect(runSetup(polyRoot, parseArgs(["setup", "--root", polyRoot]))).toBe(0);

      const originalWrite = process.stdout.write.bind(process.stdout);
      let out = "";
      (process.stdout.write as unknown) = (chunk: string): boolean => ((out += chunk), true);
      let code: number;
      try {
        code = runSetup(
          polyRoot,
          parseArgs(["setup", "--polyglot", "--json", "--root", polyRoot]),
        );
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(code).toBe(1);
      const report = JSON.parse(out);
      expect(report.kind).toBe("setup_refused");
      expect(report.verdict).toBe("SETUP_REFUSED");
      expect(report.reasonCode).toBe("CONFIG_INVALID");
      expect(report.nextSteps.length).toBeGreaterThan(0);
    } finally {
      rmSync(polyRoot, { recursive: true, force: true });
    }
  });

  it("reports honest partial Plane A readiness for a successful polyglot setup", () => {
    const polyglotRoot = mkdtempSync(join(tmpdir(), "semctx-setup-polyglot-"));
    try {
      mkdirSync(join(polyglotRoot, "src"), { recursive: true });
      writeFileSync(join(polyglotRoot, "src", "value.ts"), "export const value = 1;\n");
      writeFileSync(join(polyglotRoot, "src", "value.py"), "def value():\n    return 1\n");
      writeFileSync(join(polyglotRoot, ".gitignore"), ".semctx/\n");
      git(polyglotRoot, "init", "-q");
      git(polyglotRoot, "add", ".");
      git(
        polyglotRoot,
        "-c",
        "user.name=Semctx Test",
        "-c",
        "user.email=semctx@example.test",
        "commit",
        "-q",
        "-m",
        "fixture",
      );

      const originalWrite = process.stdout.write.bind(process.stdout);
      let out = "";
      (process.stdout.write as unknown) = (chunk: string): boolean => ((out += chunk), true);
      let code: number;
      try {
        code = runSetup(
          polyglotRoot,
          parseArgs(["setup", "--polyglot", "--json", "--root", polyglotRoot]),
        );
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(code).toBe(0);
      const report = JSON.parse(out);
      expect(report.selection).toMatchObject({
        configVersion: 2,
        selectedByLanguage: {
          typescript: 1,
          python: 1,
        },
      });
      expect(report.indexHealth).toMatchObject({
        binding: { status: "valid" },
        coverage: {
          status: "partial",
          selected: 2,
          analyzed: 2,
          disabled: 0,
          unsupported: 0,
          failed: 0,
        },
      });
      expect(report.indexHealth.reasonSummary).toContain(
        "NEGATIVE_COMPLETENESS_MISSING",
      );
      expect(report.indexHealth.reasonSummary).not.toContain("CAPABILITY_MISSING");
      expect(report.indexHealth.reasonSummary).not.toContain("POLICY_DENIED");
    } finally {
      rmSync(polyglotRoot, { recursive: true, force: true });
    }
  });

  it("refuses ready when a selected v2 language is disabled", () => {
    const disabledRoot = mkdtempSync(join(tmpdir(), "semctx-setup-disabled-"));
    try {
      mkdirSync(join(disabledRoot, "src"), { recursive: true });
      writeFileSync(join(disabledRoot, "src", "value.py"), "def value():\n    return 1\n");
      git(disabledRoot, "init", "-q");
      git(disabledRoot, "add", ".");
      git(
        disabledRoot,
        "-c",
        "user.name=Semctx Test",
        "-c",
        "user.email=semctx@example.test",
        "commit",
        "-q",
        "-m",
        "fixture",
      );

      const config = createGlobSelectionConfig(disabledRoot);
      saveConfig(disabledRoot, {
        ...config,
        languages: {
          ...config.languages,
          python: "off",
        },
      });

      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      let out = "";
      let err = "";
      (process.stdout.write as unknown) =
        (chunk: string): boolean => ((out += chunk), true);
      (process.stderr.write as unknown) =
        (chunk: string): boolean => ((err += chunk), true);
      let code: number;
      try {
        code = runSetup(disabledRoot, parseArgs(["setup", "--root", disabledRoot]));
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }

      expect(code).toBe(1);
      expect(out).not.toContain("OK ready");
      expect(out).toContain("analysis  insufficient");
      expect(err).toContain("analysis is not ready");
    } finally {
      rmSync(disabledRoot, { recursive: true, force: true });
    }
  });
});
