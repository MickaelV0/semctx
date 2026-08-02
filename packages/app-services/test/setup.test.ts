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
import {
  SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS,
  SETUP_POLYGLOT_V1_REFUSE_REASON,
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  buildPolyglotRequiresConfigV2Report,
  evaluatePolyglotSetupPolicy,
  setupRepository,
  type SetupPhaseEvent,
  type SetupRepositoryReport,
  type SetupRefusedReport,
  type SetupResult,
} from "../src/setup";

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

function asSetup(report: SetupResult): SetupRepositoryReport {
  expect(report.kind).toBe("setup");
  return report as SetupRepositoryReport;
}

function asRefused(report: SetupResult): SetupRefusedReport {
  expect(report.kind).toBe("setup_refused");
  return report as SetupRefusedReport;
}

function coverageStatus(report: SetupRepositoryReport): string {
  const coverage = report.indexHealth.coverage as { status?: unknown };
  expect(typeof coverage?.status).toBe("string");
  return String(coverage.status);
}

function freshnessCanHigh(report: SetupRepositoryReport): boolean {
  const freshness = report.indexHealth.freshness as { canRunHighRiskControl?: unknown };
  expect(typeof freshness?.canRunHighRiskControl).toBe("boolean");
  return freshness.canRunHighRiskControl === true;
}

function bindingStatus(report: SetupRepositoryReport): string {
  const binding = report.indexHealth.binding as { status?: unknown };
  expect(typeof binding?.status).toBe("string");
  return String(binding.status);
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
    const report = asSetup(setupRepository(root, {
      now: "2026-08-01T12:00:00.000Z",
      onPhase: (event) => phases.push(event),
    }));
    expect(report.configWritten).toBe(true);
    expect(report.alreadyInitialized).toBe(false);
    expect(report.setupReady).toBe(true);
    expect(report.analysisReady).toBe(true);
    expect(report.verdict).toBe("SETUP_READY");
    expect(report.nodes).toBeGreaterThan(0);
    expect(report.semctxDir).toContain(".semctx");
    expect(coverageStatus(report)).toMatch(/^(complete|partial)$/);
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

  it("fail-closes SETUP_READY on unsealed v1 (no version short-circuit)", () => {
    // Multi-cause NOT_READY (UNSEALED + typically insufficient). Restoring
    // `config.version !== 2 || …` would flip this fixture to SETUP_READY.
    root = mkdtempSync(join(tmpdir(), "semctx-setup-v1-unsealed-"));
    cpSync(SAMPLE_REPO, root, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(report.selection.configVersion).toBe(1);
    expect(coverageStatus(report)).toBe("insufficient");
    expect(freshnessCanHigh(report)).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });

  it("fail-closes when only coverage is insufficient (sealed, high-risk freshness true)", () => {
    // Isolates the coverage conjunct: binding valid + canRunHighRiskControl true.
    root = mkdtempSync(join(tmpdir(), "semctx-setup-cov-only-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: { ...base.languages, python: "off" },
    });

    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(bindingStatus(report)).toBe("valid");
    expect(freshnessCanHigh(report)).toBe(true);
    expect(coverageStatus(report)).toBe("insufficient");
    expect(report.analysisReady).toBe(false);
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
  });

  it("is idempotent on a second run", () => {
    root = freshSample();
    asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    const second = asSetup(setupRepository(root, { now: "2026-08-01T12:00:01.000Z" }));
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

    const report = asRefused(setupRepository(root, { polyglot: true, now: "2026-08-01T12:00:00.000Z" }));
    expect(report.reasonCode).toBe("POLYGLOT_REQUIRES_CONFIG_V2");
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(report.setupReady).toBe(false);
    expect(report.configVersion).toBe(1);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.reason).toMatch(/migrate/i);
    expect(loadConfig(root).version).toBe(1);
    // setupRepository must surface the pure policy constructor payload (no local drift).
    expect(report).toEqual(buildPolyglotRequiresConfigV2Report(root, 1));
  });

  it("evaluatePolyglotSetupPolicy owns predicate + full refuse payload (pure, no I/O)", () => {
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: false,
      alreadyInitialized: true,
      configVersion: 1,
    })).toBeNull();
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: false,
      configVersion: 1,
    })).toBeNull();
    expect(evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: true,
      configVersion: 2,
    })).toBeNull();

    const refused = evaluatePolyglotSetupPolicy({
      repositoryRoot: "/tmp/r",
      polyglot: true,
      alreadyInitialized: true,
      configVersion: 1,
    });
    expect(refused).not.toBeNull();
    expect(refused).toEqual(buildPolyglotRequiresConfigV2Report("/tmp/r", 1));
    expect(refused!.reasonCode).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON_CODE);
    expect(refused!.reason).toBe(SETUP_POLYGLOT_V1_REFUSE_REASON);
    expect(refused!.nextSteps).toEqual([...SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS]);
    expect(refused!.verdict).toBe("SETUP_REFUSED");
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

    const report = asSetup(setupRepository(root, { now: "2026-08-01T12:00:00.000Z" }));
    expect(report.setupReady).toBe(false);
    expect(report.analysisReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
    expect(coverageStatus(report)).toBe("insufficient");
  });
});
