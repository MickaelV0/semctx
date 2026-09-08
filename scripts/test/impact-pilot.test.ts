import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRelativeImportSpecifiers, oneHopImportNeighborhoodBaseline, type ImportGraphFile } from "../pilot/baselines";
import { runBounded, TIMED_OUT_EXIT_CODE } from "../pilot/child";
import {
  collectCases,
  parseVerifyReport,
  validateLocalSourcesFile,
  validateRawCollectionBundle,
  type RawCollectionBundleV1,
} from "../pilot/collect";
import { digestCanonical } from "../pilot/digest";
import {
  freezeProtocol,
  validateDraftProtocol,
  validateFrozenProtocol,
  type CorpusCaseSpec,
  type DraftProtocolInput,
  type FrozenProtocolV1,
  type LabelStatus,
} from "../pilot/protocol";
import { buildPublicSummary, buildResultReport, scoreTool } from "../pilot/report";
import { parseFlags } from "../pilot/cli-args";
import { writeJsonExclusive } from "../impact-pilot";

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

const HEX_BASE = "a".repeat(40);
function hexHead(i: number): string {
  const hex = i.toString(16);
  return `b${"0".repeat(39 - hex.length)}${hex}`;
}

// --- a stand-in candidate CLI: real subprocess, real git, canned analysis result ---
const STUB_CANDIDATE_SOURCE = `
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? args[rootFlag + 1] : process.env.SEMCTX_ROOT ?? process.cwd();
if (args[0] === "init") {
  mkdirSync(root + "/.semctx", { recursive: true });
  writeFileSync(root + "/.semctx/stub-marker", "initialized");
  if (process.env.SEMCTX_PILOT_TEST_MUTATE_SELF === "1") appendFileSync(import.meta.path, "\\n// mutated during collection\\n");
  process.exit(0);
}
if (args[0] === "index") process.exit(0);
if (args[0] === "verify" && args[1] === "diff") {
  const base = args[args.indexOf("--base") + 1];
  const head = args[args.indexOf("--head") + 1];
  const diff = Bun.spawnSync(["git", "diff", "--name-only", base, head], { cwd: root, stdout: "pipe" });
  const changedFiles = new TextDecoder().decode(diff.stdout).trim().split("\\n").filter(Boolean).sort();
  const blocks = changedFiles.includes("src/critical.ts");
  const report = {
    schemaVersion: 1, verdict: blocks ? "BLOCK" : "PASS", base, head, mergeBase: null, range: null,
    changedFiles, changedSymbols: [], impactedContracts: [], impactedInvariants: [],
    recommendedTests: [], contradictions: [], unknowns: [],
    findings: blocks ? [{
      rule: "fixture-block", tier: "strict", severity: "block", message: "fixture block", nodeIds: [], locations: [],
    }] : [],
    summary: { blockCount: blocks ? 1 : 0, warnCount: 0 },
  };
  console.log(JSON.stringify(report));
  process.exit(blocks ? 3 : 0);
}
process.exit(1);
`;

function makeFixtureRepoRoot(): string {
  const root = tempDir("semctx-pilot-fixture-repo-");
  mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
  mkdirSync(join(root, "scripts", "pilot"), { recursive: true });
  mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
  writeFileSync(join(root, "apps", "cli", "package.json"), JSON.stringify({ name: "semctx-fixture", version: "0.0.1" }));
  writeFileSync(join(root, "apps", "cli", "src", "index.ts"), STUB_CANDIDATE_SOURCE);
  writeFileSync(join(root, "scripts", "impact-pilot.ts"), "// fixture placeholder\n");
  writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0" }));
  writeFileSync(join(root, "node_modules", "typescript", "lib", "typescript.js"), "// fixture typescript runtime\n");
  return root;
}

function makeSourceRepo(): { cwd: string; base: string; head: string } {
  const cwd = tempDir("semctx-pilot-source-");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "pilot@example.invalid"]);
  git(cwd, ["config", "user.name", "pilot test"]);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, "src", "consumer.ts"), 'import { value } from "./critical";\nexport const doubled = value * 2;\n');
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "base"]);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "src", "critical.ts"), "export const value = 2;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "head"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, base, head };
}

function baseDraft(overrides: Partial<DraftProtocolInput["config"]> = {}): DraftProtocolInput["config"] {
  return {
    perCaseTimeoutMs: 30_000,
    baselines: ["changed-files", "one-hop-import-neighborhood"],
    selection: { rule: "manual", note: "fixture" },
    ...overrides,
  };
}

function makeCase(caseId: string, repositoryAlias: string, label: LabelStatus, extra: Partial<CorpusCaseSpec> = {}): CorpusCaseSpec {
  return {
    caseId,
    repositoryAlias,
    synthetic: false,
    publicSource: null,
    baseRef: HEX_BASE,
    headRef: hexHead(1),
    changedFiles: [],
    split: "dev",
    label,
    ...extra,
  };
}

/** Builds a syntactically valid frozen protocol without going through freeze()'s filesystem identity resolution. */
function makeFrozenProtocolFixture(corpus: FrozenProtocolV1["corpus"]): FrozenProtocolV1 {
  const withoutDigest = {
    schemaVersion: 1 as const,
    experimentId: "impact-pilot-test-fixture",
    createdAt: "2026-09-08T00:00:00.000Z",
    candidate: {
      packaging: "dist" as const,
      entryPath: "apps/cli/dist/index.js",
      entryDigest: `sha256:${"0".repeat(64)}`,
      packageName: "semctx",
      packageVersion: "0.0.0",
      bunVersion: "1.4.0",
      bunExecutableDigest: `sha256:${"2".repeat(64)}`,
      supportFiles: [],
    },
    runner: {
      entryPath: "scripts/impact-pilot.ts",
      entryDigest: `sha256:${"1".repeat(64)}`,
      toolSchemaVersion: 1 as const,
      supportFiles: [],
    },
    config: baseDraft(),
    corpus,
  };
  return { ...withoutDigest, digest: digestCanonical(withoutDigest) };
}

function researchCorpus(labels: readonly LabelStatus[], reposCount = 3): FrozenProtocolV1["corpus"] {
  const cases = labels.map((label, i) => makeCase(`case-${i}`, `repo-${i % reposCount}`, label, { headRef: hexHead(i + 1) }));
  return { kind: "research", cases };
}

// ============================================================================================
// draft / freeze structural validation
// ============================================================================================

describe("draft protocol structural validation", () => {
  test("accepts a minimal synthetic-smoke draft", () => {
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    expect(draft.corpus.cases).toHaveLength(1);
  });

  test("rejects a research corpus with fewer than 30 cases", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: researchCorpus(Array.from({ length: 5 }, () => ({ status: "UNKNOWN" }) as LabelStatus)),
      }),
    ).toThrow(/>= 30 cases/);
  });

  test("rejects a research corpus spanning fewer than 3 repositories", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus), 1),
      }),
    ).toThrow(/>= 3 distinct repositories/);
  });

  test("rejects a synthetic case inside a research corpus (invariant 2: synthetic never counts as real evidence)", () => {
    const corpus = researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus));
    (corpus.cases as CorpusCaseSpec[])[0]!.synthetic = true;
    expect(() =>
      validateDraftProtocol({ schemaVersion: 1, candidate: { packaging: "dist" }, config: baseDraft(), corpus }),
    ).toThrow(/is synthetic/);
  });

  test("rejects a non-synthetic case inside a synthetic-smoke corpus", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" })] },
      }),
    ).toThrow(/not marked synthetic/);
  });

  test("rejects duplicate caseIds", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: {
          kind: "synthetic-smoke",
          cases: [
            makeCase("dup", "repo-a", { status: "UNKNOWN" }, { synthetic: true }),
            makeCase("dup", "repo-b", { status: "UNKNOWN" }, { synthetic: true, headRef: hexHead(2) }),
          ],
        },
      }),
    ).toThrow(/duplicate caseId/);
  });

  test("rejects an unknown field (governed input, ADR 0019)", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: { kind: "synthetic-smoke", cases: [], extraField: true },
      }),
    ).toThrow(/unknown field/);
  });

  test("rejects a critical file absent from expectedImpactedFiles", () => {
    expect(() =>
      validateDraftProtocol({
        schemaVersion: 1,
        candidate: { packaging: "dist" },
        config: baseDraft(),
        corpus: {
          kind: "synthetic-smoke",
          cases: [
            makeCase("s-1", "repo-a", {
              status: "LABELLED",
              provenance: "automated-review",
              expectedImpactedFiles: ["a.ts"],
              criticalFiles: ["b.ts"],
            }, { synthetic: true }),
          ],
        },
      }),
    ).toThrow(/not also in expectedImpactedFiles/);
  });

  test("rejects source-dev packaging for research evidence", () => {
    expect(() => validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus)),
    })).toThrow(/research protocols require "dist"/);
  });
});

describe("strict CLI flags", () => {
  test("rejects unknown and duplicate options", () => {
    expect(() => parseFlags(["--unknown"], ["input"])).toThrow(/unknown option/);
    expect(() => parseFlags(["--input", "a", "--input", "b"], ["input"])).toThrow(/duplicate option/);
  });
});

describe("freeze: candidate/runner identity binding", () => {
  test("freezes and round-trips through validateFrozenProtocol", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const frozen = freezeProtocol(draft, repoRoot);
    expect(frozen.candidate.packageName).toBe("semctx-fixture");
    expect(frozen.candidate.entryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reparsed = validateFrozenProtocol(JSON.parse(JSON.stringify(frozen)));
    expect(reparsed.digest).toBe(frozen.digest);
  });

  test("refuses a frozen protocol whose digest was hand-edited after the fact", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const frozen = freezeProtocol(draft, repoRoot);
    const tampered = { ...frozen, config: { ...frozen.config, perCaseTimeoutMs: frozen.config.perCaseTimeoutMs + 1 } };
    expect(() => validateFrozenProtocol(tampered)).toThrow(/does not match recomputed/);
  });

  test("throws when packaging \"dist\" is requested but the build artifact is missing", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "dist" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    expect(() => freezeProtocol(draft, repoRoot)).toThrow(/not readable/);
  });

  test("binds every file in the built dist support tree", () => {
    const repoRoot = makeFixtureRepoRoot();
    mkdirSync(join(repoRoot, "apps", "cli", "dist", "typescript"), { recursive: true });
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "index.js"), "// bundled cli\n");
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "semctx-index-worker.js"), "// worker\n");
    writeFileSync(join(repoRoot, "apps", "cli", "dist", "typescript", "lib.d.ts"), "declare const x: number;\n");
    const frozen = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "dist" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    }), repoRoot);
    expect(frozen.candidate.supportFiles.map((file) => file.path)).toEqual([
      "apps/cli/dist/semctx-index-worker.js",
      "apps/cli/dist/typescript/lib.d.ts",
      "apps/cli/package.json",
    ]);
  });

  test("binds runner support-module changes into the frozen identity", () => {
    const repoRoot = makeFixtureRepoRoot();
    writeFileSync(join(repoRoot, "scripts", "pilot", "helper.ts"), "export const value = 1;\n");
    const frozen = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    }), repoRoot);
    expect(frozen.runner.supportFiles.map((file) => file.path)).toEqual([
      "node_modules/typescript/lib/typescript.js",
      "node_modules/typescript/package.json",
      "scripts/pilot/helper.ts",
    ]);
  });
});

// ============================================================================================
// collect(): real subprocess, real git, confinement
// ============================================================================================

describe("collect: real process observation and confinement", () => {
  test("observes a real case end to end and never mutates the source repository", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [
        makeCase(
          "case-1",
          "fixture-repo",
          { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["src/critical.ts"], criticalFiles: ["src/critical.ts"] },
          { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
        ),
      ],
    };
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus,
    });
    const protocol = freezeProtocol(draft, repoRoot);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } });
    const inheritedRoot = tempDir("semctx-pilot-inherited-root-");
    process.env.SEMCTX_ROOT = inheritedRoot;
    process.env.GIT_EXTERNAL_DIFF = "definitely-not-a-command";

    const createdDirs: string[] = [];
    const bundle = collectCases(protocol, sources, repoRoot, {
      mkTempDir: (prefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        createdDirs.push(dir);
        return dir;
      },
    });

    expect(bundle.cases).toHaveLength(1);
    const observed = bundle.cases[0]!;
    expect(observed.status).toBe("OBSERVED");
    expect(observed.changedFiles).toEqual(["src/critical.ts"]);
    expect(observed.semctx?.verify.exitCode).toBe(3); // BLOCK, recorded rather than hidden
    expect(observed.semctx?.verificationStatus).toBe("TRUSTED");
    expect(observed.semctx?.init.argv).toContain("--root");
    expect(observed.semctx?.verdict).toBe("BLOCK");
    expect(observed.semctx?.suggestedFiles).toEqual(["src/critical.ts"]);
    expect(observed.baselineChangedFiles?.suggestedFiles).toEqual(["src/critical.ts"]);
    expect(observed.baselineImportNeighborhood?.suggestedFiles).toContain("src/consumer.ts");

    // confinement: the disposable workspace is gone, and the source repository is untouched.
    expect(createdDirs.length).toBeGreaterThan(0);
    for (const dir of createdDirs) expect(existsSync(dir)).toBe(false);
    expect(git(source.cwd, ["status", "--porcelain"])).toBe("");
    expect(git(source.cwd, ["rev-parse", "HEAD"])).toBe(source.head);
    expect(existsSync(join(source.cwd, ".semctx"))).toBe(false);
    expect(existsSync(join(inheritedRoot, ".semctx"))).toBe(false);
    delete process.env.SEMCTX_ROOT;
    delete process.env.GIT_EXTERNAL_DIFF;
  }, 60_000);

  test("rejects a candidate artifact that changes during collection", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["src/critical.ts"] },
      )] },
    });
    const protocol = freezeProtocol(draft, repoRoot);
    process.env.SEMCTX_PILOT_TEST_MUTATE_SELF = "1";
    try {
      expect(() => collectCases(
        protocol,
        validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }),
        repoRoot,
      )).toThrow(/candidate CLI on disk no longer matches/);
    } finally {
      delete process.env.SEMCTX_PILOT_TEST_MUTATE_SELF;
    }
  }, 60_000);

  test("records a frozen changedFiles mismatch as missing evidence before running the candidate", () => {
    const repoRoot = makeFixtureRepoRoot();
    const source = makeSourceRepo();
    const protocol = freezeProtocol(validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase(
        "case-1", "fixture-repo", { status: "UNKNOWN" },
        { synthetic: true, baseRef: source.base, headRef: source.head, changedFiles: ["wrong.ts"] },
      )] },
    }), repoRoot);
    const bundle = collectCases(protocol, validateLocalSourcesFile({ schemaVersion: 1, paths: { "case-1": source.cwd } }), repoRoot);
    expect(bundle.cases[0]?.status).toBe("FAILED");
    expect(bundle.cases[0]?.failureReason).toMatch(/does not match changedFiles/);
  }, 60_000);

  test("records a FAILED case (not a thrown error) when the source path does not exist", () => {
    const repoRoot = makeFixtureRepoRoot();
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("missing-1", "fixture-repo", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const draft = validateDraftProtocol({ schemaVersion: 1, candidate: { packaging: "source-dev" }, config: baseDraft(), corpus });
    const protocol = freezeProtocol(draft, repoRoot);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: {} });

    const bundle = collectCases(protocol, sources, repoRoot);
    expect(bundle.cases[0]?.status).toBe("FAILED");
    expect(bundle.cases[0]?.failureReason).toMatch(/no local source path/);
  });

  test("refuses to collect once the on-disk candidate no longer matches the frozen identity", () => {
    const repoRoot = makeFixtureRepoRoot();
    const draft = validateDraftProtocol({
      schemaVersion: 1,
      candidate: { packaging: "source-dev" },
      config: baseDraft(),
      corpus: { kind: "synthetic-smoke", cases: [makeCase("s-1", "repo-fixture", { status: "UNKNOWN" }, { synthetic: true })] },
    });
    const protocol = freezeProtocol(draft, repoRoot);
    writeFileSync(join(repoRoot, "apps", "cli", "src", "index.ts"), `${STUB_CANDIDATE_SOURCE}\n// mutated after freeze\n`);
    const sources = validateLocalSourcesFile({ schemaVersion: 1, paths: {} });
    expect(() => collectCases(protocol, sources, repoRoot)).toThrow(/no longer matches the frozen protocol identity/);
  });
});

// ============================================================================================
// scoring: no fake effectiveness
// ============================================================================================

function makeObservation(
  caseId: string,
  suggested: readonly string[] | null,
  spec?: CorpusCaseSpec,
): RawCollectionBundleV1["cases"][number] {
  if (suggested === null) {
    return { caseId, status: "FAILED", failureReason: "infra failure", changedFiles: [], semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null };
  }
  return {
    caseId,
    status: "OBSERVED",
    failureReason: null,
    changedFiles: [...(spec?.changedFiles ?? [])],
    semctx: {
      init: { argv: ["bun"], exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "" },
      index: { argv: ["bun"], exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "" },
      verify: {
        argv: ["bun"],
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: JSON.stringify({
          schemaVersion: 1,
          verdict: "PASS",
          base: spec?.baseRef ?? HEX_BASE,
          head: spec?.headRef ?? hexHead(1),
          mergeBase: null,
          range: null,
          changedFiles: spec?.changedFiles ?? [],
          changedSymbols: [],
          impactedContracts: [],
          impactedInvariants: [],
          recommendedTests: [],
          contradictions: [],
          unknowns: [],
          findings: [],
          impactedConsumers: [{
            symbol: { id: "sym:source", name: "source", kind: "function" },
            consumers: suggested.map((file, index) => ({ id: `sym:consumer:${index}`, name: `consumer${index}`, kind: "function", file })),
          }],
          summary: { blockCount: 0, warnCount: 0 },
        }),
        stderr: "",
      },
      verdict: "PASS",
      verificationStatus: "TRUSTED",
      suggestedFiles: [...suggested],
    },
    baselineChangedFiles: { suggestedFiles: [], durationMs: 1 },
    baselineImportNeighborhood: { suggestedFiles: [], durationMs: 1 },
  };
}

describe("scoreTool: a no-op analyzer must not pass as a positive witness", () => {
  test("an empty suggestion set scores zero, not a perfect score, on a known-positive case", () => {
    const corpus = new Map([
      ["known-positive", makeCase("known-positive", "repo-a", {
        status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
      })],
    ]);
    const noOp = scoreTool("semctx", [makeObservation("known-positive", [])], corpus);
    expect(noOp.precision).toBe(0);
    expect(noOp.recall).toBe(0);
    expect(noOp.criticalRecall).toBe(0);

    const correct = scoreTool("semctx", [makeObservation("known-positive", ["a.ts"])], corpus);
    expect(correct.precision).toBe(1);
    expect(correct.recall).toBe(1);
    expect(correct.criticalRecall).toBe(1);
  });

  test("UNKNOWN-labelled cases are excluded from scoring, never treated as negatives", () => {
    const corpus = new Map<string, CorpusCaseSpec>([
      ["labelled", makeCase("labelled", "repo-a", { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] })],
      ["unknown", makeCase("unknown", "repo-a", { status: "UNKNOWN" })],
    ]);
    const score = scoreTool("semctx", [makeObservation("labelled", ["a.ts"]), makeObservation("unknown", [])], corpus);
    expect(score.labelledCasesScored).toBe(1);
    expect(score.precision).toBe(1);
  });
});

describe("buildResultReport: verdict ladder", () => {
  test("EVIDENCE_MISSING when the corpus is synthetic-smoke, regardless of scores", () => {
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", ["a.ts"], corpus.cases[0])],
    };
    const report = buildResultReport(protocol, raw);
    expect(report.evidenceKind).toBe("smoke");
    expect(report.verdict).toBe("EVIDENCE_MISSING");
  });

  test("EVIDENCE_MISSING on a research corpus with zero labelled cases", () => {
    const corpus = researchCorpus(Array.from({ length: 30 }, () => ({ status: "UNKNOWN" }) as LabelStatus));
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, [], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("EVIDENCE_MISSING");
  });

  test("INCONCLUSIVE when fewer than 30 cases are actually labelled", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, (_, i) =>
      i < 10 ? { status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [] } : { status: "UNKNOWN" },
    );
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, ["a.ts"], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("INCONCLUSIVE");
  });

  test("POSITIVE when 30+ labelled cases are perfectly matched", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, ["a.ts"], c)),
    };
    const report = buildResultReport(protocol, raw);
    expect(report.verdict).toBe("POSITIVE");
    expect(report.scores?.find((s) => s.tool === "semctx")?.precision).toBe(1);
  });

  test("NEGATIVE when 30+ labelled cases exist but the candidate never suggests anything", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: ["a.ts"],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: corpus.cases.map((c) => makeObservation(c.caseId, [], c)),
    };
    expect(buildResultReport(protocol, raw).verdict).toBe("NEGATIVE");
  });
});

// ============================================================================================
// identity / completeness
// ============================================================================================

describe("report identity and completeness gates", () => {
  function fixture(): { protocol: FrozenProtocolV1; raw: RawCollectionBundleV1 } {
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("s-1", [], corpus.cases[0])],
    };
    return { protocol, raw };
  }

  test("rejects a raw bundle whose protocolDigest does not match the frozen protocol", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, protocolDigest: `sha256:${"9".repeat(64)}` })).toThrow(/protocolDigest/);
  });

  test("rejects a raw bundle missing a registered case", () => {
    const { protocol } = fixture();
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases: [],
    };
    expect(() => buildResultReport(protocol, raw)).toThrow(/missing case/);
  });

  test("rejects a raw bundle with a case not in the frozen protocol", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, cases: [...raw.cases, makeObservation("not-registered", [])] })).toThrow(
      /not registered/,
    );
  });

  test("validateRawCollectionBundle rejects duplicate caseIds before identity checks even run", () => {
    const observation = makeObservation("dup", []);
    expect(() => validateRawCollectionBundle({
      schemaVersion: 1, experimentId: "e", protocolDigest: `sha256:${"0".repeat(64)}`,
      collectedAt: "now", observedBunVersion: "1.4.0", cases: [observation, observation],
    })).toThrow(/duplicate caseId/);
  });

  test("rejects a raw bundle produced by a different Bun runtime", () => {
    const { protocol, raw } = fixture();
    expect(() => buildResultReport(protocol, { ...raw, observedBunVersion: "0.0.0" })).toThrow(/observedBunVersion/);
  });

  test("an infrastructure failure produces no score and EVIDENCE_MISSING", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const cases = corpus.cases.map((c, index): RawCollectionBundleV1["cases"][number] => index === 0
      ? { caseId: c.caseId, status: "FAILED", failureReason: "local clone failed", changedFiles: [], semctx: null,
        baselineChangedFiles: null, baselineImportNeighborhood: null }
      : makeObservation(c.caseId, ["a.ts"], c));
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases,
    });
    expect(report.verdict).toBe("EVIDENCE_MISSING");
    expect(report.scores).toBeNull();
    expect(report.totals.failedCases).toBe(1);
    expect(report.totals.untrustedCases).toBe(0);
  });

  test("one observed untrusted case prevents a labelled research corpus from scoring", () => {
    const labels: LabelStatus[] = Array.from({ length: 30 }, () => ({
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["a.ts"], criticalFiles: [],
    }));
    const corpus = researchCorpus(labels);
    const protocol = makeFrozenProtocolFixture(corpus);
    const cases = corpus.cases.map((spec, index) => {
      const observation = makeObservation(spec.caseId, ["a.ts"], spec);
      if (index === 0 && observation.semctx !== null) {
        observation.semctx.verificationStatus = "DIFF_MISMATCH";
        observation.semctx.verdict = null;
        observation.semctx.suggestedFiles = [];
      }
      return observation;
    });
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases,
    });
    expect(report.verdict).toBe("EVIDENCE_MISSING");
    expect(report.scores).toBeNull();
    expect(report.totals).toMatchObject({ observedCases: 30, failedCases: 0, untrustedCases: 1 });
    expect(buildPublicSummary(protocol, report).totals.untrustedCases).toBe(1);
  });
});

// ============================================================================================
// process truth
// ============================================================================================

describe("validateRawCollectionBundle: process truth", () => {
  const base = {
    schemaVersion: 1 as const, experimentId: "e", protocolDigest: `sha256:${"0".repeat(64)}`,
    collectedAt: "now", observedBunVersion: "1.4.0",
  };

  test("rejects a boolean exit code", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verify: { exitCode: unknown } }).verify.exitCode = true;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/expected a finite number/);
  });

  test("rejects a non-finite duration", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verify: { durationMs: unknown } }).verify.durationMs = Number.POSITIVE_INFINITY;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/finite/);
  });

  test("rejects a malformed verdict value", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    (observation.semctx as unknown as { verdict: unknown }).verdict = "MAYBE";
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/PASS \| WARN \| BLOCK/);
  });

  test("rejects an OBSERVED case missing its semctx run", () => {
    const observation = { ...makeObservation("c-1", ["a.ts"]), semctx: undefined };
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow();
  });

  test("rejects incoherent timeout and unknown raw fields", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.semctx !== null) observation.semctx.verify.timedOut = true;
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/timedOut/);
    expect(() => validateRawCollectionBundle({ ...base, cases: [makeObservation("c-1", [] )], extra: true })).toThrow(/unknown field/);
  });

  test("rejects an untrusted status that still claims a PASS verdict", () => {
    const observation = makeObservation("c-1", ["a.ts"]);
    if (observation.semctx !== null) observation.semctx.verificationStatus = "EXIT_MISMATCH";
    expect(() => validateRawCollectionBundle({ ...base, cases: [observation] })).toThrow(/untrusted verification/);
  });
});

describe("verify output trust", () => {
  const expected = { baseRef: HEX_BASE, headRef: hexHead(1), changedFiles: ["a.ts"] };
  const report = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    schemaVersion: 1,
    verdict: "PASS",
    base: HEX_BASE,
    head: hexHead(1),
    mergeBase: null,
    range: `${HEX_BASE}..${hexHead(1)}`,
    changedFiles: ["a.ts"],
    changedSymbols: [],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings: [],
    summary: { blockCount: 0, warnCount: 0 },
    ...overrides,
  });

  test("trusts only a bound report whose verdict agrees with the process exit", () => {
    expect(parseVerifyReport(report(), 0, expected).verificationStatus).toBe("TRUSTED");
    expect(parseVerifyReport(report(), 3, expected)).toMatchObject({ verdict: null, verificationStatus: "EXIT_MISMATCH" });
    expect(parseVerifyReport(report({ changedFiles: ["other.ts"] }), 0, expected)).toMatchObject({
      verdict: null,
      verificationStatus: "DIFF_MISMATCH",
    });
    expect(parseVerifyReport("not-json", 0, expected)).toMatchObject({ verdict: null, verificationStatus: "MALFORMED_OUTPUT" });
  });

  test("rejects incomplete, contradictory, and unconfined verify reports", () => {
    const incomplete = JSON.stringify({
      schemaVersion: 1, verdict: "PASS", base: HEX_BASE, head: hexHead(1), changedFiles: ["a.ts"],
    });
    expect(parseVerifyReport(incomplete, 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
    expect(parseVerifyReport(report({
      summary: { blockCount: 1, warnCount: 0 },
      findings: [{
        rule: "contradiction", tier: "strict", severity: "block", message: "blocked", nodeIds: [], locations: [],
      }],
    }), 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
    expect(parseVerifyReport(report({
      impactedConsumers: [{
        symbol: { id: "sym:source", name: "source", kind: "function", file: "a.ts" },
        consumers: [{ id: "sym:consumer", name: "consumer", kind: "function", file: "../../private/secret.ts" }],
      }],
    }), 0, expected).verificationStatus).toBe("MALFORMED_OUTPUT");
  });
});

describe("local source and output path safety", () => {
  test("preserves __proto__ as an own local source key without prototype mutation", () => {
    const value = validateLocalSourcesFile(JSON.parse(
      '{"schemaVersion":1,"paths":{"__proto__":"C:/private/repo","normal":"C:/normal"}}',
    ));
    expect(Object.getPrototypeOf(value.paths)).toBeNull();
    expect(Object.hasOwn(value.paths, "__proto__")).toBe(true);
    expect(value.paths["__proto__"]).toBe("C:/private/repo");
  });

  test("refuses exclusive output through a symlink or junction ancestor", () => {
    const parent = tempDir("semctx-pilot-output-parent-");
    const outside = tempDir("semctx-pilot-output-outside-");
    const linked = join(parent, "linked");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => writeJsonExclusive(join(linked, "public.json"), { safe: true })).toThrow(/symbolic link|junction/);
    expect(existsSync(join(outside, "public.json"))).toBe(false);
  });
});

// ============================================================================================
// privacy: public export allowlist
// ============================================================================================

describe("buildPublicSummary: privacy allowlist", () => {
  test("never leaks failure-reason free text, stdout/stderr, or local paths", () => {
    const secret = "sk-fake-secret-DO-NOT-LEAK";
    const leakyPath = "C:\\Users\\hoklims\\private-repo";
    const corpus: FrozenProtocolV1["corpus"] = {
      kind: "synthetic-smoke",
      cases: [makeCase("s-1", "repo-a", { status: "UNKNOWN" }, { synthetic: true })],
    };
    const protocol = makeFrozenProtocolFixture(corpus);
    const failedCase: RawCollectionBundleV1["cases"][number] = {
      caseId: "s-1", status: "FAILED", failureReason: `git clone failed: ${secret} at ${leakyPath}`,
      changedFiles: [], semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null,
    };
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0", cases: [failedCase],
    };
    const report = buildResultReport(protocol, raw);
    expect(JSON.stringify(report)).toContain(secret); // present in the private report, by design

    const publicSummary = buildPublicSummary(protocol, report);
    const serialized = JSON.stringify(publicSummary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(leakyPath);
    expect(serialized).not.toContain("failureReason");
    expect(serialized).not.toContain("repo-a");
    expect(serialized).toContain("private-repository-1");
  });

  test("includes critical-miss file paths only for cases with a declared public source", () => {
    const publicCase = makeCase("public-1", "repo-public", {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["public.ts"], criticalFiles: ["public.ts"],
    }, { synthetic: true, publicSource: { url: "https://example.invalid/public", license: "MIT" } });
    const privateCase = makeCase("private-1", "repo-private", {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["private.ts"], criticalFiles: ["private.ts"],
    }, { synthetic: true, headRef: hexHead(2) });
    const corpus: FrozenProtocolV1["corpus"] = { kind: "synthetic-smoke", cases: [publicCase, privateCase] };
    const protocol = makeFrozenProtocolFixture(corpus);
    const raw: RawCollectionBundleV1 = {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("public-1", [], publicCase), makeObservation("private-1", [], privateCase)],
    };
    const report = buildResultReport(protocol, raw);
    expect(report.criticalMisses.map((m) => m.caseId).sort()).toEqual(["private-1", "public-1"]);

    const publicSummary = buildPublicSummary(protocol, report);
    expect(publicSummary.criticalMisses.map((m) => m.caseId)).toEqual(["public-1"]);
  });

  test("masks an alias conservatively when any case using it is private", () => {
    const alias = "secret-owner/secret-repo";
    const publicCase = makeCase("public-1", alias, {
      status: "LABELLED", provenance: "automated-review", expectedImpactedFiles: ["public.ts"], criticalFiles: ["public.ts"],
    }, { synthetic: true, publicSource: { url: "https://example.invalid/public", license: "MIT" } });
    const privateCase = makeCase("private-1", alias, { status: "UNKNOWN" }, { synthetic: true, headRef: hexHead(2) });
    const corpus: FrozenProtocolV1["corpus"] = { kind: "synthetic-smoke", cases: [publicCase, privateCase] };
    const protocol = makeFrozenProtocolFixture(corpus);
    const report = buildResultReport(protocol, {
      schemaVersion: 1, experimentId: protocol.experimentId, protocolDigest: protocol.digest,
      collectedAt: "2026-09-08T00:00:00.000Z", observedBunVersion: "1.4.0",
      cases: [makeObservation("public-1", [], publicCase), makeObservation("private-1", [], privateCase)],
    });
    const serialized = JSON.stringify(buildPublicSummary(protocol, report));
    expect(serialized).not.toContain(alias);
    expect(serialized).toContain("private-repository-1");
    expect(JSON.parse(serialized).criticalMisses).toEqual([]);
  });
});

// ============================================================================================
// bounded subprocess execution
// ============================================================================================

describe("runBounded", () => {
  test("captures a real process exit code and finite timing", () => {
    const result = runBounded(["git", "--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.stdout).toContain("git version");
  });

  test("kills a slow child at the timeout and reports it truthfully, never as a normal exit", () => {
    const result = runBounded([process.execPath, "-e", "await new Promise((r) => setTimeout(r, 5000));"], {
      cwd: process.cwd(),
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMED_OUT_EXIT_CODE);
  });
});

// ============================================================================================
// baselines
// ============================================================================================

describe("baselines", () => {
  test("extractRelativeImportSpecifiers keeps only relative specifiers", () => {
    const source = `
      import { a } from "./a";
      import "./b";
      export * from "../c";
      import fs from "node:fs";
      const load = async () => import("./d");
    `;
    const specifiers = extractRelativeImportSpecifiers(source, "file.ts");
    expect(specifiers.sort()).toEqual(["../c", "./a", "./b", "./d"]);
  });

  test("one-hop neighborhood includes importers and imports of changed files, excluding the changed files themselves", () => {
    const root = tempDir("semctx-pilot-baseline-");
    const files: ImportGraphFile[] = [
      { relativePath: "changed.ts", absolutePath: join(root, "changed.ts") },
      { relativePath: "importer.ts", absolutePath: join(root, "importer.ts") },
      { relativePath: "imported.ts", absolutePath: join(root, "imported.ts") },
      { relativePath: "unrelated.ts", absolutePath: join(root, "unrelated.ts") },
    ];
    writeFileSync(files[0]!.absolutePath, 'import { x } from "./imported";\nexport const y = x;\n');
    writeFileSync(files[1]!.absolutePath, 'import { y } from "./changed";\nexport const z = y;\n');
    writeFileSync(files[2]!.absolutePath, "export const x = 1;\n");
    writeFileSync(files[3]!.absolutePath, "export const w = 1;\n");

    const neighborhood = oneHopImportNeighborhoodBaseline(root, ["changed.ts"], files);
    expect(neighborhood.sort()).toEqual(["imported.ts", "importer.ts"]);
  });
});
