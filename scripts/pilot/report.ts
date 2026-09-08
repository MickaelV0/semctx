import type { CorpusCaseSpec, FrozenProtocolV1 } from "./protocol";
import { RESEARCH_MINIMUM_CASES, verifyFrozenProtocolDigest } from "./protocol";
import {
  baselineInputDigest,
  baselineOutputDigest,
  parseVerifyReport,
  toolOutputDigest,
  type BaselineCaseRun,
  type CaseObservation,
  type RawCollectionBundleV1,
} from "./collect";
import { PilotValidationError } from "./validate-helpers";

export const PRECISION_THRESHOLD = 0.8;
export type PilotTool = "semctx" | "changed-files" | "one-hop-import-neighborhood";
export const PILOT_TOOLS: readonly PilotTool[] = ["semctx", "changed-files", "one-hop-import-neighborhood"];
export type PilotVerdict = "EVIDENCE_MISSING" | "INCONCLUSIVE" | "NEGATIVE" | "POSITIVE";

function validateBaselineIdentity(
  observation: CaseObservation,
  baseline: BaselineCaseRun,
  expectedAlgorithm: BaselineCaseRun["algorithm"],
  path: string,
): void {
  if (observation.git === null) throw new PilotValidationError(path, "requires a captured Git identity");
  if (baseline.algorithm !== expectedAlgorithm) {
    throw new PilotValidationError(`${path}.algorithm`, `must be ${expectedAlgorithm}`);
  }
  if (JSON.stringify(baseline.suggestedFiles) !== JSON.stringify([...new Set(baseline.suggestedFiles)].sort())) {
    throw new PilotValidationError(`${path}.suggestedFiles`, "must be sorted and contain no duplicates");
  }
  const expectedInput = baselineInputDigest(baseline.algorithm, observation.git, observation.changedFiles);
  if (baseline.inputDigest !== expectedInput) {
    throw new PilotValidationError(`${path}.inputDigest`, "does not bind the captured Git identity and changed files");
  }
  const expectedOutput = baselineOutputDigest(baseline.algorithm, baseline.suggestedFiles);
  if (baseline.outputDigest !== expectedOutput) {
    throw new PilotValidationError(`${path}.outputDigest`, "does not match the baseline suggestions");
  }
}

/** Every registered case must appear exactly once; this is the identity/completeness gate (ADR 0019 invariant 1). */
export function validateBundleAgainstProtocol(protocol: FrozenProtocolV1, raw: RawCollectionBundleV1): void {
  verifyFrozenProtocolDigest(protocol);
  if (raw.protocolDigest !== protocol.digest) {
    throw new PilotValidationError("raw.protocolDigest", "does not match the frozen protocol digest");
  }
  if (raw.experimentId !== protocol.experimentId) {
    throw new PilotValidationError("raw.experimentId", "does not match the frozen protocol experimentId");
  }
  if (raw.observedBunVersion !== protocol.candidate.bunVersion) {
    throw new PilotValidationError("raw.observedBunVersion", "does not match the runtime bound by the frozen protocol");
  }
  const expected = new Set(protocol.corpus.cases.map((c) => c.caseId));
  const observed = new Set(raw.cases.map((c) => c.caseId));
  for (const id of expected) {
    if (!observed.has(id)) throw new PilotValidationError("raw.cases", `missing case "${id}" registered in the frozen protocol`);
  }
  for (const id of observed) {
    if (!expected.has(id)) throw new PilotValidationError("raw.cases", `case "${id}" is not registered in the frozen protocol`);
  }
  const corpusById = new Map(protocol.corpus.cases.map((spec) => [spec.caseId, spec] as const));
  for (const observation of raw.cases) {
    const spec = corpusById.get(observation.caseId)!;
    if (observation.status !== "OBSERVED") continue;
    if (
      observation.git === null
      || observation.git.baseRef !== spec.baseRef
      || observation.git.headRef !== spec.headRef
      || observation.git.range !== `${observation.git.mergeBase.slice(0, 12)}..${observation.git.headRef.slice(0, 12)}`
    ) {
      throw new PilotValidationError(`raw.cases.${observation.caseId}.git`, "does not bind the frozen base/head and canonical merge-base range");
    }
    if (JSON.stringify([...observation.changedFiles].sort()) !== JSON.stringify([...spec.changedFiles].sort())) {
      throw new PilotValidationError(`raw.cases.${observation.caseId}.changedFiles`, "does not match the frozen protocol");
    }
    if (observation.baselineChangedFiles === null || observation.baselineImportNeighborhood === null) {
      throw new PilotValidationError(`raw.cases.${observation.caseId}`, "observed cases require both baseline observations");
    }
    validateBaselineIdentity(
      observation,
      observation.baselineChangedFiles,
      "changed-files-v1",
      `raw.cases.${observation.caseId}.baselineChangedFiles`,
    );
    validateBaselineIdentity(
      observation,
      observation.baselineImportNeighborhood,
      "one-hop-import-neighborhood-v1",
      `raw.cases.${observation.caseId}.baselineImportNeighborhood`,
    );
    const canonicalChangedFiles = [...new Set(observation.changedFiles)].sort();
    if (JSON.stringify(observation.baselineChangedFiles.suggestedFiles) !== JSON.stringify(canonicalChangedFiles)) {
      throw new PilotValidationError(
        `raw.cases.${observation.caseId}.baselineChangedFiles.suggestedFiles`,
        "changed-files baseline must equal the canonical captured changed files",
      );
    }
    if (observation.semctx === null) {
      throw new PilotValidationError(`raw.cases.${observation.caseId}.semctx`, "observed cases require candidate invocations");
    }
    for (const [stage, invocation] of Object.entries({
      init: observation.semctx.init,
      index: observation.semctx.index,
      verify: observation.semctx.verify,
    })) {
      if (invocation.outputDigest !== toolOutputDigest(invocation.stdout, invocation.stderr)) {
        throw new PilotValidationError(
          `raw.cases.${observation.caseId}.semctx.${stage}.outputDigest`,
          "does not match captured stdout and stderr",
        );
      }
    }
    if ((observation.semctx.verificationStatus === "SOURCE_DRIFT") !== (observation.semctx.sourceDriftReason !== null)) {
      throw new PilotValidationError(
        `raw.cases.${observation.caseId}.semctx.sourceDriftReason`,
        "must be present exactly for SOURCE_DRIFT",
      );
    }
    if (observation.semctx?.verificationStatus === "TRUSTED") {
      const interpreted = parseVerifyReport(
        observation.semctx.verify.stdout,
        observation.semctx.verify.exitCode,
        { ...observation.git, changedFiles: spec.changedFiles },
      );
      if (
        interpreted.verificationStatus !== "TRUSTED"
        || interpreted.verdict !== observation.semctx.verdict
        || JSON.stringify(interpreted.suggestedFiles) !== JSON.stringify(observation.semctx.suggestedFiles)
      ) {
        throw new PilotValidationError(`raw.cases.${observation.caseId}.semctx`, "trusted projection disagrees with raw verify output");
      }
    }
  }
}

function suggestedFilesFor(tool: PilotTool, observation: CaseObservation): readonly string[] | null {
  if (observation.status !== "OBSERVED") return null;
  if (tool === "semctx") {
    return observation.semctx?.verificationStatus === "TRUSTED" ? observation.semctx.suggestedFiles : null;
  }
  if (tool === "changed-files") return observation.baselineChangedFiles?.suggestedFiles ?? null;
  return observation.baselineImportNeighborhood?.suggestedFiles ?? null;
}

export interface ToolScore {
  tool: PilotTool;
  labelledCasesScored: number;
  precision: number;
  recall: number;
  criticalRecall: number;
}

/**
 * Micro-averaged over every LABELLED, OBSERVED case: counts are summed across cases before
 * dividing, so one large diff cannot be drowned out by many small ones, and an empty suggestion
 * set on an all-UNKNOWN corpus never silently becomes a perfect score (labelledCasesScored is 0,
 * and callers must treat that as "no score", not as 1.0).
 */
export function scoreTool(
  tool: PilotTool,
  cases: readonly CaseObservation[],
  corpusById: ReadonlyMap<string, CorpusCaseSpec>,
): ToolScore {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let criticalTruePositives = 0;
  let criticalTotal = 0;
  let labelledCasesScored = 0;

  for (const observation of cases) {
    const spec = corpusById.get(observation.caseId);
    if (spec === undefined || spec.label.status !== "LABELLED") continue;
    const suggested = suggestedFilesFor(tool, observation);
    if (suggested === null) continue;
    labelledCasesScored += 1;
    const suggestedSet = new Set(suggested);
    const expectedSet = new Set(spec.label.expectedImpactedFiles);
    for (const file of suggestedSet) {
      if (expectedSet.has(file)) truePositives += 1;
      else falsePositives += 1;
    }
    for (const file of expectedSet) {
      if (!suggestedSet.has(file)) falseNegatives += 1;
    }
    for (const critical of spec.label.criticalFiles) {
      criticalTotal += 1;
      if (suggestedSet.has(critical)) criticalTruePositives += 1;
    }
  }

  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    tool,
    labelledCasesScored,
    precision: precisionDenominator === 0 ? 0 : truePositives / precisionDenominator,
    recall: recallDenominator === 0 ? 0 : truePositives / recallDenominator,
    criticalRecall: criticalTotal === 0 ? 1 : criticalTruePositives / criticalTotal,
  };
}

export interface CriticalMissEntry {
  caseId: string;
  repositoryAlias: string;
  files: readonly string[];
}

function criticalMissesFor(cases: readonly CaseObservation[], corpusById: ReadonlyMap<string, CorpusCaseSpec>): CriticalMissEntry[] {
  const misses: CriticalMissEntry[] = [];
  for (const observation of cases) {
    const spec = corpusById.get(observation.caseId);
    if (spec === undefined || spec.label.status !== "LABELLED") continue;
    const suggested = suggestedFilesFor("semctx", observation);
    if (suggested === null) continue;
    const suggestedSet = new Set(suggested);
    const missed = spec.label.criticalFiles.filter((f) => !suggestedSet.has(f));
    if (missed.length > 0) misses.push({ caseId: spec.caseId, repositoryAlias: spec.repositoryAlias, files: missed });
  }
  return misses;
}

export interface RepositoryTotals {
  repositoryAlias: string;
  totalCases: number;
  observedCases: number;
  failedCases: number;
  untrustedCases: number;
  labelledCases: number;
}

export interface FailedCaseEntry {
  caseId: string;
  repositoryAlias: string;
  reason: string;
}

export interface ResultReportV1 {
  schemaVersion: 1;
  experimentId: string;
  protocolDigest: string;
  evidenceKind: "research" | "smoke";
  verdict: PilotVerdict;
  totals: {
    totalCases: number;
    observedCases: number;
    failedCases: number;
    untrustedCases: number;
    labelledCases: number;
    unknownCases: number;
  };
  perRepository: RepositoryTotals[];
  scores: ToolScore[] | null;
  criticalMisses: CriticalMissEntry[];
  failedCases: FailedCaseEntry[];
  totalDurationMs: number;
  generatedAt: string;
}

function decideVerdict(
  evidenceKind: "research" | "smoke",
  failedCases: number,
  untrustedCases: number,
  labelledCases: number,
  minimumCases: number,
  semctxScore: ToolScore | undefined,
  baselineScores: ToolScore[],
): PilotVerdict {
  if (evidenceKind !== "research") return "EVIDENCE_MISSING";
  if (failedCases > 0 || untrustedCases > 0) return "EVIDENCE_MISSING";
  if (labelledCases === 0 || semctxScore === undefined) return "EVIDENCE_MISSING";
  if (labelledCases < minimumCases) return "INCONCLUSIVE";
  const bestBaselineCriticalRecall = Math.max(0, ...baselineScores.map((s) => s.criticalRecall));
  const criticalNoWorse = semctxScore.criticalRecall >= bestBaselineCriticalRecall;
  return semctxScore.precision >= PRECISION_THRESHOLD && criticalNoWorse ? "POSITIVE" : "NEGATIVE";
}

function durationOf(observation: CaseObservation): number {
  if (observation.status !== "OBSERVED" || observation.semctx === null) return 0;
  return (
    observation.semctx.init.durationMs
    + observation.semctx.index.durationMs
    + observation.semctx.verify.durationMs
    + (observation.baselineChangedFiles?.durationMs ?? 0)
    + (observation.baselineImportNeighborhood?.durationMs ?? 0)
  );
}

export function buildResultReport(
  protocol: FrozenProtocolV1,
  raw: RawCollectionBundleV1,
  now: () => string = () => new Date().toISOString(),
): ResultReportV1 {
  validateBundleAgainstProtocol(protocol, raw);

  const corpusById = new Map(protocol.corpus.cases.map((c) => [c.caseId, c] as const));
  const evidenceKind: "research" | "smoke" = protocol.corpus.kind === "research" ? "research" : "smoke";

  const perRepositoryMap = new Map<string, RepositoryTotals>();
  let labelledCases = 0;
  let unknownCases = 0;
  let observedCases = 0;
  let failedCases = 0;
  let untrustedCases = 0;
  const failedCaseEntries: FailedCaseEntry[] = [];
  let totalDurationMs = 0;

  for (const observation of raw.cases) {
    const spec = corpusById.get(observation.caseId);
    if (spec === undefined) continue; // unreachable after validateBundleAgainstProtocol; narrows the type below
    const bucket = perRepositoryMap.get(spec.repositoryAlias) ?? {
      repositoryAlias: spec.repositoryAlias,
      totalCases: 0,
      observedCases: 0,
      failedCases: 0,
      untrustedCases: 0,
      labelledCases: 0,
    };
    bucket.totalCases += 1;
    if (observation.status === "OBSERVED") {
      bucket.observedCases += 1;
      observedCases += 1;
      if (observation.semctx?.verificationStatus !== "TRUSTED") {
        untrustedCases += 1;
        bucket.untrustedCases += 1;
      }
      totalDurationMs += durationOf(observation);
    } else {
      bucket.failedCases += 1;
      failedCases += 1;
      failedCaseEntries.push({ caseId: spec.caseId, repositoryAlias: spec.repositoryAlias, reason: observation.failureReason ?? "unknown" });
    }
    if (spec.label.status === "LABELLED") {
      bucket.labelledCases += 1;
      labelledCases += 1;
    } else {
      unknownCases += 1;
    }
    perRepositoryMap.set(spec.repositoryAlias, bucket);
  }

  const scores = PILOT_TOOLS.map((tool) => scoreTool(tool, raw.cases, corpusById));
  const semctxScore = scores.find((s) => s.tool === "semctx");
  const baselineScores = scores.filter((s) => s.tool !== "semctx");
  const complete = failedCases === 0 && untrustedCases === 0;
  const reportScores = complete && labelledCases > 0 ? scores : null;
  const verdict = decideVerdict(
    evidenceKind,
    failedCases,
    untrustedCases,
    labelledCases,
    RESEARCH_MINIMUM_CASES,
    semctxScore,
    baselineScores,
  );

  return {
    schemaVersion: 1,
    experimentId: protocol.experimentId,
    protocolDigest: protocol.digest,
    evidenceKind,
    verdict,
    totals: { totalCases: raw.cases.length, observedCases, failedCases, untrustedCases, labelledCases, unknownCases },
    perRepository: [...perRepositoryMap.values()].sort((a, b) => a.repositoryAlias.localeCompare(b.repositoryAlias)),
    scores: reportScores,
    criticalMisses: criticalMissesFor(raw.cases, corpusById),
    failedCases: failedCaseEntries,
    totalDurationMs,
    generatedAt: now(),
  };
}

export interface PublicSummaryV1 {
  schemaVersion: 1;
  experimentId: string;
  protocolDigest: string;
  evidenceKind: "research" | "smoke";
  verdict: PilotVerdict;
  totals: ResultReportV1["totals"];
  perRepository: RepositoryTotals[];
  scores: ToolScore[] | null;
  criticalMisses: CriticalMissEntry[];
  totalDurationMs: number;
  generatedAt: string;
}

function isPublicSourceDeclared(protocol: FrozenProtocolV1, caseId: string): boolean {
  const spec = protocol.corpus.cases.find((c) => c.caseId === caseId);
  return spec !== undefined
    && spec.publicSource !== null
    && protocol.corpus.cases
      .filter((candidate) => candidate.repositoryAlias === spec.repositoryAlias)
      .every((candidate) => candidate.publicSource !== null);
}

/**
 * Strict allowlist projection. Deliberately does not accept the raw collection bundle: only
 * fields already computed into `ResultReportV1` can reach here, so free text (stdout/stderr,
 * failureReason, local paths) has no path into a public export by construction.
 */
export function buildPublicSummary(protocol: FrozenProtocolV1, report: ResultReportV1): PublicSummaryV1 {
  const aliases = [...new Set(protocol.corpus.cases.map((spec) => spec.repositoryAlias))];
  const publicAliases = new Set(aliases.filter((alias) =>
    protocol.corpus.cases
      .filter((spec) => spec.repositoryAlias === alias)
      .every((spec) => spec.publicSource !== null)));
  const privateAliases = aliases.filter((alias) => !publicAliases.has(alias)).sort();
  const privateAliasMap = new Map(privateAliases.map((alias, index) => [alias, `private-repository-${index + 1}`]));
  const publicAlias = (alias: string): string => publicAliases.has(alias) ? alias : (privateAliasMap.get(alias) ?? "private-repository");
  return {
    schemaVersion: 1,
    experimentId: report.experimentId,
    protocolDigest: report.protocolDigest,
    evidenceKind: report.evidenceKind,
    verdict: report.verdict,
    totals: report.totals,
    perRepository: report.perRepository.map((totals) => ({ ...totals, repositoryAlias: publicAlias(totals.repositoryAlias) })),
    scores: report.scores,
    criticalMisses: report.criticalMisses
      .filter((miss) => isPublicSourceDeclared(protocol, miss.caseId))
      .map((miss) => ({ caseId: miss.caseId, repositoryAlias: miss.repositoryAlias, files: miss.files })),
    totalDurationMs: report.totalDurationMs,
    generatedAt: report.generatedAt,
  };
}
