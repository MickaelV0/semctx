import { mkdtempSync, rmSync, statSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTypeScriptFiles, changedFilesBaseline, oneHopImportNeighborhoodBaseline } from "./baselines";
import { runBounded, TIMED_OUT_EXIT_CODE, type BoundedRunResult } from "./child";
import { resolveCandidateIdentity, resolveRunnerIdentity, type FrozenProtocolV1 } from "./protocol";
import { digestCanonical } from "./digest";
import {
  PilotValidationError,
  isRecord,
  requireArray,
  requireBoolean,
  requireEnum,
  requireExactKeys,
  requireInteger,
  requireRecord,
  requireSha256,
  requireString,
  requireStringArray,
} from "./validate-helpers";

export interface ToolInvocation {
  argv: readonly string[];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function toToolInvocation(result: BoundedRunResult): ToolInvocation {
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface SemctxCaseRun {
  init: ToolInvocation;
  index: ToolInvocation;
  verify: ToolInvocation;
  /** `null` when the verify step produced no parseable versioned JSON contract. */
  verdict: "PASS" | "WARN" | "BLOCK" | null;
  verificationStatus: "TRUSTED" | "PREREQUISITE_FAILED" | "TIMED_OUT" | "MALFORMED_OUTPUT" | "EXIT_MISMATCH" | "DIFF_MISMATCH";
  /** The candidate's own view of impact: changed files union in-repo consumers, deduplicated. */
  suggestedFiles: readonly string[];
}

export interface BaselineCaseRun {
  suggestedFiles: readonly string[];
  durationMs: number;
}

export interface CaseObservation {
  caseId: string;
  /** `FAILED` is an infrastructure failure (missing source, clone/checkout); a candidate exit
   *  failure (e.g. BLOCK) is still `OBSERVED` — the ADR requires observed tool failures to stay in
   *  the denominator rather than collapse into "missing evidence". */
  status: "OBSERVED" | "FAILED";
  failureReason: string | null;
  changedFiles: readonly string[];
  semctx: SemctxCaseRun | null;
  baselineChangedFiles: BaselineCaseRun | null;
  baselineImportNeighborhood: BaselineCaseRun | null;
}

export interface RawCollectionBundleV1 {
  schemaVersion: 1;
  experimentId: string;
  protocolDigest: string;
  collectedAt: string;
  observedBunVersion: string;
  cases: readonly CaseObservation[];
}

export interface LocalSourcesFile {
  schemaVersion: 1;
  /** caseId -> absolute local repository path. Local-only: never embedded in a frozen protocol or export. */
  paths: Readonly<Record<string, string>>;
}

export function validateLocalSourcesFile(value: unknown, path = "sources"): LocalSourcesFile {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schemaVersion", "paths"], path);
  if (record.schemaVersion !== 1) throw new PilotValidationError(`${path}.schemaVersion`, "must be 1");
  const pathsRecord = requireRecord(record.paths, `${path}.paths`);
  const paths: Record<string, string> = {};
  for (const [caseId, sourcePath] of Object.entries(pathsRecord)) {
    paths[caseId] = requireString(sourcePath, `${path}.paths.${caseId}`);
  }
  return { schemaVersion: 1, paths };
}

export function parseVerifyReport(
  stdout: string,
  exitCode: number,
  expected: { baseRef: string; headRef: string; changedFiles: readonly string[] },
): Pick<SemctxCaseRun, "verdict" | "verificationStatus" | "suggestedFiles"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
  }
  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== 1
    || (parsed.verdict !== "PASS" && parsed.verdict !== "WARN" && parsed.verdict !== "BLOCK")
    || !Array.isArray(parsed.changedFiles)
    || !parsed.changedFiles.every((file) => typeof file === "string")
  ) {
    return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
  }
  const reportedChangedFiles = [...new Set(parsed.changedFiles)].sort();
  const expectedChangedFiles = [...expected.changedFiles].sort();
  if (
    parsed.base !== expected.baseRef
    || parsed.head !== expected.headRef
    || JSON.stringify(reportedChangedFiles) !== JSON.stringify(expectedChangedFiles)
  ) {
    return { verdict: null, verificationStatus: "DIFF_MISMATCH", suggestedFiles: [] };
  }
  const expectedExitCode = parsed.verdict === "BLOCK" ? 3 : 0;
  if (exitCode !== expectedExitCode) {
    return { verdict: null, verificationStatus: "EXIT_MISMATCH", suggestedFiles: [] };
  }
  const consumerFiles: string[] = [];
  if (parsed.impactedConsumers !== undefined) {
    if (!Array.isArray(parsed.impactedConsumers)) {
      return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
    }
    for (const entry of parsed.impactedConsumers) {
      if (!isRecord(entry) || !Array.isArray(entry.consumers)) {
        return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
      }
      for (const consumer of entry.consumers) {
        if (!isRecord(consumer)) return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
        if (consumer.file !== undefined && typeof consumer.file !== "string") {
          return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
        }
        if (typeof consumer.file === "string" && consumer.file.length > 0) consumerFiles.push(consumer.file);
      }
    }
  }
  const suggestedFiles = [...new Set([...reportedChangedFiles, ...consumerFiles])].sort();
  return { verdict: parsed.verdict, verificationStatus: "TRUSTED", suggestedFiles };
}

function sanitizedEnvironment(disabledHooksPath: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  delete environment.SEMCTX_ROOT;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : devNull;
  environment.GIT_EXTERNAL_DIFF = "";
  environment.GIT_CONFIG_COUNT = "1";
  environment.GIT_CONFIG_KEY_0 = "core.hooksPath";
  environment.GIT_CONFIG_VALUE_0 = disabledHooksPath;
  return environment;
}

/** Never `sourcePath` as a `cwd` or a `-C` target: it is only ever an argument to `git clone`, so the source repository is never mutated. */
function git(args: readonly string[], cwd: string, timeoutMs: number, environment: Record<string, string>): BoundedRunResult {
  return runBounded(["git", ...args], { cwd, timeoutMs, env: environment });
}

export interface CollectDependencies {
  mkTempDir?: (prefix: string) => string;
  removeDir?: (path: string) => void;
  now?: () => string;
}

const defaultMkTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const defaultRemoveDir = (path: string): void => rmSync(path, { recursive: true, force: true });

function collectOneCase(
  caseSpec: FrozenProtocolV1["corpus"]["cases"][number],
  sourcePath: string | undefined,
  candidateArgvPrefix: readonly string[],
  timeoutMs: number,
  dependencies: Required<CollectDependencies>,
  assertImplementationIdentity: () => void,
): CaseObservation {
  const failed = (reason: string): CaseObservation => ({
    caseId: caseSpec.caseId,
    status: "FAILED",
    failureReason: reason,
    changedFiles: [],
    semctx: null,
    baselineChangedFiles: null,
    baselineImportNeighborhood: null,
  });

  if (sourcePath === undefined) return failed("no local source path provided for this caseId");
  try {
    statSync(sourcePath);
  } catch {
    return failed(`source path does not exist: ${sourcePath}`);
  }

  const workspace = dependencies.mkTempDir("semctx-impact-pilot-case-");
  const environment = sanitizedEnvironment(`${workspace}-disabled-hooks`);
  try {
    const clone = git(["clone", "--no-hardlinks", "--local", "--quiet", "--no-checkout", sourcePath, workspace], tmpdir(), timeoutMs, environment);
    if (clone.exitCode !== 0 || clone.timedOut) return failed(`git clone failed: ${clone.stderr.slice(0, 500)}`);

    const checkout = git(["-C", workspace, "checkout", "--quiet", "--detach", caseSpec.headRef], workspace, timeoutMs, environment);
    if (checkout.exitCode !== 0 || checkout.timedOut) return failed(`headRef not resolvable in clone: ${caseSpec.headRef}`);

    const head = git(["-C", workspace, "rev-parse", "HEAD"], workspace, timeoutMs, environment);
    if (head.exitCode !== 0 || head.timedOut || head.stdout.trim() !== caseSpec.headRef) {
      return failed(`checked-out HEAD does not match headRef: ${caseSpec.headRef}`);
    }
    const baseExists = git(["-C", workspace, "cat-file", "-e", `${caseSpec.baseRef}^{commit}`], workspace, timeoutMs, environment);
    if (baseExists.exitCode !== 0 || baseExists.timedOut) return failed(`baseRef not resolvable in clone: ${caseSpec.baseRef}`);

    const diff = git(
      ["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-only", caseSpec.baseRef, caseSpec.headRef],
      workspace,
      timeoutMs,
      environment,
    );
    if (diff.exitCode !== 0 || diff.timedOut) return failed(`git diff failed: ${diff.stderr.slice(0, 500)}`);
    const changedFiles = diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).sort();
    if (JSON.stringify(changedFiles) !== JSON.stringify(caseSpec.changedFiles)) {
      return failed("observed git diff does not match changedFiles bound by the frozen protocol");
    }

    const runCandidate = (args: readonly string[]): ToolInvocation => {
      assertImplementationIdentity();
      const invocation = toToolInvocation(runBounded([...candidateArgvPrefix, ...args, "--root", workspace], {
        cwd: workspace,
        timeoutMs,
        env: environment,
      }));
      assertImplementationIdentity();
      return invocation;
    };
    const init = runCandidate(["init"]);
    const index = runCandidate(["index"]);
    const verify = runCandidate(["verify", "diff", "--base", caseSpec.baseRef, "--head", caseSpec.headRef, "--format", "json"]);
    const verification = init.exitCode !== 0 || index.exitCode !== 0 || init.timedOut || index.timedOut
      ? { verdict: null, verificationStatus: "PREREQUISITE_FAILED" as const, suggestedFiles: [] }
      : verify.timedOut
        ? { verdict: null, verificationStatus: "TIMED_OUT" as const, suggestedFiles: [] }
        : parseVerifyReport(verify.stdout, verify.exitCode, caseSpec);

    const listFiles = git(["-C", workspace, "ls-files"], workspace, timeoutMs, environment);
    if (listFiles.exitCode !== 0 || listFiles.timedOut) return failed(`git ls-files failed: ${listFiles.stderr.slice(0, 500)}`);
    const allFiles = discoverTypeScriptFiles(
      workspace,
      listFiles.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    );

    const baselineStarted = performance.now();
    const changedFilesSuggested = changedFilesBaseline(changedFiles);
    const baselineChangedFiles: BaselineCaseRun = {
      suggestedFiles: changedFilesSuggested,
      durationMs: Math.round((performance.now() - baselineStarted) * 100) / 100,
    };

    const neighborhoodStarted = performance.now();
    const neighborhoodSuggested = oneHopImportNeighborhoodBaseline(workspace, changedFiles, allFiles);
    const baselineImportNeighborhood: BaselineCaseRun = {
      suggestedFiles: neighborhoodSuggested,
      durationMs: Math.round((performance.now() - neighborhoodStarted) * 100) / 100,
    };

    return {
      caseId: caseSpec.caseId,
      status: "OBSERVED",
      failureReason: null,
      changedFiles,
      semctx: { init, index, verify, ...verification },
      baselineChangedFiles,
      baselineImportNeighborhood,
    };
  } catch (error) {
    if (error instanceof PilotValidationError) throw error;
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    dependencies.removeDir(workspace);
  }
}

export function collectCases(
  protocol: FrozenProtocolV1,
  sources: LocalSourcesFile,
  repoRoot: string,
  dependencies: CollectDependencies = {},
): RawCollectionBundleV1 {
  const registeredCaseIds = new Set(protocol.corpus.cases.map((caseSpec) => caseSpec.caseId));
  for (const caseId of Object.keys(sources.paths)) {
    if (!registeredCaseIds.has(caseId)) {
      throw new PilotValidationError("sources.paths", `caseId "${caseId}" is not registered in the frozen protocol`);
    }
  }
  const assertImplementationIdentity = (): void => {
    const observed = resolveCandidateIdentity(repoRoot, protocol.candidate.packaging);
    const observedRunner = resolveRunnerIdentity(repoRoot);
    if (digestCanonical(observed) !== digestCanonical(protocol.candidate)) {
      throw new PilotValidationError(
        "candidate",
        "the candidate CLI on disk no longer matches the frozen protocol identity; re-freeze a new experiment instead of collecting against a moved target",
      );
    }
    if (digestCanonical(observedRunner) !== digestCanonical(protocol.runner)) {
      throw new PilotValidationError(
        "runner",
        "the impact-pilot runner on disk no longer matches the frozen protocol identity; re-freeze before collecting",
      );
    }
  };
  assertImplementationIdentity();

  const deps: Required<CollectDependencies> = {
    mkTempDir: dependencies.mkTempDir ?? defaultMkTempDir,
    removeDir: dependencies.removeDir ?? defaultRemoveDir,
    now: dependencies.now ?? (() => new Date().toISOString()),
  };
  const candidateArgvPrefix = [process.execPath, "run", join(repoRoot, protocol.candidate.entryPath)] as const;

  const cases: CaseObservation[] = protocol.corpus.cases.map((caseSpec) =>
    collectOneCase(
      caseSpec,
      sources.paths[caseSpec.caseId],
      candidateArgvPrefix,
      protocol.config.perCaseTimeoutMs,
      deps,
      assertImplementationIdentity,
    ),
  );

  return {
    schemaVersion: 1,
    experimentId: protocol.experimentId,
    protocolDigest: protocol.digest,
    collectedAt: deps.now(),
    observedBunVersion: Bun.version,
    cases,
  };
}

function validateToolInvocation(value: unknown, path: string): ToolInvocation {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["argv", "exitCode", "timedOut", "durationMs", "stdout", "stderr"], path);
  const invocation = {
    argv: requireStringArray(record.argv, `${path}.argv`),
    exitCode: requireInteger(record.exitCode, `${path}.exitCode`),
    timedOut: requireBoolean(record.timedOut, `${path}.timedOut`),
    durationMs: requireFiniteNonNegative(record.durationMs, `${path}.durationMs`),
    stdout: requireString0(record.stdout, `${path}.stdout`),
    stderr: requireString0(record.stderr, `${path}.stderr`),
  };
  if (invocation.timedOut !== (invocation.exitCode === TIMED_OUT_EXIT_CODE)) {
    throw new PilotValidationError(path, `timedOut must be true exactly when exitCode is ${TIMED_OUT_EXIT_CODE}`);
  }
  return invocation;
}

function requireFiniteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PilotValidationError(path, "expected a finite non-negative number");
  }
  return value;
}

/** Same as requireString but allows the empty string (unlike governed identity fields, process stdout/stderr legitimately can be empty). */
function requireString0(value: unknown, path: string): string {
  if (typeof value !== "string") throw new PilotValidationError(path, "expected a string");
  return value;
}

export function validateRawCollectionBundle(value: unknown, path = "raw"): RawCollectionBundleV1 {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schemaVersion", "experimentId", "protocolDigest", "collectedAt", "observedBunVersion", "cases"], path);
  if (record.schemaVersion !== 1) throw new PilotValidationError(`${path}.schemaVersion`, "must be 1");
  const cases: CaseObservation[] = requireArray(record.cases, `${path}.cases`).map((c, i): CaseObservation => {
    const caseRecord = requireRecord(c, `${path}.cases[${i}]`);
    requireExactKeys(
      caseRecord,
      ["caseId", "status", "failureReason", "changedFiles", "semctx", "baselineChangedFiles", "baselineImportNeighborhood"],
      `${path}.cases[${i}]`,
    );
    const status = caseRecord.status;
    if (status !== "OBSERVED" && status !== "FAILED") {
      throw new PilotValidationError(`${path}.cases[${i}].status`, "must be OBSERVED or FAILED");
    }
    const caseId = requireString(caseRecord.caseId, `${path}.cases[${i}].caseId`);
    const changedFiles = requireStringArray(caseRecord.changedFiles, `${path}.cases[${i}].changedFiles`);
    const failureReason = caseRecord.failureReason === null ? null : requireString(caseRecord.failureReason, `${path}.cases[${i}].failureReason`);
    if (status === "FAILED") {
      if (caseRecord.semctx !== null || caseRecord.baselineChangedFiles !== null || caseRecord.baselineImportNeighborhood !== null) {
        throw new PilotValidationError(`${path}.cases[${i}]`, "FAILED cases must not contain tool or baseline runs");
      }
      if (changedFiles.length !== 0) {
        throw new PilotValidationError(`${path}.cases[${i}].changedFiles`, "FAILED cases must not claim observed changed files");
      }
      return { caseId, status, failureReason, changedFiles, semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null };
    }
    if (failureReason !== null) {
      throw new PilotValidationError(`${path}.cases[${i}].failureReason`, "OBSERVED cases must have a null failureReason");
    }
    const semctxRecord = requireRecord(caseRecord.semctx, `${path}.cases[${i}].semctx`);
    requireExactKeys(
      semctxRecord,
      ["init", "index", "verify", "verdict", "verificationStatus", "suggestedFiles"],
      `${path}.cases[${i}].semctx`,
    );
    const verdict = semctxRecord.verdict;
    if (verdict !== null && verdict !== "PASS" && verdict !== "WARN" && verdict !== "BLOCK") {
      throw new PilotValidationError(`${path}.cases[${i}].semctx.verdict`, "must be PASS | WARN | BLOCK | null");
    }
    const semctx: SemctxCaseRun = {
      init: validateToolInvocation(semctxRecord.init, `${path}.cases[${i}].semctx.init`),
      index: validateToolInvocation(semctxRecord.index, `${path}.cases[${i}].semctx.index`),
      verify: validateToolInvocation(semctxRecord.verify, `${path}.cases[${i}].semctx.verify`),
      verdict,
      verificationStatus: requireEnum(
        semctxRecord.verificationStatus,
        ["TRUSTED", "PREREQUISITE_FAILED", "TIMED_OUT", "MALFORMED_OUTPUT", "EXIT_MISMATCH", "DIFF_MISMATCH"] as const,
        `${path}.cases[${i}].semctx.verificationStatus`,
      ),
      suggestedFiles: requireStringArray(semctxRecord.suggestedFiles, `${path}.cases[${i}].semctx.suggestedFiles`),
    };
    if (semctx.verificationStatus === "TRUSTED") {
      if (semctx.verdict === null || semctx.init.exitCode !== 0 || semctx.index.exitCode !== 0 || semctx.verify.timedOut) {
        throw new PilotValidationError(`${path}.cases[${i}].semctx`, "TRUSTED requires successful prerequisites and a non-null verdict");
      }
      const expectedExitCode = semctx.verdict === "BLOCK" ? 3 : 0;
      if (semctx.verify.exitCode !== expectedExitCode) {
        throw new PilotValidationError(`${path}.cases[${i}].semctx.verify.exitCode`, "does not match the trusted verdict");
      }
    } else if (semctx.verdict !== null || semctx.suggestedFiles.length !== 0) {
      throw new PilotValidationError(
        `${path}.cases[${i}].semctx`,
        "untrusted verification must preserve a null verdict and an empty suggestion set",
      );
    }
    const baselineOf = (key: "baselineChangedFiles" | "baselineImportNeighborhood"): BaselineCaseRun => {
      const baselineRecord = requireRecord(caseRecord[key], `${path}.cases[${i}].${key}`);
      requireExactKeys(baselineRecord, ["suggestedFiles", "durationMs"], `${path}.cases[${i}].${key}`);
      return {
        suggestedFiles: requireStringArray(baselineRecord.suggestedFiles, `${path}.cases[${i}].${key}.suggestedFiles`),
        durationMs: requireFiniteNonNegative(baselineRecord.durationMs, `${path}.cases[${i}].${key}.durationMs`),
      };
    };
    return {
      caseId,
      status,
      failureReason,
      changedFiles,
      semctx,
      baselineChangedFiles: baselineOf("baselineChangedFiles"),
      baselineImportNeighborhood: baselineOf("baselineImportNeighborhood"),
    };
  });

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.caseId)) throw new PilotValidationError(path, `duplicate caseId in raw bundle: "${c.caseId}"`);
    seen.add(c.caseId);
  }

  return {
    schemaVersion: 1,
    experimentId: requireString(record.experimentId, `${path}.experimentId`),
    protocolDigest: requireSha256(record.protocolDigest, `${path}.protocolDigest`),
    collectedAt: requireString(record.collectedAt, `${path}.collectedAt`),
    observedBunVersion: requireString(record.observedBunVersion, `${path}.observedBunVersion`),
    cases,
  };
}
