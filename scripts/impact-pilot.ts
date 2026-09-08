#!/usr/bin/env bun
/**
 * HOK-633 / ADR 0019 local impact-pilot instrumentation.
 *
 * Subcommands: draft, freeze, collect, report. See docs/pilot/README.md for the full walkthrough.
 * No recruitment, no human events: this tool only ever produces automated local observations.
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasFlag, optionalFlag, parseFlags, requireFlag } from "./pilot/cli-args";
import { collectCases, validateLocalSourcesFile, validateRawCollectionBundle } from "./pilot/collect";
import { freezeProtocol, validateDraftProtocol, validateFrozenProtocol } from "./pilot/protocol";
import { buildPublicSummary, buildResultReport } from "./pilot/report";

const REPO_ROOT = resolve(import.meta.dir, "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Freeze/collect/report artifacts are immutable once written: never silently overwritten. */
export function writeJsonExclusive(path: string, value: unknown): void {
  const absolute = resolve(process.cwd(), path);
  const assertSafeDestination = (): void => {
    for (let cursor = absolute;; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        throw new Error(`refusing output through a symbolic link or junction: ${cursor}`);
      }
      if (cursor === dirname(cursor)) break;
    }
  };
  assertSafeDestination();
  if (lstatSync(absolute, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`refusing to overwrite existing file: ${absolute} (this tool never rewrites an artifact)`);
  }
  const tmp = resolve(dirname(absolute), `.${crypto.randomUUID()}.impact-pilot.tmp`);
  let handle: number | undefined;
  try {
    handle = openSync(tmp, "wx", 0o600);
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    // Linking is atomic and refuses an existing destination on every supported host.
    assertSafeDestination();
    linkSync(tmp, absolute);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function runDraft(args: readonly string[]): number {
  const flags = parseFlags(args, ["input", "out"]);
  const draft = validateDraftProtocol(readJson(requireFlag(flags, "input")));
  const outputPath = optionalFlag(flags, "out");
  if (outputPath !== undefined) {
    writeJsonExclusive(outputPath, draft);
    console.log(`[impact-pilot] draft valid -> ${outputPath}`);
  }
  console.log(`[impact-pilot] draft OK: kind=${draft.corpus.kind} cases=${draft.corpus.cases.length}`);
  return 0;
}

function runFreeze(args: readonly string[]): number {
  const flags = parseFlags(args, ["input", "out"]);
  const draft = validateDraftProtocol(readJson(requireFlag(flags, "input")));
  const frozen = freezeProtocol(draft, REPO_ROOT);
  writeJsonExclusive(requireFlag(flags, "out"), frozen);
  console.log(`[impact-pilot] frozen experimentId=${frozen.experimentId} digest=${frozen.digest}`);
  return 0;
}

function runCollect(args: readonly string[]): number {
  const flags = parseFlags(args, ["protocol", "sources", "out"]);
  const protocol = validateFrozenProtocol(readJson(requireFlag(flags, "protocol")));
  const sources = validateLocalSourcesFile(readJson(requireFlag(flags, "sources")));
  const bundle = collectCases(protocol, sources, REPO_ROOT);
  writeJsonExclusive(requireFlag(flags, "out"), bundle);
  const observed = bundle.cases.filter((c) => c.status === "OBSERVED").length;
  const failed = bundle.cases.length - observed;
  console.log(`[impact-pilot] collected ${bundle.cases.length} cases (${observed} observed, ${failed} failed)`);
  return 0;
}

function runReport(args: readonly string[]): number {
  const flags = parseFlags(args, ["protocol", "raw", "out", "export"], ["preview"]);
  const preview = hasFlag(flags, "preview");
  for (const outputFlag of ["out", "export"] as const) {
    if (preview && flags.has(outputFlag)) {
      throw new Error(`--preview cannot be combined with --${outputFlag}`);
    }
  }
  const protocol = validateFrozenProtocol(readJson(requireFlag(flags, "protocol")));
  const raw = validateRawCollectionBundle(readJson(requireFlag(flags, "raw")));
  const report = buildResultReport(protocol, raw);

  const outputPath = optionalFlag(flags, "out");
  if (outputPath !== undefined) writeJsonExclusive(outputPath, report);

  const exportPath = optionalFlag(flags, "export");
  if (exportPath !== undefined) writeJsonExclusive(exportPath, buildPublicSummary(protocol, report));

  if (preview) {
    console.log(JSON.stringify(buildPublicSummary(protocol, report), null, 2));
  } else if (outputPath === undefined && exportPath === undefined) {
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(`[impact-pilot] verdict=${report.verdict} evidenceKind=${report.evidenceKind}`);
  return report.verdict === "NEGATIVE" ? 1 : 0;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "draft":
        return runDraft(rest);
      case "freeze":
        return runFreeze(rest);
      case "collect":
        return runCollect(rest);
      case "report":
        return runReport(rest);
      default:
        console.error(
          "usage: bun scripts/impact-pilot.ts <draft|freeze|collect|report> [options]\n"
            + "see docs/pilot/README.md",
        );
        return command === undefined ? 1 : 2;
    }
  } catch (error) {
    console.error(`[impact-pilot] ERROR ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
