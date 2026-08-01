import { afterEach, describe, expect, it } from "bun:test";
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
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { isInitialized, loadConfig, saveConfig } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { setupRepository } from "../src/setup";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function freshSample(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-setup-svc-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  return root;
}

describe("setupRepository (shared SSoT)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("bootstraps a fresh workspace to READY", () => {
    root = freshSample();
    const report = setupRepository(root);
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.configWritten).toBe(true);
    expect(report.alreadyInitialized).toBe(false);
    expect(report.setupReady).toBe(true);
    expect(report.analysisReady).toBe(true);
    expect(report.verdict).toBe("READY");
    expect(report.nodes).toBeGreaterThan(0);
    expect(isInitialized(root)).toBe(true);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
  });

  it("is idempotent on a second run", () => {
    root = freshSample();
    const first = setupRepository(root);
    expect(first.kind).toBe("setup");
    const second = setupRepository(root);
    expect(second.kind).toBe("setup");
    if (second.kind !== "setup") return;
    expect(second.configWritten).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.semanticFilesCreated).toBe(0);
    expect(second.verdict).toBe("READY");
    expect(second.setupReady).toBe(true);
  });

  it("refuses polyglot against an existing v1 config without writing a v2 overwrite", () => {
    root = freshSample();
    saveConfig(root, createDefaultConfig(root));
    expect(isInitialized(root)).toBe(true);

    const report = setupRepository(root, { polyglot: true });
    expect(report.kind).toBe("setup_refused");
    if (report.kind !== "setup_refused") return;
    expect(report.reasonCode).toBe("CONFIG_INVALID");
    expect(report.verdict).toBe("REFUSED");
    expect(report.setupReady).toBe(false);
    expect(report.configVersion).toBe(1);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.reason).toMatch(/migrate/i);

    // Config still v1 — no silent upgrade.
    expect(loadConfig(root).version).toBe(1);
  });

  it("reports NOT_READY when selected v2 language is disabled", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-setup-not-ready-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");

    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: {
        ...base.languages,
        python: "off",
      },
    });

    const report = setupRepository(root);
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.verdict).toBe("NOT_READY");
  });
});
