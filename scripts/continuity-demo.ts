#!/usr/bin/env bun
/**
 * `bun scripts/continuity-demo.ts --cli <packaged CLI path> --out <new output dir>`
 *
 * HOK-641 / ADR 0027: run the packaged semctx CLI through a disposable, fixture-authored
 * repository that exercises task creation, framing/planning a change, read-only reconciliation,
 * capturing a Control Handoff v2 capsule, explaining it, mutating source bytes, explaining the
 * resulting staleness, observing a refused resume, and restoring the source exactly. Raw
 * stdout/stderr/exit results and a machine-readable manifest are written under `--out`.
 *
 * `--cli` must be an explicit path to a semctx CLI entry point (e.g. `apps/cli/dist/index.js`
 * after `bun run cli:build`). This tool never resolves a global or PATH-installed CLI.
 */

import { runContinuityDemo } from "./continuity-demo/runner";

interface Options {
  cli?: string;
  out?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!["--cli", "--out"].includes(token ?? "") || argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${token}`);
    if (token === "--cli") options.cli = argv[++i];
    else options.out = argv[++i];
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.cli === undefined || options.out === undefined) {
    process.stderr.write("usage: bun scripts/continuity-demo.ts --cli <packaged CLI path> --out <new output dir>\n");
    process.exit(2);
  }

  const outcome = runContinuityDemo({ cliPath: options.cli, outDir: options.out });

  process.stdout.write(`status: ${outcome.status}${outcome.reason !== null ? ` (${outcome.reason})` : ""}\n`);
  if (outcome.detail !== null) process.stdout.write(`${outcome.detail}\n`);
  if (outcome.initialReconciliation !== null) process.stdout.write(`initial reconciliation: ${outcome.initialReconciliation.terminalStatus}\n`);
  process.stdout.write(`output: ${outcome.outDir}\n`);

  process.exit(outcome.status === "COMPLETED" ? 0 : 1);
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Demo failed"}\n`); process.exitCode = 1; }
