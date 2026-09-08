import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublicEvidence, runBuildPublicDemo } from "../build-public-demo";
import { FIXTURE_CASES } from "../first-use-demo/fixture";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-public-demo-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("unknown, duplicate and incomplete CLI arguments fail before output", () => {
  for (const args of [
    ["--phase", "candidate", "--ouput", "unintended.json"],
    ["--phase", "candidate", "--phase", "release"],
    ["--phase", "candidate", "--demo"],
  ]) expect(() => runBuildPublicDemo(args)).toThrow("unknown, duplicate or incomplete argument");
});

function demoManifest(): Record<string, unknown> {
  return {
    kind: "semctx-first-use-demo-manifest-v1",
    status: "COMPLETED",
    reason: null,
    detail: "C:\\private\\TOP_SECRET",
    createdAt: "2026-09-08T01:00:00.000Z",
    outDir: "C:\\private\\demo",
    cli: {
      cliPath: "C:\\private\\semctx.js",
      runtimeDigest: SHA,
      sourceProvenance: "secret local alias",
      runtimeFiles: [{ path: "private.js", sha256: SHA }],
    },
    fixture: { baseDigest: SHA, changedDigest: "c".repeat(64) },
    fixtureHeadCommit: COMMIT,
    commands: [{ stdoutFile: "raw/TOP_SECRET.txt", stderrFile: "raw/private.txt" }],
    verdict: "WARN",
    cases: [
      { id: "benign", relPath: "src/greeting.ts", expectedFinding: "none", observedRules: [], matchedExpectation: true, explanation: "secret", nextCheck: "secret" },
      { id: "exported-contract-risk", relPath: "src/cart.ts", expectedFinding: "warn", observedRules: ["contract_changed_without_test"], matchedExpectation: true, explanation: "secret", nextCheck: "secret" },
      { id: "unsupported-limit", relPath: "src/pricing.ts", expectedFinding: "none", observedRules: [], matchedExpectation: true, explanation: "secret", nextCheck: "secret" },
    ],
    unknowns: ["TOP_SECRET unknown text"],
    workingDiffDigest: SHA,
    packageVersion: "0.2.0",
  };
}

function pilotSummary(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    experimentId: "private-experiment",
    protocolDigest: `sha256:${SHA}`,
    evidenceKind: "research",
    verdict: "EVIDENCE_MISSING",
    totals: { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 0, unknownCases: 30 },
    perRepository: [
      { repositoryAlias: "C:\\private\\one", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
      { repositoryAlias: "TOP_SECRET", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
      { repositoryAlias: "private-repository-3", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
    ],
    scores: null,
    criticalMisses: [{ caseId: "private", repositoryAlias: "TOP_SECRET", files: ["private/path.ts"] }],
    totalDurationMs: 1234.5,
    generatedAt: "2026-09-08T02:00:00.000Z",
  };
}

describe("public evidence projection", () => {
  test("missing evidence remains explicit and all human metrics stay unmeasured", () => {
    const result = buildPublicEvidence({ phase: "candidate", now: () => "2026-09-08T00:00:00.000Z" });
    expect(result.evidenceState).toBe("NOT_OBSERVED");
    expect(result.demo).toBeNull();
    expect(result.pilot).toBeNull();
    expect(new Set(Object.values(result.humanMetrics))).toEqual(new Set(["NOT_MEASURED"]));
  });

  test("raw paths, logs, free text, aliases and unknown labels cannot reach public JSON", () => {
    const result = buildPublicEvidence({
      phase: "candidate",
      demo: demoManifest(),
      pilot: pilotSummary(),
      releaseCommit: COMMIT,
      now: () => "2026-09-08T03:00:00.000Z",
    });
    const serialized = JSON.stringify(result);
    expect(result.demo?.unknownCount).toBe(1);
    expect(result.pilot?.scores).toBeNull();
    expect(result.pilot?.repositoryCount).toBe(3);
    expect(serialized).not.toContain("TOP_SECRET");
    expect(serialized).not.toContain("private-experiment");
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("cliPath");
    expect(result.releaseCommit).toEqual({ value: COMMIT, authority: "caller-asserted" });
  });

  test("malformed demo structure and unknown rule IDs fail closed", () => {
    const missingCase = demoManifest();
    missingCase["cases"] = (missingCase["cases"] as unknown[]).slice(0, 2);
    expect(() => buildPublicEvidence({ phase: "candidate", demo: missingCase })).toThrow("all three frozen cases");
    const unknownRule = demoManifest();
    ((unknownRule["cases"] as Record<string, unknown>[])[0]!["observedRules"] as string[]).push("private-custom-rule");
    expect(() => buildPublicEvidence({ phase: "candidate", demo: unknownRule })).toThrow("unknown rule identifier");
    const falseMatch = demoManifest();
    (falseMatch["cases"] as Record<string, unknown>[])[0]!["matchedExpectation"] = false;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: falseMatch })).toThrow("match flag contradicts");
  });

  test("inconsistent pilot counts and scores without adjudicated labels fail closed", () => {
    const inconsistent = pilotSummary();
    (inconsistent["totals"] as Record<string, unknown>)["observedCases"] = 29;
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: inconsistent })).toThrow("totals are inconsistent");
    const scoredUnknown = pilotSummary();
    scoredUnknown["scores"] = [
      { tool: "semctx", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "changed-files", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "one-hop-import-neighborhood", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
    ];
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: scoredUnknown })).toThrow("observed adjudicated cases");
  });

  test("fractional durations and labelled-subset scores match PublicSummaryV1", () => {
    const labelled = pilotSummary();
    labelled["verdict"] = "INCONCLUSIVE";
    labelled["totals"] = { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 5, unknownCases: 25 };
    const repositories = labelled["perRepository"] as Record<string, unknown>[];
    repositories[0]!["labelledCases"] = 2;
    repositories[1]!["labelledCases"] = 2;
    repositories[2]!["labelledCases"] = 1;
    labelled["scores"] = [
      { tool: "semctx", labelledCasesScored: 5, precision: 0.8, recall: 0.75, criticalRecall: 1 },
      { tool: "changed-files", labelledCasesScored: 5, precision: 0.6, recall: 0.5, criticalRecall: 0.8 },
      { tool: "one-hop-import-neighborhood", labelledCasesScored: 5, precision: 0.7, recall: 0.65, criticalRecall: 0.8 },
    ];
    const result = buildPublicEvidence({ phase: "candidate", pilot: labelled });
    expect(result.pilot?.totalDurationMs).toBe(1234.5);
    expect(result.pilot?.scores?.map(score => score.tool)).toEqual(["semctx", "changed-files", "one-hop-import-neighborhood"]);
    labelled["totals"] = { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 30, unknownCases: 0 };
    for (const repository of repositories) repository["labelledCases"] = 10;
    for (const score of labelled["scores"] as Record<string, unknown>[]) score["labelledCasesScored"] = 30;
    labelled["verdict"] = "NEGATIVE";
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: labelled })).toThrow("contradicts the reported scores");
    labelled["verdict"] = "POSITIVE";
    expect(buildPublicEvidence({ phase: "candidate", pilot: labelled }).pilot?.verdict).toBe("POSITIVE");
  });

  test("an untrusted observed report remains visible and cannot carry scores", () => {
    const pilot = pilotSummary();
    (pilot["totals"] as Record<string, unknown>)["untrustedCases"] = 1;
    (pilot["perRepository"] as Record<string, unknown>[])[0]!["untrustedCases"] = 1;
    expect(buildPublicEvidence({ phase: "candidate", pilot }).pilot?.untrustedCases).toBe(1);
    pilot["verdict"] = "POSITIVE";
    expect(() => buildPublicEvidence({ phase: "candidate", pilot })).toThrow("overstates");
  });

  test("parseable date text is normalized and privacy suffixes never survive", () => {
    const demo = demoManifest();
    demo["createdAt"] = "Tue, 08 Sep 2026 01:00:00 GMT (TOP_SECRET)";
    const pilot = pilotSummary();
    pilot["generatedAt"] = "Tue, 08 Sep 2026 02:00:00 GMT (TOP_SECRET)";
    const result = buildPublicEvidence({
      phase: "candidate",
      demo,
      pilot,
      now: () => "Tue, 08 Sep 2026 03:00:00 GMT (TOP_SECRET)",
    });
    expect(result.demo?.observedAt).toBe("2026-09-08T01:00:00.000Z");
    expect(result.pilot?.generatedAt).toBe("2026-09-08T02:00:00.000Z");
    expect(result.generatedAt).toBe("2026-09-08T03:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
  });

  test("runtime phase and clock inputs fail closed", () => {
    expect(() => buildPublicEvidence({ phase: "future" as "candidate" })).toThrow("phase is invalid");
    expect(() => buildPublicEvidence({ phase: "candidate", now: "not-a-clock" as unknown as () => string })).toThrow("now must be a function");
    expect(() => buildPublicEvidence({ phase: "candidate", now: () => "not-a-date" })).toThrow("generatedAt must be a valid date");
  });

  test("release phase requires completed packaged evidence", () => {
    expect(() => buildPublicEvidence({ phase: "release", pilot: pilotSummary() })).toThrow("completed packaged demo");
  });

  test("CLI builder writes the same strict projection to the requested output", () => {
    const root = temporaryRoot();
    const demo = join(root, "demo.json");
    const pilot = join(root, "pilot.json");
    const output = join(root, "site", "evidence.json");
    writeFileSync(demo, JSON.stringify(demoManifest()));
    writeFileSync(pilot, JSON.stringify(pilotSummary()));
    runBuildPublicDemo(["--phase", "candidate", "--demo", demo, "--pilot", pilot, "--output", output]);
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.kind).toBe("semctx-public-evidence-v1");
    expect(result.demo.cases).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
  });
});

describe("static page contract", () => {
  test("published fixture sources match the executed demo and compile", () => {
    const repository = join(import.meta.dir, "..", "..");
    for (const item of FIXTURE_CASES) {
      for (const phase of ["base", "changed"] as const) {
        const publicSource = readFileSync(join(repository, "site", "fixtures", phase, item.file.relPath), "utf8");
        expect(publicSource.replaceAll("\r\n", "\n")).toBe(item.file[phase]);
      }
    }
    const checked = Bun.spawnSync([process.execPath, "node_modules/typescript/bin/tsc", "-p", "site/fixtures/tsconfig.json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(checked.exitCode, new TextDecoder().decode(checked.stdout) + new TextDecoder().decode(checked.stderr)).toBe(0);
  });
  test("assets are local, links are local or the fixed repository, and the page has fallback evidence copy", () => {
    const siteRoot = join(import.meta.dir, "..", "..", "site");
    const html = readFileSync(join(siteRoot, "index.html"), "utf8");
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]!);
    expect(references.every(value => value.startsWith("./") || value.startsWith("#") || value === "https://github.com/hoklims/semctx" || value === "https://hoklims.github.io/semctx/demo/")).toBe(true);
    expect(html).toContain("Evidence has not been generated for this candidate.");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toContain("analytics");
    expect(readFileSync(join(siteRoot, "styles.css"), "utf8")).not.toContain("transition: all");
  });
});
