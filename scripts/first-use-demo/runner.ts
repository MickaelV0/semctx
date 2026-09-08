/**
 * The first-use demo runner (ADR 0018 / HOK-632). Orchestrates a real packaged CLI against a
 * frozen, unauthored fixture and produces raw evidence plus a concise Markdown report.
 *
 * Boundaries this file exists to hold:
 *  - Never replace existing output, even when it resembles this tool's own manifest.
 *  - Every command is a real child process; every captured code/stdout/stderr is verbatim.
 *  - A missing case, a malformed report, or an unexpected child exit is `BLOCKED`, never a
 *    fabricated `COMPLETED`. Documented per-case expectations never rewrite what the packaged CLI
 *    said, but a mismatch keeps the frozen demonstration incomplete.
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { VerifyReportSchema, type VerdictLevel, type VerifyReport } from "@semantic-context/core";
import {
  FIXTURE_CASES,
  baseFixtureFiles,
  changedFixtureFiles,
  type FixtureCaseId,
} from "./fixture";
import { identifyFixture, identifyPackagedCli, sha256Hex, type FixtureIdentity, type PackagedCliIdentity } from "./identity";
import { runGit, runPackagedCli, type ChildOutcome } from "./process";
import { renderReportMarkdown } from "./report";

export const MANIFEST_FILENAME = "first-use-demo-manifest.json";
export const MANIFEST_KIND = "semctx-first-use-demo-manifest-v1";

export type DemoBlockReason =
  | "CLI_ARTIFACT_MISSING"
  | "ARTIFACT_DRIFT"
  | "INVALID_OUTPUT_PATH"
  | "INDEX_CHILD_FAILED"
  | "OUTPUT_EXISTS_NOT_EMPTY"
  | "FIXTURE_GIT_INIT_FAILED"
  | "FIXTURE_GIT_IDENTITY_FAILED"
  | "SETUP_CHILD_FAILED"
  | "SETUP_OUTPUT_MALFORMED"
  | "SETUP_NOT_READY"
  | "VERIFY_CHILD_UNEXPECTED_EXIT"
  | "VERIFY_OUTPUT_MALFORMED"
  | "VERIFY_OUTPUT_INCOMPLETE"
  | "UNEXPECTED_ANALYSIS"
  | "FIXTURE_DRIFT";

export interface RecordedCommand {
  label: "version" | "setup" | "index" | "verify-diff";
  argv: readonly string[];
  code: number;
  stdoutFile: string;
  stderrFile: string;
}

export interface CaseOutcome {
  id: FixtureCaseId;
  title: string;
  relPath: string;
  expectedFinding: "none" | "warn";
  observedRules: string[];
  /** Whether the packaged CLI's real output matched this case's documented expectation. */
  matchedExpectation: boolean;
  explanation: string;
  nextCheck: string;
}

export interface DemoOutcome {
  status: "COMPLETED" | "BLOCKED";
  reason: DemoBlockReason | null;
  detail: string | null;
  createdAt: string;
  outDir: string;
  cli: PackagedCliIdentity;
  fixture: FixtureIdentity;
  fixtureHeadCommit: string | null;
  commands: RecordedCommand[];
  /** The raw product verdict. Never rewritten to match a documented expectation. */
  verdict: VerdictLevel | null;
  cases: CaseOutcome[];
  unknowns: string[];
  workingDiffDigest: string | null;
  packageVersion: string | null;
}

export interface RunFirstUseDemoOptions {
  cliPath: string;
  outDir: string;
  expectedArtifactDigest?: string;
  /** Caller-asserted CLI build/source label. Never treated as a verified build binding. */
  sourceProvenance?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface PreparedOutput {
  ok: boolean;
  reason?: DemoBlockReason;
  detail?: string;
}

/** Reserve a new destination without trusting a previous manifest as deletion authority. */
function prepareOutputDir(outDir: string): PreparedOutput {
  for (let cursor = outDir;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return { ok: false, reason: "INVALID_OUTPUT_PATH", detail: "Output and its ancestors must not be symbolic links or junctions." };
    if (cursor === outDir && stat !== undefined) return { ok: false, reason: "OUTPUT_EXISTS_NOT_EMPTY", detail: "Choose a new output directory; existing destinations are preserved." };
    if (cursor === dirname(cursor)) break;
  }
  try {
    mkdirSync(dirname(outDir), { recursive: true });
    mkdirSync(outDir);
    return { ok: true };
  } catch {
    return { ok: false, reason: "INVALID_OUTPUT_PATH", detail: "Could not create the new output directory." };
  }
}

function writeFixtureFiles(root: string, files: ReadonlyMap<string, string>): void {
  for (const [relPath, content] of files) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the public fields consumed here; this is not source authentication. */
export function asVerifyReport(value: unknown, exitCode: number): VerifyReport | null {
  const parsed = VerifyReportSchema.safeParse(value);
  if (!parsed.success) return null;
  const report = parsed.data;
  const blocks = report.findings.filter(f => f.severity === "block").length;
  const warns = report.findings.filter(f => f.severity === "warn").length;
  if (report.summary.blockCount !== blocks || report.summary.warnCount !== warns) return null;
  if (report.verdict !== (blocks > 0 ? "BLOCK" : warns > 0 ? "WARN" : "PASS")) return null;
  if (exitCode !== (blocks > 0 ? 3 : 0)) return null;
  return report;
}

function writeRaw(outDir: string, name: string, content: string): string {
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const path = join(rawDir, name);
  writeFileSync(path, content, "utf8");
  return join("raw", name);
}

function recordCommand(
  outDir: string,
  label: RecordedCommand["label"],
  outcome: ChildOutcome,
): RecordedCommand {
  const stdoutFile = writeRaw(outDir, `${label}.stdout.txt`, outcome.stdout);
  const stderrFile = writeRaw(outDir, `${label}.stderr.txt`, outcome.stderr);
  return { label, argv: outcome.argv, code: outcome.code, stdoutFile, stderrFile };
}

function blocked(
  base: Pick<DemoOutcome, "createdAt" | "outDir" | "cli" | "fixture" | "commands">,
  reason: DemoBlockReason,
  detail: string,
  fixtureHeadCommit: string | null = null,
): DemoOutcome {
  return {
    ...base,
    status: "BLOCKED",
    reason,
    detail,
    fixtureHeadCommit,
    verdict: null,
    cases: [],
    unknowns: [],
    workingDiffDigest: null,
    packageVersion: null,
  };
}

/** Write the rendered report next to the manifest. Only called once `outDir` is safe to write into. */
function finish(outcome: DemoOutcome): DemoOutcome {
  writeFileSync(join(outcome.outDir, MANIFEST_FILENAME), `${JSON.stringify({ kind: MANIFEST_KIND, ...outcome }, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(outcome.outDir, "report.md"), renderReportMarkdown(outcome), "utf8");
  return outcome;
}

export function runFirstUseDemo(options: RunFirstUseDemoOptions): DemoOutcome {
  const createdAt = nowIso();
  const outDir = resolve(options.outDir);
  const cliPath = resolve(options.cliPath);
  const cli = identifyPackagedCli(cliPath, options.sourceProvenance);
  const fixture = identifyFixture(baseFixtureFiles(), changedFixtureFiles());
  const emptyBase = { createdAt, outDir, cli, fixture, commands: [] as RecordedCommand[] };

  if (!cli.cli.present) {
    return blocked(emptyBase, "CLI_ARTIFACT_MISSING", `No file at "${cliPath}".`);
  }

  if (options.expectedArtifactDigest !== undefined && options.expectedArtifactDigest !== cli.runtimeDigest) return blocked(emptyBase, "ARTIFACT_DRIFT", "The selected artifact does not match the expected runtime digest.");
  const prepared = prepareOutputDir(outDir);
  if (!prepared.ok) {
    return blocked(emptyBase, prepared.reason!, prepared.detail!);
  }

  const tmpBase = realpathSync(tmpdir());
  const fixtureDir = mkdtempSync(join(tmpBase, "semctx-first-use-demo-"));
  const commands: RecordedCommand[] = [];
  try {
    writeFixtureFiles(fixtureDir, baseFixtureFiles());

    const gitInit = runGit(["init", "-q"], fixtureDir);
    const gitAdd = gitInit.code === 0 ? runGit(["add", "."], fixtureDir) : gitInit;
    const gitCommit = gitAdd.code === 0
      ? runGit(
          ["-c", "user.name=Semctx First-Use Demo", "-c", "user.email=semctx-demo@example.invalid", "commit", "-q", "-m", "base fixture"],
          fixtureDir,
        )
      : gitAdd;
    if (gitCommit.code !== 0) {
      return finish(blocked(
        { ...emptyBase, commands },
        "FIXTURE_GIT_INIT_FAILED",
        `git init/add/commit failed in the fixture repository: ${gitCommit.stderr.trim()}`,
      ));
    }
    const headCommit = runGit(["rev-parse", "HEAD"], fixtureDir);
    const fixtureHeadCommit = headCommit.stdout.trim();
    if (headCommit.code !== 0 || !/^[0-9a-f]{40}$/.test(fixtureHeadCommit)) {
      return finish(blocked(
        { ...emptyBase, commands },
        "FIXTURE_GIT_IDENTITY_FAILED",
        "Could not record the fixture repository's complete Git HEAD identity.",
      ));
    }

    const version = runPackagedCli(cliPath, ["--version"], fixtureDir);
    commands.push(recordCommand(outDir, "version", version));
    if (version.code !== 0 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.stdout.trim())) return finish(blocked({ ...emptyBase, commands }, "SETUP_OUTPUT_MALFORMED", "The selected CLI did not return a package version.", fixtureHeadCommit));

    const setupOutcome = runPackagedCli(cliPath, ["setup", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "setup", setupOutcome));
    if (setupOutcome.code !== 0) {
      return finish(blocked(
        { ...emptyBase, commands },
        "SETUP_CHILD_FAILED",
        `"semctx setup --json" exited ${setupOutcome.code}.`,
        fixtureHeadCommit,
      ));
    }
    const setupJson = parseJsonOrNull(setupOutcome.stdout);
    if (!isPlainObject(setupJson) || typeof setupJson["setupReady"] !== "boolean") {
      return finish(blocked(
        { ...emptyBase, commands },
        "SETUP_OUTPUT_MALFORMED",
        `"semctx setup --json" did not print a recognizable setup report on stdout.`,
        fixtureHeadCommit,
      ));
    }
    if (setupJson["setupReady"] !== true) {
      return finish(blocked(
        { ...emptyBase, commands },
        "SETUP_NOT_READY",
        `Fixture repository did not reach setupReady=true.`,
        fixtureHeadCommit,
      ));
    }

    writeFixtureFiles(fixtureDir, changedFixtureFiles());

    const index = runPackagedCli(cliPath, ["index", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "index", index));
    if (index.code !== 0 || !isPlainObject(parseJsonOrNull(index.stdout))) return finish(blocked({ ...emptyBase, commands }, "INDEX_CHILD_FAILED", "Indexing did not complete with a JSON result.", fixtureHeadCommit));
    const diff = runGit(["diff", "HEAD", "--no-ext-diff", "--binary"], fixtureDir);
    const names = runGit(["diff", "HEAD", "--name-only", "-z"], fixtureDir);
    if (diff.code !== 0 || names.code !== 0) return finish(blocked({ ...emptyBase, commands }, "FIXTURE_DRIFT", "Could not identify the working diff.", fixtureHeadCommit));
    const workingDiffDigest = sha256Hex(diff.stdout);

    const verifyOutcome = runPackagedCli(cliPath, ["verify", "diff", "--root", fixtureDir, "--json"], fixtureDir);
    commands.push(recordCommand(outDir, "verify-diff", verifyOutcome));
    // BLOCK (exit 3, default --fail-on block) is a legitimate product outcome here, not a runner
    // failure: only an exit code outside {0, 3} means the child did not complete a real analysis.
    if (verifyOutcome.code !== 0 && verifyOutcome.code !== 3) {
      return finish(blocked(
        { ...emptyBase, commands },
        "VERIFY_CHILD_UNEXPECTED_EXIT",
        `"semctx verify diff --json" exited ${verifyOutcome.code} (expected 0 or 3).`,
        fixtureHeadCommit,
      ));
    }
    const verifyJson = parseJsonOrNull(verifyOutcome.stdout);
    if (verifyJson === null) {
      return finish(blocked(
        { ...emptyBase, commands },
        "VERIFY_OUTPUT_MALFORMED",
        `"semctx verify diff --json" did not print valid JSON on stdout.`,
        fixtureHeadCommit,
      ));
    }
    const report = asVerifyReport(verifyJson, verifyOutcome.code);
    if (report === null) {
      return finish(blocked(
        { ...emptyBase, commands },
        "VERIFY_OUTPUT_INCOMPLETE",
        `"semctx verify diff --json" output is missing required VerifyReport fields.`,
        fixtureHeadCommit,
      ));
    }

    const changedFiles = new Set((report.changedFiles as unknown[]).filter((v): v is string => typeof v === "string"));
    const expectedPaths = FIXTURE_CASES.map((c) => c.file.relPath);
    const missing = expectedPaths.filter((p) => !changedFiles.has(p));
    const actualPaths = names.stdout.split("\0").filter(Boolean).sort();
    if (missing.length > 0 || JSON.stringify([...report.changedFiles].sort()) !== JSON.stringify([...expectedPaths].sort()) || JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort()) || report.base !== null || report.head !== "HEAD" || report.range !== null || report.mergeBase !== null) {
      return finish(blocked(
        { ...emptyBase, commands },
        "FIXTURE_DRIFT",
        `The verify report's changedFiles is missing case file(s): ${missing.join(", ")}.`,
        fixtureHeadCommit,
      ));
    }

    const fileById = new Map<string, string>();
    for (const symbol of report.changedSymbols as unknown[]) {
      if (!isPlainObject(symbol)) continue;
      const id = symbol["id"];
      const file = symbol["file"];
      if (typeof id === "string" && typeof file === "string") fileById.set(id, file);
    }

    const findings = (report.findings as unknown[]).filter(isPlainObject);
    const cases: CaseOutcome[] = FIXTURE_CASES.map((fixtureCase) => {
      const observedRules = new Set<string>();
      for (const finding of findings) {
        const nodeIds = finding["nodeIds"];
        const rule = finding["rule"];
        if (!Array.isArray(nodeIds) || typeof rule !== "string") continue;
        const touchesCase = nodeIds.some((id) => typeof id === "string" && fileById.get(id) === fixtureCase.file.relPath);
        if (touchesCase) observedRules.add(rule);
      }
      const observed = [...observedRules].sort();
      const matchedExpectation = fixtureCase.expectedFinding === "none"
        ? observed.length === 0
        : observed.includes("contract_changed_without_test");
      return {
        id: fixtureCase.id,
        title: fixtureCase.title,
        relPath: fixtureCase.file.relPath,
        expectedFinding: fixtureCase.expectedFinding,
        observedRules: observed,
        matchedExpectation,
        explanation: fixtureCase.explanation,
        nextCheck: fixtureCase.nextCheck,
      };
    });

    if (identifyPackagedCli(cliPath).runtimeDigest !== cli.runtimeDigest) return finish(blocked({ ...emptyBase, commands }, "ARTIFACT_DRIFT", "Runtime bytes changed during execution.", fixtureHeadCommit));
    const finalHead = runGit(["rev-parse", "HEAD"], fixtureDir);
    const finalDiff = runGit(["diff", "HEAD", "--no-ext-diff", "--binary"], fixtureDir);
    if (finalHead.code !== 0 || finalHead.stdout.trim() !== fixtureHeadCommit || finalDiff.code !== 0 || sha256Hex(finalDiff.stdout) !== workingDiffDigest) return finish(blocked({ ...emptyBase, commands }, "FIXTURE_DRIFT", "Fixture Git HEAD or working diff changed during execution.", fixtureHeadCommit));

    const unexpectedCases = cases.filter(fixtureCase => !fixtureCase.matchedExpectation);
    if (unexpectedCases.length > 0) {
      return finish(blocked(
        { ...emptyBase, commands },
        "UNEXPECTED_ANALYSIS",
        `The selected CLI did not reproduce the frozen expectation for: ${unexpectedCases.map(item => item.id).join(", ")}.`,
        fixtureHeadCommit,
      ));
    }

    return finish({
      status: "COMPLETED",
      reason: null,
      detail: null,
      createdAt,
      outDir,
      cli,
      fixture,
      fixtureHeadCommit,
      commands,
      verdict: report.verdict as VerdictLevel,
      cases,
      unknowns: report.unknowns,
      workingDiffDigest,
      packageVersion: version.stdout.trim(),
    });
  } finally {
    // Runner-created temp directory only: never touch outDir or anything the caller supplied.
    const confined = relative(tmpBase, fixtureDir);
    if (confined.startsWith("semctx-first-use-demo-") && !confined.includes("/") && !confined.includes("\\") && !lstatSync(fixtureDir).isSymbolicLink()) rmSync(fixtureDir, { recursive: true, force: true });
  }
}
