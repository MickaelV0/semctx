/**
 * Build the strict public projection consumed by the static evidence page (ADR 0023).
 * Raw demo and pilot files may contain local paths, logs and aliases; this module copies only
 * closed enums, validated identities and aggregate counts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PRECISION_THRESHOLD } from "./pilot/report";
import { RESEARCH_MINIMUM_CASES } from "./pilot/protocol";

export const PUBLIC_EVIDENCE_KIND = "semctx-public-evidence-v1" as const;
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = 1 as const;

const CASES = {
  benign: { fixturePath: "src/greeting.ts", expectedFinding: "none" },
  "exported-contract-risk": { fixturePath: "src/cart.ts", expectedFinding: "warn" },
  "unsupported-limit": { fixturePath: "src/pricing.ts", expectedFinding: "none" },
} as const;
const CASE_IDS = Object.keys(CASES) as DemoCaseId[];
const RULE_SEVERITIES = {
  invariant_touched_without_test: "block",
  critical_contract_changed_without_test: "block",
  contract_changed_without_test: "warn",
  contradiction_unresolved: "warn",
  security_surface_without_verification: "block",
  analysis_scope_incomplete: "block",
  index_binding_stale: "block",
} as const;
const KNOWN_RULES = new Set(Object.keys(RULE_SEVERITIES));
const PILOT_TOOLS = ["semctx", "changed-files", "one-hop-import-neighborhood"] as const;

export type DemoCaseId = keyof typeof CASES;
export type PublicPhase = "candidate" | "release";
export type DemoStatus = "COMPLETED" | "BLOCKED";
export type Verdict = "PASS" | "WARN" | "BLOCK";
export type PilotVerdict = "EVIDENCE_MISSING" | "INCONCLUSIVE" | "NEGATIVE" | "POSITIVE";

export interface PublicDemoCaseV1 {
  id: DemoCaseId;
  fixturePath: (typeof CASES)[DemoCaseId]["fixturePath"];
  expectedFinding: "none" | "warn";
  observedRuleIds: string[];
  matchedExpectation: boolean;
}

export interface PublicDemoEvidenceV1 {
  status: DemoStatus;
  observedAt: string;
  packageVersion: string | null;
  runtimeDigest: string | null;
  fixtureBaseDigest: string;
  fixtureChangedDigest: string;
  fixtureCommit: { value: string; authority: "caller-asserted" } | null;
  verdict: Verdict | null;
  unknownCount: number;
  cases: PublicDemoCaseV1[];
}

export interface PublicPilotEvidenceV1 {
  evidenceKind: "research" | "smoke";
  verdict: PilotVerdict;
  protocolDigest: string;
  totalCases: number;
  observedCases: number;
  failedCases: number;
  untrustedCases: number;
  labelledCases: number;
  unknownCases: number;
  repositoryCount: number;
  totalDurationMs: number;
  scores: null | Array<{
    tool: (typeof PILOT_TOOLS)[number];
    labelledCasesScored: number;
    precision: number;
    recall: number;
    criticalRecall: number;
  }>;
  generatedAt: string;
}

export interface PublicEvidenceV1 {
  schemaVersion: typeof PUBLIC_EVIDENCE_SCHEMA_VERSION;
  kind: typeof PUBLIC_EVIDENCE_KIND;
  phase: PublicPhase;
  generatedAt: string;
  evidenceState: "NOT_OBSERVED" | "OBSERVED";
  releaseCommit: { value: string; authority: "caller-asserted" } | null;
  demo: PublicDemoEvidenceV1 | null;
  pilot: PublicPilotEvidenceV1 | null;
  humanMetrics: {
    adoption: "NOT_MEASURED";
    retention: "NOT_MEASURED";
    contributionTime: "NOT_MEASURED";
  };
  disclosures: {
    scope: "Semctx reports structural impact and declared contract risk. It does not prove runtime or business correctness.";
    measurement: "Automated evidence does not measure adoption, retention, or contribution time.";
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value as T[number];
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

function finiteRatio(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite ratio from 0 to 1`);
  }
  return value;
}

function isoDate(value: unknown, name: string): string {
  const result = string(value, name);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be a valid date`);
  return new Date(timestamp).toISOString();
}

function digest(value: unknown, name: string): string {
  const result = string(value, name);
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(result);
  if (match === null) throw new Error(`${name} must be a SHA-256 digest`);
  return `sha256:${match[1]}`;
}

function semver(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(result)) {
    throw new Error(`${name} must be a semantic version`);
  }
  return result;
}

function gitCommit(value: string | undefined, name: string): { value: string; authority: "caller-asserted" } | null {
  if (value === undefined) return null;
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full lowercase Git commit`);
  return { value, authority: "caller-asserted" };
}

function projectDemo(raw: unknown, assertedCommit?: string): PublicDemoEvidenceV1 {
  const manifest = record(raw, "demo manifest");
  if (manifest["kind"] !== "semctx-first-use-demo-manifest-v1") throw new Error("demo manifest kind is invalid");
  const status = enumValue(manifest["status"], ["COMPLETED", "BLOCKED"] as const, "demo.status");
  const fixture = record(manifest["fixture"], "demo.fixture");
  const cli = record(manifest["cli"], "demo.cli");
  const unknowns = manifest["unknowns"];
  if (!Array.isArray(unknowns)) throw new Error("demo.unknowns must be an array");
  const inputCases = manifest["cases"];
  if (!Array.isArray(inputCases)) throw new Error("demo.cases must be an array");

  const cases = inputCases.map((value, index): PublicDemoCaseV1 => {
    const item = record(value, `demo.cases[${index}]`);
    const id = enumValue(item["id"], CASE_IDS, `demo.cases[${index}].id`);
    const expected = CASES[id];
    if (item["relPath"] !== expected.fixturePath || item["expectedFinding"] !== expected.expectedFinding) {
      throw new Error(`demo case ${id} does not match the frozen fixture contract`);
    }
    if (typeof item["matchedExpectation"] !== "boolean") throw new Error(`demo case ${id} match flag is invalid`);
    const observedRules = item["observedRules"];
    if (!Array.isArray(observedRules) || !observedRules.every(rule => typeof rule === "string" && KNOWN_RULES.has(rule))) {
      throw new Error(`demo case ${id} contains an unknown rule identifier`);
    }
    const observedRuleIds: string[] = [];
    for (const rule of observedRules as unknown[]) observedRuleIds.push(string(rule, `demo case ${id} rule`));
    const matchedExpectation = expected.expectedFinding === "none"
      ? observedRuleIds.length === 0
      : observedRuleIds.includes("contract_changed_without_test");
    if (item["matchedExpectation"] !== matchedExpectation) {
      throw new Error(`demo case ${id} match flag contradicts its observed rules`);
    }
    return {
      id,
      fixturePath: expected.fixturePath,
      expectedFinding: expected.expectedFinding,
      observedRuleIds,
      matchedExpectation,
    };
  });
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error("demo cases contain duplicate IDs");

  const fixtureBaseDigest = digest(fixture["baseDigest"], "demo.fixture.baseDigest");
  const fixtureChangedDigest = digest(fixture["changedDigest"], "demo.fixture.changedDigest");
  if (status === "COMPLETED") {
    if (cases.length !== CASE_IDS.length || CASE_IDS.some(id => !cases.some(item => item.id === id))) {
      throw new Error("completed demo must contain all three frozen cases");
    }
    if (cases.some(item => !item.matchedExpectation)) {
      throw new Error("completed demo requires every frozen case expectation to match");
    }
    if (manifest["reason"] !== null) throw new Error("completed demo cannot have a block reason");
  } else if (cases.length !== 0 || manifest["verdict"] !== null) {
    throw new Error("blocked demo cannot publish case outcomes or a verdict");
  }

  const packageVersion = manifest["packageVersion"] === null ? null : semver(manifest["packageVersion"], "demo.packageVersion");
  const runtimeDigest = cli["runtimeDigest"] === null ? null : digest(cli["runtimeDigest"], "demo.cli.runtimeDigest");
  const verdict = manifest["verdict"] === null ? null : enumValue(manifest["verdict"], ["PASS", "WARN", "BLOCK"] as const, "demo.verdict");
  const observedFixtureCommit = gitCommit(
    typeof manifest["fixtureHeadCommit"] === "string" ? manifest["fixtureHeadCommit"] : undefined,
    "demo observed fixture commit",
  );
  if (status === "COMPLETED" && (packageVersion === null || runtimeDigest === null || observedFixtureCommit === null || verdict === null)) {
    throw new Error("completed demo requires version, runtime digest, observed fixture commit and verdict");
  }
  if (status === "COMPLETED") {
    const severities = cases.flatMap(item => item.observedRuleIds.map(rule => RULE_SEVERITIES[rule as keyof typeof RULE_SEVERITIES]));
    const expectedVerdict: Verdict = severities.includes("block") ? "BLOCK" : severities.includes("warn") ? "WARN" : "PASS";
    if (verdict !== expectedVerdict) throw new Error("demo global verdict contradicts its observed rule severities");
  }
  return {
    status,
    observedAt: isoDate(manifest["createdAt"], "demo.createdAt"),
    packageVersion,
    runtimeDigest,
    fixtureBaseDigest,
    fixtureChangedDigest,
    fixtureCommit: assertedCommit === undefined
      ? observedFixtureCommit
      : gitCommit(assertedCommit, "demo fixture commit"),
    verdict,
    unknownCount: unknowns.length,
    cases,
  };
}

function projectPilot(raw: unknown): PublicPilotEvidenceV1 {
  const summary = record(raw, "pilot summary");
  if (summary["schemaVersion"] !== 1) throw new Error("pilot schema version is invalid");
  const evidenceKind = enumValue(summary["evidenceKind"], ["research", "smoke"] as const, "pilot.evidenceKind");
  const verdict = enumValue(summary["verdict"], ["EVIDENCE_MISSING", "INCONCLUSIVE", "NEGATIVE", "POSITIVE"] as const, "pilot.verdict");
  const totals = record(summary["totals"], "pilot.totals");
  const totalCases = integer(totals["totalCases"], "pilot.totals.totalCases");
  const observedCases = integer(totals["observedCases"], "pilot.totals.observedCases");
  const failedCases = integer(totals["failedCases"], "pilot.totals.failedCases");
  const untrustedCases = integer(totals["untrustedCases"], "pilot.totals.untrustedCases");
  const labelledCases = integer(totals["labelledCases"], "pilot.totals.labelledCases");
  const unknownCases = integer(totals["unknownCases"], "pilot.totals.unknownCases");
  if (observedCases + failedCases !== totalCases || labelledCases + unknownCases !== totalCases || untrustedCases > observedCases) {
    throw new Error("pilot totals are inconsistent");
  }
  if (evidenceKind === "smoke" || failedCases > 0 || untrustedCases > 0 || labelledCases === 0) {
    if (verdict !== "EVIDENCE_MISSING") throw new Error("pilot verdict overstates the available evidence");
  } else if (labelledCases < RESEARCH_MINIMUM_CASES) {
    if (verdict !== "INCONCLUSIVE") throw new Error("pilot verdict overstates the labelled evidence");
  } else if (verdict !== "POSITIVE" && verdict !== "NEGATIVE") {
    throw new Error("pilot verdict understates a fully labelled research result");
  }

  if (!Array.isArray(summary["perRepository"])) throw new Error("pilot.perRepository must be an array");
  const repositoryTotals = summary["perRepository"].map((value, index) => {
    const item = record(value, `pilot.perRepository[${index}]`);
    const alias = string(item["repositoryAlias"], `pilot.perRepository[${index}].repositoryAlias`);
    const total = integer(item["totalCases"], `pilot.perRepository[${index}].totalCases`);
    const observed = integer(item["observedCases"], `pilot.perRepository[${index}].observedCases`);
    const failed = integer(item["failedCases"], `pilot.perRepository[${index}].failedCases`);
    const untrusted = integer(item["untrustedCases"], `pilot.perRepository[${index}].untrustedCases`);
    const labelled = integer(item["labelledCases"], `pilot.perRepository[${index}].labelledCases`);
    if (observed + failed !== total || labelled > total || untrusted > observed) throw new Error(`pilot repository totals at ${index} are inconsistent`);
    return { alias, total, observed, failed, untrusted, labelled };
  });
  if (new Set(repositoryTotals.map(item => item.alias)).size !== repositoryTotals.length) {
    throw new Error("pilot repository aliases must be unique");
  }
  const sum = (key: "total" | "observed" | "failed" | "untrusted" | "labelled"): number =>
    repositoryTotals.reduce((total, item) => total + item[key], 0);
  if (sum("total") !== totalCases || sum("observed") !== observedCases || sum("failed") !== failedCases || sum("labelled") !== labelledCases || sum("untrusted") !== untrustedCases) {
    throw new Error("pilot repository aggregates do not match global totals");
  }
  if (evidenceKind === "research" && (totalCases < RESEARCH_MINIMUM_CASES || repositoryTotals.length < 3)) {
    throw new Error(`research pilot evidence requires at least ${RESEARCH_MINIMUM_CASES} cases across at least 3 repositories`);
  }

  let scores: PublicPilotEvidenceV1["scores"] = null;
  if (summary["scores"] !== null) {
    if (labelledCases === 0 || failedCases > 0 || untrustedCases > 0) throw new Error("pilot scores require observed adjudicated cases");
    if (!Array.isArray(summary["scores"]) || summary["scores"].length !== PILOT_TOOLS.length) throw new Error("pilot scores are incomplete");
    scores = summary["scores"].map((value, index) => {
      const score = record(value, `pilot.scores[${index}]`);
      const labelledCasesScored = integer(score["labelledCasesScored"], `pilot.scores[${index}].labelledCasesScored`);
      if (labelledCasesScored !== labelledCases) throw new Error(`pilot.scores[${index}] does not cover every labelled case`);
      return {
        tool: enumValue(score["tool"], PILOT_TOOLS, `pilot.scores[${index}].tool`),
        labelledCasesScored,
        precision: finiteRatio(score["precision"], `pilot.scores[${index}].precision`),
        recall: finiteRatio(score["recall"], `pilot.scores[${index}].recall`),
        criticalRecall: finiteRatio(score["criticalRecall"], `pilot.scores[${index}].criticalRecall`),
      };
    });
    if (new Set(scores.map(score => score.tool)).size !== PILOT_TOOLS.length) throw new Error("pilot scores contain duplicate tools");
    if (evidenceKind === "research" && labelledCases >= RESEARCH_MINIMUM_CASES) {
      const semctx = scores.find(score => score.tool === "semctx")!;
      const baselineCriticalRecall = Math.max(...scores.filter(score => score.tool !== "semctx").map(score => score.criticalRecall));
      const expected = semctx.precision >= PRECISION_THRESHOLD && semctx.criticalRecall >= baselineCriticalRecall ? "POSITIVE" : "NEGATIVE";
      if (verdict !== expected) throw new Error("pilot verdict contradicts the reported scores");
    }
  } else if (failedCases === 0 && untrustedCases === 0 && labelledCases > 0) {
    throw new Error("pilot scores are missing for observed adjudicated cases");
  }

  if (!Array.isArray(summary["criticalMisses"])) throw new Error("pilot.criticalMisses must be an array");

  return {
    evidenceKind,
    verdict,
    protocolDigest: digest(summary["protocolDigest"], "pilot.protocolDigest"),
    totalCases,
    observedCases,
    failedCases,
    untrustedCases,
    labelledCases,
    unknownCases,
    repositoryCount: repositoryTotals.length,
    totalDurationMs: finiteNonNegative(summary["totalDurationMs"], "pilot.totalDurationMs"),
    scores,
    generatedAt: isoDate(summary["generatedAt"], "pilot.generatedAt"),
  };
}

export function buildPublicEvidence(input: {
  phase: PublicPhase;
  demo?: object;
  pilot?: object;
  releaseCommit?: string;
  demoFixtureCommit?: string;
  now?: () => string;
}): PublicEvidenceV1 {
  const phase = enumValue(input.phase, ["candidate", "release"] as const, "phase");
  if (input.now !== undefined && typeof input.now !== "function") throw new Error("now must be a function");
  const demo = input.demo === undefined ? null : projectDemo(input.demo, input.demoFixtureCommit);
  const pilot = input.pilot === undefined ? null : projectPilot(input.pilot);
  if (phase === "release" && demo?.status !== "COMPLETED") {
    throw new Error("release evidence requires a completed packaged demo");
  }
  const generatedAt = isoDate((input.now ?? (() => new Date().toISOString()))(), "generatedAt");
  return {
    schemaVersion: PUBLIC_EVIDENCE_SCHEMA_VERSION,
    kind: PUBLIC_EVIDENCE_KIND,
    phase,
    generatedAt,
    evidenceState: demo === null && pilot === null ? "NOT_OBSERVED" : "OBSERVED",
    releaseCommit: gitCommit(input.releaseCommit, "release commit"),
    demo,
    pilot,
    humanMetrics: { adoption: "NOT_MEASURED", retention: "NOT_MEASURED", contributionTime: "NOT_MEASURED" },
    disclosures: {
      scope: "Semctx reports structural impact and declared contract risk. It does not prove runtime or business correctness.",
      measurement: "Automated evidence does not measure adoption, retention, or contribution time.",
    },
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function readJson(path: string | undefined): object | undefined {
  if (path === undefined) return undefined;
  const value: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (typeof value !== "object" || value === null) throw new Error("input JSON must contain an object");
  return value;
}

export function runBuildPublicDemo(args: readonly string[]): void {
  const allowed = new Set(["--phase", "--output", "--demo", "--pilot", "--commit", "--fixture-commit"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    if (!allowed.has(name) || seen.has(name) || args[index + 1] === undefined || args[index + 1]!.startsWith("--")) {
      throw new Error(`unknown, duplicate or incomplete argument: ${name}`);
    }
    seen.add(name);
  }
  const phase = enumValue(flag(args, "phase"), ["candidate", "release"] as const, "--phase");
  const output = resolve(flag(args, "output") ?? "site/evidence.json");
  const evidence = buildPublicEvidence({
    phase,
    demo: readJson(flag(args, "demo")),
    pilot: readJson(flag(args, "pilot")),
    releaseCommit: flag(args, "commit"),
    demoFixtureCommit: flag(args, "fixture-commit"),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (import.meta.main) runBuildPublicDemo(process.argv.slice(2));
