/**
 * Build the strict public projection consumed by the static evidence page (ADR 0023).
 * Raw demo and pilot files may contain local paths, logs and aliases; this module copies only
 * closed enums, validated identities and aggregate counts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256Hex } from "./first-use-demo/identity";
import { PRECISION_THRESHOLD } from "./pilot/report";
import { RESEARCH_MINIMUM_CASES } from "./pilot/protocol";

export const PUBLIC_EVIDENCE_KIND = "semctx-public-evidence-v1" as const;
export const PUBLIC_EVIDENCE_SCHEMA_VERSION = 1 as const;

const CASES = {
  benign: { fixturePath: "src/greeting.ts", expectedFinding: "none", expectedRuleIds: [] },
  "exported-contract-risk": {
    fixturePath: "src/cart.ts",
    expectedFinding: "warn",
    expectedRuleIds: ["contract_changed_without_test"],
  },
  "unsupported-limit": { fixturePath: "src/pricing.ts", expectedFinding: "none", expectedRuleIds: [] },
} as const;
const CASE_IDS = Object.keys(CASES) as DemoCaseId[];
const KNOWN_RULES = new Set([
  "invariant_touched_without_test",
  "critical_contract_changed_without_test",
  "contract_changed_without_test",
  "contradiction_unresolved",
  "security_surface_without_verification",
  "analysis_scope_incomplete",
  "index_binding_stale",
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PILOT_TOOLS = ["semctx", "changed-files", "one-hop-import-neighborhood"] as const;
const DEMO_BLOCK_REASONS = [
  "CLI_ARTIFACT_MISSING", "ARTIFACT_DRIFT", "INVALID_OUTPUT_PATH", "INDEX_CHILD_FAILED",
  "OUTPUT_EXISTS_NOT_EMPTY", "FIXTURE_GIT_INIT_FAILED", "FIXTURE_GIT_IDENTITY_FAILED",
  "SETUP_CHILD_FAILED", "SETUP_OUTPUT_MALFORMED", "SETUP_NOT_READY",
  "VERIFY_CHILD_UNEXPECTED_EXIT", "VERIFY_OUTPUT_MALFORMED", "VERIFY_OUTPUT_INCOMPLETE",
  "UNEXPECTED_ANALYSIS", "FIXTURE_DRIFT",
] as const;
const DEMO_COMMAND_LABELS = ["version", "setup", "index", "verify-diff"] as const;

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
  if (!SEMVER.test(result)) {
    throw new Error(`${name} must be a semantic version`);
  }
  return result;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return string(value, name);
}

function rawDigest(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${name} must be a raw SHA-256 digest`);
  return result;
}

function pathTail(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)!;
}

interface ValidatedFileIdentity {
  path: string;
  present: boolean;
  sizeBytes: number | null;
  sha256: string | null;
}

function fileIdentity(value: unknown, name: string): ValidatedFileIdentity {
  const item = record(value, name);
  const path = string(item["path"], `${name}.path`);
  if (path.length === 0) throw new Error(`${name}.path must not be empty`);
  const present = boolean(item["present"], `${name}.present`);
  const sizeBytes = item["sizeBytes"] === null ? null : integer(item["sizeBytes"], `${name}.sizeBytes`);
  const sha256 = item["sha256"] === null ? null : rawDigest(item["sha256"], `${name}.sha256`);
  if ((present && (sizeBytes === null || sha256 === null)) || (!present && (sizeBytes !== null || sha256 !== null))) {
    throw new Error(`${name} presence metadata is inconsistent`);
  }
  return { path, present, sizeBytes, sha256 };
}

function validateCliIdentity(value: unknown, status: DemoStatus): { runtimeDigest: string | null; cliPath: string } {
  const cli = record(value, "demo.cli");
  const cliPath = string(cli["cliPath"], "demo.cli.cliPath");
  if (cliPath.length === 0) throw new Error("demo.cli.cliPath must not be empty");
  const entry = fileIdentity(cli["cli"], "demo.cli.cli");
  if (entry.path !== cliPath) throw new Error("demo CLI entry path contradicts cliPath");
  const worker = cli["indexWorker"] === null ? null : fileIdentity(cli["indexWorker"], "demo.cli.indexWorker");
  if (worker !== null && !worker.present) throw new Error("demo.cli.indexWorker must be present or null");
  if (string(cli["sourceProvenance"], "demo.cli.sourceProvenance").length === 0) throw new Error("demo.cli.sourceProvenance must not be empty");
  if (cli["authenticatedSource"] !== "UNKNOWN") throw new Error("demo.cli.authenticatedSource is invalid");
  if (!Array.isArray(cli["runtimeFiles"])) throw new Error("demo.cli.runtimeFiles must be an array");
  const runtimeFiles = cli["runtimeFiles"].map((item, index) => fileIdentity(item, `demo.cli.runtimeFiles[${index}]`));
  if (new Set(runtimeFiles.map(item => item.path)).size !== runtimeFiles.length) throw new Error("demo CLI runtime file paths must be unique");
  if (runtimeFiles.some(item => !item.present)) throw new Error("demo CLI runtime files must be present");
  const runtimeDigest = cli["runtimeDigest"] === null ? null : rawDigest(cli["runtimeDigest"], "demo.cli.runtimeDigest");
  if (!entry.present) {
    if (runtimeFiles.length !== 0 || runtimeDigest !== null) throw new Error("missing demo CLI cannot carry runtime files or a runtime digest");
  } else {
    if (runtimeFiles.length === 0 || runtimeDigest === null) throw new Error("present demo CLI requires runtime files and a runtime digest");
    if (sha256Hex(JSON.stringify(runtimeFiles)) !== runtimeDigest) throw new Error("demo CLI runtime digest contradicts its runtime files");
    const entryFile = runtimeFiles.find(item => item.path === pathTail(cliPath));
    if (entryFile === undefined || entryFile.sizeBytes !== entry.sizeBytes || entryFile.sha256 !== entry.sha256) {
      throw new Error("demo CLI entry is not bound to its runtime file set");
    }
    if (worker?.present) {
      const workerFile = runtimeFiles.find(item => item.path === pathTail(worker.path));
      if (workerFile === undefined || workerFile.sizeBytes !== worker.sizeBytes || workerFile.sha256 !== worker.sha256) {
        throw new Error("demo index worker is not bound to its runtime file set");
      }
    }
  }
  if (status === "COMPLETED" && !entry.present) {
    throw new Error("completed demo requires the packaged CLI identity");
  }
  return { runtimeDigest: runtimeDigest === null ? null : `sha256:${runtimeDigest}`, cliPath };
}

function validateDemoCommands(value: unknown, status: DemoStatus, cliPath: string): number {
  if (!Array.isArray(value)) throw new Error("demo.commands must be an array");
  if (status === "COMPLETED" && value.length !== DEMO_COMMAND_LABELS.length) {
    throw new Error("completed demo requires all four command observations");
  }
  if (value.length > DEMO_COMMAND_LABELS.length) throw new Error("demo.commands contains an unexpected command");
  let bunExecutable: string | undefined;
  let fixtureRoot: string | undefined;
  value.forEach((raw, index) => {
    const name = `demo.commands[${index}]`;
    const item = record(raw, name);
    const label = enumValue(item["label"], DEMO_COMMAND_LABELS, `${name}.label`);
    if (label !== DEMO_COMMAND_LABELS[index]) throw new Error("demo commands must follow the runner stage order");
    if (!Array.isArray(item["argv"]) || !item["argv"].every(arg => typeof arg === "string" && arg.length > 0)) {
      throw new Error(`${name}.argv must contain non-empty strings`);
    }
    const argv = item["argv"] as string[];
    bunExecutable ??= argv[0];
    if (argv[0] !== bunExecutable || argv[1] !== cliPath) throw new Error("demo commands must use the same Bun executable and packaged CLI entry");
    if (label === "version") {
      if (JSON.stringify(argv.slice(2)) !== JSON.stringify(["--version"])) throw new Error("demo version argv is invalid");
    } else {
      const expected = label === "verify-diff" ? ["verify", "diff", "--root"] : [label, "--root"];
      const rootIndex = 2 + expected.length;
      fixtureRoot ??= argv[rootIndex];
      if (JSON.stringify(argv.slice(2, rootIndex)) !== JSON.stringify(expected)
        || argv[rootIndex] !== fixtureRoot || argv[rootIndex + 1] !== "--json" || argv.length !== rootIndex + 2) {
        throw new Error(`demo ${label} argv is invalid`);
      }
    }
    const code = item["code"];
    if (code !== null && (!Number.isSafeInteger(code) || Number(code) < 0)) throw new Error(`${name}.code is invalid`);
    const signal = nullableString(item["signal"], `${name}.signal`);
    finiteNonNegative(item["durationMs"], `${name}.durationMs`);
    const pathPrefix = `raw/${label}`;
    if (string(item["stdoutFile"], `${name}.stdoutFile`).replaceAll("\\", "/") !== `${pathPrefix}.stdout.txt`
      || string(item["stderrFile"], `${name}.stderrFile`).replaceAll("\\", "/") !== `${pathPrefix}.stderr.txt`) {
      throw new Error(`${name} capture filenames are invalid`);
    }
    rawDigest(item["stdoutDigest"], `${name}.stdoutDigest`);
    rawDigest(item["stderrDigest"], `${name}.stderrDigest`);
    if (status === "COMPLETED" && (code !== 0 || signal !== null)) throw new Error("completed demo commands must exit successfully without a signal");
  });
  return value.length;
}

interface ValidatedFinding {
  rule: string;
  tier: "strict" | "advisory";
  severity: "warn" | "block";
}

function validateFindings(value: unknown, name: string): ValidatedFinding[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  value.forEach((raw, index) => {
    const findingName = `${name}[${index}]`;
    const finding = record(raw, findingName);
    if (string(finding["rule"], `${findingName}.rule`).length === 0) throw new Error(`${findingName}.rule must not be empty`);
    enumValue(finding["tier"], ["strict", "advisory"] as const, `${findingName}.tier`);
    enumValue(finding["severity"], ["warn", "block"] as const, `${findingName}.severity`);
    string(finding["message"], `${findingName}.message`);
    if (!Array.isArray(finding["nodeIds"]) || !finding["nodeIds"].every(item => typeof item === "string")) {
      throw new Error(`${findingName}.nodeIds must contain strings`);
    }
    if (!Array.isArray(finding["locations"])) throw new Error(`${findingName}.locations must be an array`);
    finding["locations"].forEach((rawLocation, locationIndex) => {
      const locationName = `${findingName}.locations[${locationIndex}]`;
      const location = record(rawLocation, locationName);
      string(location["file"], `${locationName}.file`);
      if (location["line"] !== undefined && (typeof location["line"] !== "number" || !Number.isFinite(location["line"]))) {
        throw new Error(`${locationName}.line must be a finite number`);
      }
    });
  });
  return value.map(raw => {
    const finding = raw as Record<string, unknown>;
    return {
      rule: finding["rule"] as string,
      tier: finding["tier"] as ValidatedFinding["tier"],
      severity: finding["severity"] as ValidatedFinding["severity"],
    };
  });
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
  if (string(manifest["outDir"], "demo.outDir").length === 0) throw new Error("demo.outDir must not be empty");
  const fixture = record(manifest["fixture"], "demo.fixture");
  const cliIdentity = validateCliIdentity(manifest["cli"], status);
  const commandCount = validateDemoCommands(manifest["commands"], status, cliIdentity.cliPath);
  const unassignedFindings = validateFindings(manifest["unassignedFindings"] ?? [], "demo.unassignedFindings");
  const unknowns = manifest["unknowns"];
  if (!Array.isArray(unknowns)) throw new Error("demo.unknowns must be an array");
  if (!unknowns.every(item => typeof item === "string")) throw new Error("demo.unknowns must contain strings");
  const inputCases = manifest["cases"];
  if (!Array.isArray(inputCases)) throw new Error("demo.cases must be an array");

  const cases = inputCases.map((value, index): PublicDemoCaseV1 => {
    const item = record(value, `demo.cases[${index}]`);
    const id = enumValue(item["id"], CASE_IDS, `demo.cases[${index}].id`);
    const expected = CASES[id];
    string(item["title"], `demo.cases[${index}].title`);
    string(item["explanation"], `demo.cases[${index}].explanation`);
    string(item["nextCheck"], `demo.cases[${index}].nextCheck`);
    const observedFindings = validateFindings(item["observedFindings"], `demo.cases[${index}].observedFindings`);
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
    const findingRules = observedFindings.map(finding => finding.rule).sort();
    if (JSON.stringify(observedRuleIds) !== JSON.stringify(findingRules)) {
      throw new Error(`demo case ${id} observed rules contradict its findings`);
    }
    const matchedExpectation = expected.expectedFinding === "none"
      ? observedFindings.length === 0
      : observedFindings.length === 1
        && observedFindings[0]!.rule === "contract_changed_without_test"
        && observedFindings[0]!.tier === "advisory"
        && observedFindings[0]!.severity === "warn";
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
    if (unassignedFindings.length !== 0) throw new Error("completed demo cannot contain unassigned findings");
    if (manifest["reason"] !== null || manifest["detail"] !== null) throw new Error("completed demo cannot have block details");
  } else {
    enumValue(manifest["reason"], DEMO_BLOCK_REASONS, "demo.reason");
    if (string(manifest["detail"], "demo.detail").length === 0) throw new Error("blocked demo detail must not be empty");
    if (cases.length !== 0 && (cases.length !== CASE_IDS.length || CASE_IDS.some(id => !cases.some(item => item.id === id)))) {
      throw new Error("blocked demo observations must contain all three frozen cases");
    }
  }

  const packageVersion = manifest["packageVersion"] === null ? null : semver(manifest["packageVersion"], "demo.packageVersion");
  const runtimeDigest = cliIdentity.runtimeDigest;
  const verdict = manifest["verdict"] === null ? null : enumValue(manifest["verdict"], ["PASS", "WARN", "BLOCK"] as const, "demo.verdict");
  const observedFixtureCommit = gitCommit(
    typeof manifest["fixtureHeadCommit"] === "string" ? manifest["fixtureHeadCommit"] : undefined,
    "demo observed fixture commit",
  );
  if (status === "COMPLETED" && (packageVersion === null || runtimeDigest === null || observedFixtureCommit === null || verdict === null)) {
    throw new Error("completed demo requires version, runtime digest, observed fixture commit and verdict");
  }
  if (status === "COMPLETED") {
    if (verdict !== "WARN") throw new Error("demo global verdict contradicts the frozen WARN expectation");
    digest(manifest["workingDiffDigest"], "demo.workingDiffDigest");
  } else {
    const hasObservations = cases.length > 0;
    if (hasObservations !== (verdict !== null) || hasObservations !== (packageVersion !== null)
      || hasObservations !== (manifest["workingDiffDigest"] !== null)
      || (hasObservations && (observedFixtureCommit === null || runtimeDigest === null || commandCount !== DEMO_COMMAND_LABELS.length))
      || (!hasObservations && unassignedFindings.length > 0)) {
      throw new Error("blocked demo observation fields are inconsistent");
    }
    if (manifest["workingDiffDigest"] !== null) digest(manifest["workingDiffDigest"], "demo.workingDiffDigest");
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
