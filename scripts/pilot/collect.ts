import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { VerifyReportSchema } from "../../packages/core/src/verify-report";
import { computeGitignore } from "../../packages/semantic-engine/src/gitignore";
import { discoverTypeScriptFiles, changedFilesBaseline, oneHopImportNeighborhoodBaseline } from "./baselines";
import { runBounded, TIMED_OUT_EXIT_CODE, type BoundedRunResult } from "./child";
import { resolveCandidateIdentity, resolveRunnerIdentity, type FrozenProtocolV1 } from "./protocol";
import { digestCanonical } from "./digest";
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

export interface ToolInvocation {
  argv: readonly string[];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputDigest: string;
}

export function toolOutputDigest(stdout: string, stderr: string): string {
  return digestCanonical({ stdout, stderr });
}

function toToolInvocation(result: BoundedRunResult): ToolInvocation {
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    outputDigest: toolOutputDigest(result.stdout, result.stderr),
  };
}

export interface SemctxCaseRun {
  init: ToolInvocation;
  index: ToolInvocation;
  verify: ToolInvocation;
  /** `null` when the verify step produced no parseable versioned JSON contract. */
  verdict: "PASS" | "WARN" | "BLOCK" | null;
  verificationStatus: "TRUSTED" | "PREREQUISITE_FAILED" | "TIMED_OUT" | "MALFORMED_OUTPUT" | "EXIT_MISMATCH" | "DIFF_MISMATCH" | "SOURCE_DRIFT";
  /** First tracked checkout mismatch observed at a candidate process boundary. */
  sourceDriftReason: string | null;
  /** The candidate's own view of impact: changed files union in-repo consumers, deduplicated. */
  suggestedFiles: readonly string[];
}

export interface BaselineCaseRun {
  algorithm: "changed-files-v1" | "one-hop-import-neighborhood-v1";
  suggestedFiles: readonly string[];
  durationMs: number;
  inputDigest: string;
  outputDigest: string;
}

export interface CaseGitIdentity {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  range: string;
  headTree: string;
  trackedFilesDigest: string;
  trackedIndexDigest: string;
}

export type BaselineAlgorithm = BaselineCaseRun["algorithm"];

export function baselineInputDigest(
  algorithm: BaselineAlgorithm,
  gitIdentity: CaseGitIdentity,
  changedFiles: readonly string[],
): string {
  return digestCanonical({
    algorithm,
    git: gitIdentity,
    changedFiles: [...changedFiles],
  });
}

export function baselineOutputDigest(algorithm: BaselineAlgorithm, suggestedFiles: readonly string[]): string {
  return digestCanonical({ algorithm, suggestedFiles: [...suggestedFiles] });
}

function trackedCheckoutDigest(
  root: string,
  trackedFiles: readonly string[],
  contentOverrides: ReadonlyMap<string, string> = new Map(),
): string {
  return digestCanonical(trackedFiles.map((path) => {
    const absolutePath = join(root, path);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return { path, kind: "symlink", target: readlinkSync(absolutePath) };
    if (stat.isFile()) {
      const content = contentOverrides.has(path) ? contentOverrides.get(path)! : readFileSync(absolutePath);
      return { path, kind: "file", digest: `sha256:${createHash("sha256").update(content).digest("hex")}` };
    }
    // A gitlink can be present without an initialized submodule. Its index identity and kind are still bound.
    return { path, kind: "other" };
  }));
}

function splitNullTerminatedPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function isConfinedMetadataPath(root: string, path: string): boolean {
  if (!path.startsWith(".semctx/") || path.includes("\\") || path.includes(":")) return false;
  if (!path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")) return false;
  try {
    const fromRoot = relative(realpathSync(root), realpathSync(join(root, path)));
    return fromRoot.length > 0 && !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  } catch {
    return false;
  }
}

export interface CaseObservation {
  caseId: string;
  /** `FAILED` is an infrastructure failure (missing source, clone/checkout); a candidate exit
   *  failure (e.g. BLOCK) is still `OBSERVED` — the ADR requires observed tool failures to stay in
   *  the denominator rather than collapse into "missing evidence". */
  status: "OBSERVED" | "FAILED";
  failureReason: string | null;
  git: CaseGitIdentity | null;
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
  const paths = Object.create(null) as Record<string, string>;
  for (const [caseId, sourcePath] of Object.entries(pathsRecord)) {
    const validatedPath = requireString(sourcePath, `${path}.paths.${caseId}`);
    if (!isAbsolute(validatedPath)) {
      throw new PilotValidationError(`${path}.paths.${caseId}`, "must be an absolute local repository path");
    }
    paths[caseId] = validatedPath;
  }
  return { schemaVersion: 1, paths };
}

export function parseVerifyReport(
  stdout: string,
  exitCode: number,
  expected: Pick<CaseGitIdentity, "baseRef" | "headRef" | "mergeBase" | "range"> & { changedFiles: readonly string[] },
): Pick<SemctxCaseRun, "verdict" | "verificationStatus" | "suggestedFiles"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
  }
  const validated = VerifyReportSchema.safeParse(parsed);
  if (!validated.success) {
    return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
  }
  const report = validated.data;
  const blockCount = report.findings.filter((finding) => finding.severity === "block").length;
  const warnCount = report.findings.filter((finding) => finding.severity === "warn").length;
  const derivedVerdict = blockCount > 0 ? "BLOCK" : warnCount > 0 ? "WARN" : "PASS";
  if (
    report.summary.blockCount !== blockCount
    || report.summary.warnCount !== warnCount
    || report.verdict !== derivedVerdict
  ) {
    return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
  }
  const reportedChangedFiles = [...new Set(report.changedFiles)].sort();
  const expectedChangedFiles = [...expected.changedFiles].sort();
  if (
    report.base !== expected.baseRef
    || report.head !== expected.headRef
    || report.mergeBase !== expected.mergeBase
    || report.range !== expected.range
    || JSON.stringify(reportedChangedFiles) !== JSON.stringify(expectedChangedFiles)
  ) {
    return { verdict: null, verificationStatus: "DIFF_MISMATCH", suggestedFiles: [] };
  }
  const expectedExitCode = report.verdict === "BLOCK" ? 3 : 0;
  if (exitCode !== expectedExitCode) {
    return { verdict: null, verificationStatus: "EXIT_MISMATCH", suggestedFiles: [] };
  }
  const consumerFiles: string[] = [];
  const isConfinedRepositoryPath = (path: string): boolean => {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
    return path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."
      && [...part].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
  };
  for (const entry of report.impactedConsumers ?? []) {
    const files = [entry.symbol.file, ...entry.consumers.map((consumer) => consumer.file)]
      .filter((file): file is string => file !== undefined);
    if (!files.every(isConfinedRepositoryPath)) {
      return { verdict: null, verificationStatus: "MALFORMED_OUTPUT", suggestedFiles: [] };
    }
    for (const consumer of entry.consumers) {
      if (consumer.file !== undefined) {
        consumerFiles.push(consumer.file);
      }
    }
  }
  const suggestedFiles = [...new Set([...reportedChangedFiles, ...consumerFiles])].sort();
  return { verdict: report.verdict, verificationStatus: "TRUSTED", suggestedFiles };
}

function sanitizedEnvironment(disabledHooksPath: string): Record<string, string> {
  const environment: Record<string, string> = {};
  // Git routing can override cwd and write outside the private clone, including through the CLI.
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && !upper.startsWith("GIT_") && upper !== "SEMCTX_ROOT") environment[key] = value;
  }
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
    git: null,
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

    const merge = git(["-C", workspace, "merge-base", "--", caseSpec.baseRef, caseSpec.headRef], workspace, timeoutMs, environment);
    const mergeBase = merge.stdout.trim();
    if (merge.exitCode !== 0 || merge.timedOut || !/^[0-9a-f]{40}$/.test(mergeBase)) {
      return failed(`could not resolve a merge-base for the frozen range: ${merge.stderr.slice(0, 500)}`);
    }
    const headTreeRun = git(["-C", workspace, "rev-parse", "HEAD^{tree}"], workspace, timeoutMs, environment);
    const trackedFilesRun = git(["-C", workspace, "ls-files"], workspace, timeoutMs, environment);
    const trackedStageRun = git(["-C", workspace, "ls-files", "--stage"], workspace, timeoutMs, environment);
    const trackedFlagsRun = git(["-C", workspace, "ls-files", "-v"], workspace, timeoutMs, environment);
    const trackedStatusRun = git(["-C", workspace, "status", "--porcelain=v1", "--untracked-files=no"], workspace, timeoutMs, environment);
    const trackedFiles = trackedFilesRun.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
    if (
      headTreeRun.exitCode !== 0 || headTreeRun.timedOut || !/^[0-9a-f]{40}$/.test(headTreeRun.stdout.trim())
      || trackedFilesRun.exitCode !== 0 || trackedFilesRun.timedOut
      || trackedStageRun.exitCode !== 0 || trackedStageRun.timedOut
      || trackedFlagsRun.exitCode !== 0 || trackedFlagsRun.timedOut
      || trackedStatusRun.exitCode !== 0 || trackedStatusRun.timedOut || trackedStatusRun.stdout.length !== 0
    ) {
      return failed("could not establish a clean tracked checkout identity before candidate execution");
    }
    const gitIdentity: CaseGitIdentity = {
      baseRef: caseSpec.baseRef,
      headRef: caseSpec.headRef,
      mergeBase,
      range: `${mergeBase.slice(0, 12)}..${caseSpec.headRef.slice(0, 12)}`,
      headTree: headTreeRun.stdout.trim(),
      trackedFilesDigest: trackedCheckoutDigest(workspace, trackedFiles),
      trackedIndexDigest: digestCanonical({ stage: trackedStageRun.stdout, flags: trackedFlagsRun.stdout }),
    };
    const gitignorePath = join(workspace, ".gitignore");
    const expectedGitignore = computeGitignore(existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : undefined).content;
    const expectedPostInitTrackedFilesDigest = trackedFiles.includes(".gitignore")
      ? trackedCheckoutDigest(workspace, trackedFiles, new Map([[".gitignore", expectedGitignore]]))
      : gitIdentity.trackedFilesDigest;

    const diff = git(
      ["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-only", mergeBase, caseSpec.headRef, "--"],
      workspace,
      timeoutMs,
      environment,
    );
    if (diff.exitCode !== 0 || diff.timedOut) return failed(`git diff failed: ${diff.stderr.slice(0, 500)}`);
    const changedFiles = diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).sort();
    if (JSON.stringify(changedFiles) !== JSON.stringify(caseSpec.changedFiles)) {
      return failed("observed git diff does not match changedFiles bound by the frozen protocol");
    }

    const allFiles = discoverTypeScriptFiles(workspace, trackedFiles);
    const baselineStarted = performance.now();
    const changedFilesSuggested = changedFilesBaseline(changedFiles);
    const changedFilesAlgorithm = "changed-files-v1" as const;
    const baselineChangedFiles: BaselineCaseRun = {
      algorithm: changedFilesAlgorithm,
      suggestedFiles: changedFilesSuggested,
      durationMs: Math.round((performance.now() - baselineStarted) * 100) / 100,
      inputDigest: baselineInputDigest(changedFilesAlgorithm, gitIdentity, changedFiles),
      outputDigest: baselineOutputDigest(changedFilesAlgorithm, changedFilesSuggested),
    };

    const neighborhoodStarted = performance.now();
    const neighborhoodSuggested = oneHopImportNeighborhoodBaseline(workspace, changedFiles, allFiles);
    const neighborhoodAlgorithm = "one-hop-import-neighborhood-v1" as const;
    const baselineImportNeighborhood: BaselineCaseRun = {
      algorithm: neighborhoodAlgorithm,
      suggestedFiles: neighborhoodSuggested,
      durationMs: Math.round((performance.now() - neighborhoodStarted) * 100) / 100,
      inputDigest: baselineInputDigest(neighborhoodAlgorithm, gitIdentity, changedFiles),
      outputDigest: baselineOutputDigest(neighborhoodAlgorithm, neighborhoodSuggested),
    };

    const checkTrackedCheckout = (stage: string): string | null => {
      const observedHead = git(["-C", workspace, "rev-parse", "HEAD"], workspace, timeoutMs, environment);
      const observedTree = git(["-C", workspace, "rev-parse", "HEAD^{tree}"], workspace, timeoutMs, environment);
      const observedFiles = git(["-C", workspace, "ls-files"], workspace, timeoutMs, environment);
      const observedStage = git(["-C", workspace, "ls-files", "--stage"], workspace, timeoutMs, environment);
      const observedFlags = git(["-C", workspace, "ls-files", "-v"], workspace, timeoutMs, environment);
      const observedStatus = git(["-C", workspace, "status", "--porcelain=v1", "--untracked-files=no"], workspace, timeoutMs, environment);
      const observedUntracked = git(["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"], workspace, timeoutMs, environment);
      const observedIgnored = git(["-C", workspace, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], workspace, timeoutMs, environment);
      if ([observedHead, observedTree, observedFiles, observedStage, observedFlags, observedStatus, observedUntracked, observedIgnored]
        .some((run) => run.exitCode !== 0 || run.timedOut)) {
        return `disposable checkout could not be verified after candidate ${stage}`;
      }
      const observedTrackedFiles = observedFiles.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
      let observedTrackedFilesDigest: string;
      try {
        observedTrackedFilesDigest = trackedCheckoutDigest(workspace, observedTrackedFiles);
      } catch {
        return `disposable checkout changed after candidate ${stage}`;
      }
      const otherPaths = [...new Set([
        ...splitNullTerminatedPaths(observedUntracked.stdout),
        ...splitNullTerminatedPaths(observedIgnored.stdout),
      ])];
      const unexpectedPath = otherPaths.find((path) => {
        if (path === ".gitignore") {
          try {
            return readFileSync(gitignorePath, "utf8") !== expectedGitignore;
          } catch {
            return true;
          }
        }
        return !isConfinedMetadataPath(workspace, path);
      });
      if (
        observedHead.stdout.trim() !== gitIdentity.headRef
        || observedTree.stdout.trim() !== gitIdentity.headTree
        || (observedTrackedFilesDigest !== gitIdentity.trackedFilesDigest
          && observedTrackedFilesDigest !== expectedPostInitTrackedFilesDigest)
        || digestCanonical({ stage: observedStage.stdout, flags: observedFlags.stdout }) !== gitIdentity.trackedIndexDigest
        || unexpectedPath !== undefined
      ) {
        return `disposable checkout changed after candidate ${stage}`;
      }
      return null;
    };

    let sourceDriftReason: string | null = null;
    const runCandidate = (stage: string, args: readonly string[]): ToolInvocation => {
      assertImplementationIdentity();
      const invocation = toToolInvocation(runBounded([...candidateArgvPrefix, ...args, "--root", workspace], {
        cwd: workspace,
        timeoutMs,
        env: environment,
      }));
      assertImplementationIdentity();
      const observedDrift = checkTrackedCheckout(stage);
      sourceDriftReason ??= observedDrift;
      return invocation;
    };
    const init = runCandidate("init", ["init"]);
    const index = runCandidate("index", ["index"]);
    const verify = runCandidate("verify", ["verify", "diff", "--base", caseSpec.baseRef, "--head", caseSpec.headRef, "--format", "json"]);
    const verification = sourceDriftReason !== null
      ? { verdict: null, verificationStatus: "SOURCE_DRIFT" as const, suggestedFiles: [] }
      : init.exitCode !== 0 || index.exitCode !== 0 || init.timedOut || index.timedOut
      ? { verdict: null, verificationStatus: "PREREQUISITE_FAILED" as const, suggestedFiles: [] }
      : verify.timedOut
        ? { verdict: null, verificationStatus: "TIMED_OUT" as const, suggestedFiles: [] }
        : parseVerifyReport(verify.stdout, verify.exitCode, { ...gitIdentity, changedFiles: caseSpec.changedFiles });

    return {
      caseId: caseSpec.caseId,
      status: "OBSERVED",
      failureReason: null,
      git: gitIdentity,
      changedFiles,
      semctx: { init, index, verify, ...verification, sourceDriftReason },
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
  requireExactKeys(record, ["argv", "exitCode", "timedOut", "durationMs", "stdout", "stderr", "outputDigest"], path);
  const invocation = {
    argv: requireStringArray(record.argv, `${path}.argv`),
    exitCode: requireInteger(record.exitCode, `${path}.exitCode`),
    timedOut: requireBoolean(record.timedOut, `${path}.timedOut`),
    durationMs: requireFiniteNonNegative(record.durationMs, `${path}.durationMs`),
    stdout: requireString0(record.stdout, `${path}.stdout`),
    stderr: requireString0(record.stderr, `${path}.stderr`),
    outputDigest: requireSha256(record.outputDigest, `${path}.outputDigest`),
  };
  if (invocation.timedOut !== (invocation.exitCode === TIMED_OUT_EXIT_CODE)) {
    throw new PilotValidationError(path, `timedOut must be true exactly when exitCode is ${TIMED_OUT_EXIT_CODE}`);
  }
  if (invocation.outputDigest !== toolOutputDigest(invocation.stdout, invocation.stderr)) {
    throw new PilotValidationError(`${path}.outputDigest`, "does not match captured stdout and stderr");
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
      ["caseId", "status", "failureReason", "git", "changedFiles", "semctx", "baselineChangedFiles", "baselineImportNeighborhood"],
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
      if (caseRecord.git !== null || caseRecord.semctx !== null || caseRecord.baselineChangedFiles !== null || caseRecord.baselineImportNeighborhood !== null) {
        throw new PilotValidationError(`${path}.cases[${i}]`, "FAILED cases must not contain Git identity, tool, or baseline runs");
      }
      if (changedFiles.length !== 0) {
        throw new PilotValidationError(`${path}.cases[${i}].changedFiles`, "FAILED cases must not claim observed changed files");
      }
      return { caseId, status, failureReason, git: null, changedFiles, semctx: null, baselineChangedFiles: null, baselineImportNeighborhood: null };
    }
    if (failureReason !== null) {
      throw new PilotValidationError(`${path}.cases[${i}].failureReason`, "OBSERVED cases must have a null failureReason");
    }
    const gitRecord = requireRecord(caseRecord.git, `${path}.cases[${i}].git`);
    requireExactKeys(gitRecord, ["baseRef", "headRef", "mergeBase", "range", "headTree", "trackedFilesDigest", "trackedIndexDigest"], `${path}.cases[${i}].git`);
    const gitIdentity: CaseGitIdentity = {
      baseRef: requireGitSha(gitRecord.baseRef, `${path}.cases[${i}].git.baseRef`),
      headRef: requireGitSha(gitRecord.headRef, `${path}.cases[${i}].git.headRef`),
      mergeBase: requireGitSha(gitRecord.mergeBase, `${path}.cases[${i}].git.mergeBase`),
      range: requireString(gitRecord.range, `${path}.cases[${i}].git.range`),
      headTree: requireGitSha(gitRecord.headTree, `${path}.cases[${i}].git.headTree`),
      trackedFilesDigest: requireSha256(gitRecord.trackedFilesDigest, `${path}.cases[${i}].git.trackedFilesDigest`),
      trackedIndexDigest: requireSha256(gitRecord.trackedIndexDigest, `${path}.cases[${i}].git.trackedIndexDigest`),
    };
    const canonicalRange = `${gitIdentity.mergeBase.slice(0, 12)}..${gitIdentity.headRef.slice(0, 12)}`;
    if (gitIdentity.range !== canonicalRange) {
      throw new PilotValidationError(`${path}.cases[${i}].git.range`, "does not match the canonical merge-base..head range");
    }
    const semctxRecord = requireRecord(caseRecord.semctx, `${path}.cases[${i}].semctx`);
    requireExactKeys(
      semctxRecord,
      ["init", "index", "verify", "verdict", "verificationStatus", "sourceDriftReason", "suggestedFiles"],
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
        ["TRUSTED", "PREREQUISITE_FAILED", "TIMED_OUT", "MALFORMED_OUTPUT", "EXIT_MISMATCH", "DIFF_MISMATCH", "SOURCE_DRIFT"] as const,
        `${path}.cases[${i}].semctx.verificationStatus`,
      ),
      sourceDriftReason: semctxRecord.sourceDriftReason === null
        ? null
        : requireString(semctxRecord.sourceDriftReason, `${path}.cases[${i}].semctx.sourceDriftReason`),
      suggestedFiles: requireStringArray(semctxRecord.suggestedFiles, `${path}.cases[${i}].semctx.suggestedFiles`),
    };
    if ((semctx.verificationStatus === "SOURCE_DRIFT") !== (semctx.sourceDriftReason !== null)) {
      throw new PilotValidationError(`${path}.cases[${i}].semctx.sourceDriftReason`, "must be present exactly for SOURCE_DRIFT");
    }
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
      requireExactKeys(baselineRecord, ["algorithm", "suggestedFiles", "durationMs", "inputDigest", "outputDigest"], `${path}.cases[${i}].${key}`);
      const expectedAlgorithm = key === "baselineChangedFiles" ? "changed-files-v1" : "one-hop-import-neighborhood-v1";
      const algorithm = requireEnum(baselineRecord.algorithm, [expectedAlgorithm] as const, `${path}.cases[${i}].${key}.algorithm`);
      const suggestedFiles = requireStringArray(baselineRecord.suggestedFiles, `${path}.cases[${i}].${key}.suggestedFiles`);
      if (JSON.stringify(suggestedFiles) !== JSON.stringify([...new Set(suggestedFiles)].sort())) {
        throw new PilotValidationError(`${path}.cases[${i}].${key}.suggestedFiles`, "must be sorted and contain no duplicates");
      }
      return {
        algorithm,
        suggestedFiles,
        durationMs: requireFiniteNonNegative(baselineRecord.durationMs, `${path}.cases[${i}].${key}.durationMs`),
        inputDigest: requireSha256(baselineRecord.inputDigest, `${path}.cases[${i}].${key}.inputDigest`),
        outputDigest: requireSha256(baselineRecord.outputDigest, `${path}.cases[${i}].${key}.outputDigest`),
      };
    };
    return {
      caseId,
      status,
      failureReason,
      git: gitIdentity,
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
