import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { digestCanonical, digestFile, newExperimentId } from "./digest";
import {
  PilotValidationError,
  requireArray,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireGitSha,
  requireInteger,
  requireRecord,
  requireSha256,
  requireString,
  requireStringArray,
} from "./validate-helpers";

/** ADR 0019: the impact manifest targets at least thirty real cases across at least three repositories. */
export const RESEARCH_MINIMUM_CASES = 30;
export const RESEARCH_MINIMUM_REPOSITORIES = 3;

export const PILOT_BASELINES = ["changed-files", "one-hop-import-neighborhood"] as const;
export type PilotBaseline = (typeof PILOT_BASELINES)[number];

export type LabelStatus =
  | { status: "UNKNOWN" }
  | {
      status: "LABELLED";
      provenance: "human" | "published-evidence" | "automated-review";
      expectedImpactedFiles: readonly string[];
      criticalFiles: readonly string[];
    };

export interface CorpusCaseSpec {
  caseId: string;
  repositoryAlias: string;
  synthetic: boolean;
  publicSource: { url: string; license: string } | null;
  baseRef: string;
  headRef: string;
  changedFiles: readonly string[];
  split: "dev" | "held-out";
  label: LabelStatus;
}

export interface CorpusManifest {
  kind: "research" | "synthetic-smoke";
  cases: readonly CorpusCaseSpec[];
}

export type CandidatePackaging = "dist" | "source-dev";

export interface CandidateIdentity {
  packaging: CandidatePackaging;
  entryPath: string;
  entryDigest: string;
  packageName: string;
  packageVersion: string;
  bunVersion: string;
  bunExecutableDigest: string;
  supportFiles: readonly { path: string; digest: string }[];
}

export interface RunnerIdentity {
  entryPath: string;
  entryDigest: string;
  toolSchemaVersion: 1;
  supportFiles: readonly { path: string; digest: string }[];
}

export interface ProtocolConfig {
  perCaseTimeoutMs: number;
  baselines: readonly PilotBaseline[];
  selection: { rule: string; note: string };
}

export interface DraftProtocolInput {
  schemaVersion: 1;
  candidate: { packaging: CandidatePackaging };
  config: ProtocolConfig;
  corpus: CorpusManifest;
}

export interface FrozenProtocolV1 {
  schemaVersion: 1;
  experimentId: string;
  createdAt: string;
  candidate: CandidateIdentity;
  runner: RunnerIdentity;
  config: ProtocolConfig;
  corpus: CorpusManifest;
  digest: string;
}

function validateLabelStatus(value: unknown, path: string): LabelStatus {
  const record = requireRecord(value, path);
  const status = requireEnum(record.status, ["UNKNOWN", "LABELLED"] as const, `${path}.status`);
  if (status === "UNKNOWN") {
    requireExactKeys(record, ["status"], path);
    return { status: "UNKNOWN" };
  }
  requireExactKeys(record, ["status", "provenance", "expectedImpactedFiles", "criticalFiles"], path);
  const provenance = requireEnum(
    record.provenance,
    ["human", "published-evidence", "automated-review"] as const,
    `${path}.provenance`,
  );
  const expectedImpactedFiles = requireStringArray(record.expectedImpactedFiles, `${path}.expectedImpactedFiles`);
  const criticalFiles = requireStringArray(record.criticalFiles, `${path}.criticalFiles`);
  for (const critical of criticalFiles) {
    if (!expectedImpactedFiles.includes(critical)) {
      throw new PilotValidationError(`${path}.criticalFiles`, `"${critical}" is not also in expectedImpactedFiles`);
    }
  }
  return { status: "LABELLED", provenance, expectedImpactedFiles, criticalFiles };
}

function validateCorpusCase(value: unknown, path: string): CorpusCaseSpec {
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    ["caseId", "repositoryAlias", "synthetic", "publicSource", "baseRef", "headRef", "changedFiles", "split", "label"],
    path,
  );
  const publicSourceRaw = record.publicSource;
  let publicSource: { url: string; license: string } | null = null;
  if (publicSourceRaw !== null) {
    const publicSourceRecord = requireRecord(publicSourceRaw, `${path}.publicSource`);
    requireExactKeys(publicSourceRecord, ["url", "license"], `${path}.publicSource`);
    publicSource = {
      url: requireString(publicSourceRecord.url, `${path}.publicSource.url`),
      license: requireString(publicSourceRecord.license, `${path}.publicSource.license`),
    };
  }
  const baseRef = requireGitSha(record.baseRef, `${path}.baseRef`);
  const headRef = requireGitSha(record.headRef, `${path}.headRef`);
  if (baseRef === headRef) throw new PilotValidationError(path, "baseRef and headRef must differ");
  return {
    caseId: requireString(record.caseId, `${path}.caseId`),
    repositoryAlias: requireString(record.repositoryAlias, `${path}.repositoryAlias`),
    synthetic: requireBoolean(record.synthetic, `${path}.synthetic`),
    publicSource,
    baseRef,
    headRef,
    changedFiles: [...new Set(requireStringArray(record.changedFiles, `${path}.changedFiles`))].sort(),
    split: requireEnum(record.split, ["dev", "held-out"] as const, `${path}.split`),
    label: validateLabelStatus(record.label, `${path}.label`),
  };
}

function validateCorpusManifest(value: unknown, path: string): CorpusManifest {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["kind", "cases"], path);
  const kind = requireEnum(record.kind, ["research", "synthetic-smoke"] as const, `${path}.kind`);
  const cases = requireArray(record.cases, `${path}.cases`).map((c, i) => validateCorpusCase(c, `${path}.cases[${i}]`));

  const seenIds = new Set<string>();
  const seenChanges = new Set<string>();
  const sourceByRepository = new Map<string, string>();
  for (const c of cases) {
    if (seenIds.has(c.caseId)) throw new PilotValidationError(path, `duplicate caseId "${c.caseId}"`);
    seenIds.add(c.caseId);
    const changeIdentity = `${c.repositoryAlias}:${c.baseRef}:${c.headRef}`;
    if (seenChanges.has(changeIdentity)) {
      throw new PilotValidationError(path, `duplicate repository/base/head change for case "${c.caseId}"`);
    }
    seenChanges.add(changeIdentity);
    const sourceIdentity = c.publicSource === null ? "private" : JSON.stringify(c.publicSource);
    const existingSourceIdentity = sourceByRepository.get(c.repositoryAlias);
    if (existingSourceIdentity !== undefined && existingSourceIdentity !== sourceIdentity) {
      throw new PilotValidationError(path, `repositoryAlias "${c.repositoryAlias}" has inconsistent publicSource declarations`);
    }
    sourceByRepository.set(c.repositoryAlias, sourceIdentity);
    if (kind === "research" && c.synthetic) {
      throw new PilotValidationError(path, `case "${c.caseId}" is synthetic; a research corpus never counts synthetic cases as evidence`);
    }
    if (kind === "synthetic-smoke" && !c.synthetic) {
      throw new PilotValidationError(path, `case "${c.caseId}" is not marked synthetic in a synthetic-smoke corpus`);
    }
  }

  if (kind === "research") {
    if (cases.length < RESEARCH_MINIMUM_CASES) {
      throw new PilotValidationError(path, `research corpus needs >= ${RESEARCH_MINIMUM_CASES} cases, has ${cases.length}`);
    }
    const distinctRepositories = new Set(cases.map((c) => c.repositoryAlias));
    if (distinctRepositories.size < RESEARCH_MINIMUM_REPOSITORIES) {
      throw new PilotValidationError(
        path,
        `research corpus needs >= ${RESEARCH_MINIMUM_REPOSITORIES} distinct repositories, has ${distinctRepositories.size}`,
      );
    }
  } else if (cases.length === 0) {
    throw new PilotValidationError(path, "synthetic-smoke corpus must not be empty");
  }

  return { kind, cases };
}

function validateProtocolConfig(value: unknown, path: string): ProtocolConfig {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["perCaseTimeoutMs", "baselines", "selection"], path);
  const perCaseTimeoutMs = requireInteger(record.perCaseTimeoutMs, `${path}.perCaseTimeoutMs`);
  if (perCaseTimeoutMs <= 0) throw new PilotValidationError(`${path}.perCaseTimeoutMs`, "must be > 0");
  const baselines = requireStringArray(record.baselines, `${path}.baselines`);
  if (baselines.length !== PILOT_BASELINES.length || !PILOT_BASELINES.every((b) => baselines.includes(b))) {
    throw new PilotValidationError(`${path}.baselines`, `must be exactly ${JSON.stringify(PILOT_BASELINES)}`);
  }
  const selectionRecord = requireRecord(record.selection, `${path}.selection`);
  requireExactKeys(selectionRecord, ["rule", "note"], `${path}.selection`);
  return {
    perCaseTimeoutMs,
    baselines: PILOT_BASELINES,
    selection: {
      rule: requireString(selectionRecord.rule, `${path}.selection.rule`),
      note: requireString(selectionRecord.note, `${path}.selection.note`),
    },
  };
}

function assertPackagingMatchesCorpus(packaging: CandidatePackaging, corpus: CorpusManifest, path: string): void {
  if (corpus.kind === "research" && packaging !== "dist") {
    throw new PilotValidationError(
      path,
      'research protocols require "dist" so the candidate is bound to a self-contained build artifact',
    );
  }
}

/** Structural validation of an unfrozen draft. Does not touch the filesystem or resolve identity. */
export function validateDraftProtocol(value: unknown, path = "draft"): DraftProtocolInput {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schemaVersion", "candidate", "config", "corpus"], path);
  if (record.schemaVersion !== 1) throw new PilotValidationError(`${path}.schemaVersion`, "must be 1");
  const candidateRecord = requireRecord(record.candidate, `${path}.candidate`);
  requireExactKeys(candidateRecord, ["packaging"], `${path}.candidate`);
  const packaging = requireEnum(candidateRecord.packaging, ["dist", "source-dev"] as const, `${path}.candidate.packaging`);
  const corpus = validateCorpusManifest(record.corpus, `${path}.corpus`);
  assertPackagingMatchesCorpus(packaging, corpus, `${path}.candidate.packaging`);
  return {
    schemaVersion: 1,
    candidate: { packaging },
    config: validateProtocolConfig(record.config, `${path}.config`),
    corpus,
  };
}

const RUNNER_ENTRY_PATH = "scripts/impact-pilot.ts";
const CLI_ENTRY_BY_PACKAGING: Record<CandidatePackaging, string> = {
  dist: "apps/cli/dist/index.js",
  "source-dev": "apps/cli/src/index.ts",
};
const CLI_PACKAGE_JSON_PATH = "apps/cli/package.json";
const RUNNER_DEPENDENCY_PATHS = [
  "packages/semantic-engine/src/gitignore.ts",
  "node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/package.json",
  "packages/core/package.json",
  "packages/core/src/verify-report.ts",
] as const;
const ZOD_RUNTIME_ROOT_PATH = "packages/core/node_modules/zod";

function listFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(absolute) : [absolute];
  });
}

export function resolveCandidateIdentity(repoRoot: string, packaging: CandidatePackaging): CandidateIdentity {
  const entryPath = CLI_ENTRY_BY_PACKAGING[packaging];
  const absoluteEntry = join(repoRoot, entryPath);
  let entryDigest: string;
  try {
    entryDigest = digestFile(absoluteEntry);
  } catch {
    throw new PilotValidationError(
      "candidate",
      `${entryPath} is not readable (packaging "${packaging}" requires it to exist; build it first if using "dist")`,
    );
  }
  const cliPackageJson = JSON.parse(readFileSync(join(repoRoot, CLI_PACKAGE_JSON_PATH), "utf8")) as {
    name: string;
    version: string;
  };
  const supportPaths = packaging === "dist"
    ? listFilesRecursively(join(repoRoot, "apps", "cli", "dist"))
      .map((absolute) => relative(repoRoot, absolute).split("\\").join("/"))
      .filter((path) => path !== entryPath)
      .sort()
    : [];
  supportPaths.push(CLI_PACKAGE_JSON_PATH);
  return {
    packaging,
    entryPath,
    entryDigest,
    packageName: cliPackageJson.name,
    packageVersion: cliPackageJson.version,
    bunVersion: Bun.version,
    bunExecutableDigest: digestFile(process.execPath),
    supportFiles: supportPaths.map((path) => ({ path, digest: digestFile(join(repoRoot, path)) })),
  };
}

export function resolveRunnerIdentity(repoRoot: string): RunnerIdentity {
  const absoluteEntry = join(repoRoot, RUNNER_ENTRY_PATH);
  const zodRuntimeFiles = listFilesRecursively(join(repoRoot, ZOD_RUNTIME_ROOT_PATH))
    .map((absolute) => relative(repoRoot, absolute).split("\\").join("/"));
  const supportFiles = readdirSync(join(repoRoot, "scripts", "pilot"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `scripts/pilot/${entry.name}`)
    .concat(RUNNER_DEPENDENCY_PATHS)
    .concat(zodRuntimeFiles)
    .sort()
    .map((path) => ({ path, digest: digestFile(join(repoRoot, path)) }));
  return { entryPath: RUNNER_ENTRY_PATH, entryDigest: digestFile(absoluteEntry), toolSchemaVersion: 1, supportFiles };
}

/** Freezing never mutates or replaces an existing file; every changed input mints a new experiment. */
export function freezeProtocol(draft: DraftProtocolInput, repoRoot: string): FrozenProtocolV1 {
  const candidate = resolveCandidateIdentity(repoRoot, draft.candidate.packaging);
  const runner = resolveRunnerIdentity(repoRoot);
  const withoutDigest = {
    schemaVersion: 1 as const,
    experimentId: newExperimentId(draft.corpus.kind === "research" ? "impact-pilot-research" : "impact-pilot-smoke"),
    createdAt: new Date().toISOString(),
    candidate,
    runner,
    config: draft.config,
    corpus: draft.corpus,
  };
  return { ...withoutDigest, digest: digestCanonical(withoutDigest) };
}

/** Recomputes the digest a frozen file claims and fails if the file was hand-edited after freezing. */
export function verifyFrozenProtocolDigest(protocol: FrozenProtocolV1): void {
  const { digest, ...withoutDigest } = protocol;
  const expected = digestCanonical(withoutDigest);
  if (digest !== expected) {
    throw new PilotValidationError("protocol.digest", `stored digest ${digest} does not match recomputed ${expected}`);
  }
}

export function validateFrozenProtocol(value: unknown, path = "protocol"): FrozenProtocolV1 {
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    ["schemaVersion", "experimentId", "createdAt", "candidate", "runner", "config", "corpus", "digest"],
    path,
  );
  if (record.schemaVersion !== 1) throw new PilotValidationError(`${path}.schemaVersion`, "must be 1");
  const candidateRecord = requireRecord(record.candidate, `${path}.candidate`);
  requireExactKeys(
    candidateRecord,
    ["packaging", "entryPath", "entryDigest", "packageName", "packageVersion", "bunVersion", "bunExecutableDigest", "supportFiles"],
    `${path}.candidate`,
  );
  const supportFiles = requireArray(candidateRecord.supportFiles, `${path}.candidate.supportFiles`).map((s, i) => {
    const r = requireRecord(s, `${path}.candidate.supportFiles[${i}]`);
    requireExactKeys(r, ["path", "digest"], `${path}.candidate.supportFiles[${i}]`);
    return {
      path: requireString(r.path, `${path}.candidate.supportFiles[${i}].path`),
      digest: requireSha256(r.digest, `${path}.candidate.supportFiles[${i}].digest`),
    };
  });
  const candidate: CandidateIdentity = {
    packaging: requireEnum(candidateRecord.packaging, ["dist", "source-dev"] as const, `${path}.candidate.packaging`),
    entryPath: requireString(candidateRecord.entryPath, `${path}.candidate.entryPath`),
    entryDigest: requireSha256(candidateRecord.entryDigest, `${path}.candidate.entryDigest`),
    packageName: requireString(candidateRecord.packageName, `${path}.candidate.packageName`),
    packageVersion: requireString(candidateRecord.packageVersion, `${path}.candidate.packageVersion`),
    bunVersion: requireString(candidateRecord.bunVersion, `${path}.candidate.bunVersion`),
    bunExecutableDigest: requireSha256(candidateRecord.bunExecutableDigest, `${path}.candidate.bunExecutableDigest`),
    supportFiles,
  };
  const runnerRecord = requireRecord(record.runner, `${path}.runner`);
  requireExactKeys(runnerRecord, ["entryPath", "entryDigest", "toolSchemaVersion", "supportFiles"], `${path}.runner`);
  if (runnerRecord.toolSchemaVersion !== 1) throw new PilotValidationError(`${path}.runner.toolSchemaVersion`, "must be 1");
  const runner: RunnerIdentity = {
    entryPath: requireString(runnerRecord.entryPath, `${path}.runner.entryPath`),
    entryDigest: requireSha256(runnerRecord.entryDigest, `${path}.runner.entryDigest`),
    toolSchemaVersion: 1,
    supportFiles: requireArray(runnerRecord.supportFiles, `${path}.runner.supportFiles`).map((s, i) => {
      const support = requireRecord(s, `${path}.runner.supportFiles[${i}]`);
      requireExactKeys(support, ["path", "digest"], `${path}.runner.supportFiles[${i}]`);
      return {
        path: requireString(support.path, `${path}.runner.supportFiles[${i}].path`),
        digest: requireSha256(support.digest, `${path}.runner.supportFiles[${i}].digest`),
      };
    }),
  };
  const corpus = validateCorpusManifest(record.corpus, `${path}.corpus`);
  assertPackagingMatchesCorpus(candidate.packaging, corpus, `${path}.candidate.packaging`);
  if (candidate.entryPath !== CLI_ENTRY_BY_PACKAGING[candidate.packaging]) {
    throw new PilotValidationError(`${path}.candidate.entryPath`, "does not match candidate.packaging");
  }
  if (runner.entryPath !== RUNNER_ENTRY_PATH) {
    throw new PilotValidationError(`${path}.runner.entryPath`, `must be ${RUNNER_ENTRY_PATH}`);
  }
  const protocol: FrozenProtocolV1 = {
    schemaVersion: 1,
    experimentId: requireString(record.experimentId, `${path}.experimentId`),
    createdAt: requireString(record.createdAt, `${path}.createdAt`),
    candidate,
    runner,
    config: validateProtocolConfig(record.config, `${path}.config`),
    corpus,
    digest: requireSha256(record.digest, `${path}.digest`),
  };
  verifyFrozenProtocolDigest(protocol);
  return protocol;
}
