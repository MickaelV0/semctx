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
import { setupRepository, type SetupPhaseEvent } from "../src/setup";

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

/** Sample fixture with a git seal so analysis readiness is not UNSEALED/insufficient. */
function freshSample(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-setup-svc-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

describe("setupRepository (shared SSoT)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("bootstraps a fresh workspace to SETUP_READY", () => {
    root = freshSample();
    const phases: SetupPhaseEvent[] = [];
    const report = setupRepository(root, {
      now: "2026-08-01T12:00:00.000Z",
      onPhase: (event) => phases.push(event),
    });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.configWritten).toBe(true);
    expect(report.alreadyInitialized).toBe(false);
    expect(report.setupReady).toBe(true);
    expect(report.analysisReady).toBe(true);
    expect(report.verdict).toBe("SETUP_READY");
    expect(report.nodes).toBeGreaterThan(0);
    // Agent gate must not claim READY while coverage is insufficient (any config version).
    const coverage = report.indexHealth.coverage as { status?: string };
    expect(coverage.status).not.toBe("insufficient");
    expect(isInitialized(root)).toBe(true);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(phases.map((p) => p.phase)).toEqual([
      "config",
      "semantic",
      "index",
      "index",
      "check",
      "analysis",
    ]);
  });

  it("fail-closes SETUP_READY on v1 when coverage is insufficient (no v1 short-circuit)", () => {
    // No git seal → UNSEALED + insufficient on the default v1 path.
    root = mkdtempSync(join(tmpdir(), "semctx-setup-v1-insuff-"));
    cpSync(SAMPLE_REPO, root, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    const report = setupRepository(root, { now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.selection.configVersion).toBe(1);
    const coverage = report.indexHealth.coverage as { status?: string };
    expect(coverage.status).toBe("insufficient");
    expect(report.analysisReady).toBe(false);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });

  it("is idempotent on a second run", () => {
    root = freshSample();
    const first = setupRepository(root, { now: "2026-08-01T12:00:00.000Z" });
    expect(first.kind).toBe("setup");
    const second = setupRepository(root, { now: "2026-08-01T12:00:01.000Z" });
    expect(second.kind).toBe("setup");
    if (second.kind !== "setup") return;
    expect(second.configWritten).toBe(false);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.semanticFilesCreated).toBe(0);
    expect(second.verdict).toBe("SETUP_READY");
    expect(second.setupReady).toBe(true);
  });

  it("refuses polyglot against an existing v1 config without writing a v2 overwrite", () => {
    root = freshSample();
    saveConfig(root, createDefaultConfig(root));
    expect(isInitialized(root)).toBe(true);

    const report = setupRepository(root, { polyglot: true, now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup_refused");
    if (report.kind !== "setup_refused") return;
    expect(report.reasonCode).toBe("CONFIG_INVALID");
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(report.setupReady).toBe(false);
    expect(report.configVersion).toBe(1);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.reason).toMatch(/migrate/i);
    expect(loadConfig(root).version).toBe(1);
  });

  it("reports SETUP_NOT_READY when selected v2 language is disabled", () => {
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

    const report = setupRepository(root, { now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });
});
