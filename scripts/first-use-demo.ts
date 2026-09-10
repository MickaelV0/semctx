#!/usr/bin/env bun
/**
 * `bun scripts/first-use-demo.ts --cli <packaged CLI path> --out <new output dir>`
 *
 * HOK-632 / ADR 0018: run the packaged semctx CLI against a frozen, unauthored fixture that
 * exercises three fixed changes (benign, exported-contract risk, explicit unsupported limit),
 * and produce raw evidence plus a concise Markdown report under `--out`.
 *
 * `--cli` must be an explicit path to a built CLI bundle (e.g. `apps/cli/dist/index.js` after
 * `bun run cli:build`). This tool never resolves a global or PATH-installed CLI.
 */

import { runFirstUseDemo } from "./first-use-demo/runner";

interface Options {
  cli?: string;
  out?: string;
  source?: string;
  expectedArtifactDigest?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!["--cli", "--out", "--source", "--expect-digest"].includes(token ?? "") || argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${token}`);
    if (token === "--cli") options.cli = argv[++i];
    else if (token === "--out") options.out = argv[++i];
    else if (token === "--source") options.source = argv[++i];
    else if (token === "--expect-digest") options.expectedArtifactDigest = argv[++i];
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.cli === undefined || options.out === undefined) {
    process.stderr.write(
      "usage: bun scripts/first-use-demo.ts --cli <packaged CLI path> --out <new output dir> [--source <unverified label>] [--expect-digest <sha256>]\n",
    );
    process.exit(2);
  }

  const outcome = runFirstUseDemo({
    cliPath: options.cli,
    outDir: options.out,
    expectedArtifactDigest: options.expectedArtifactDigest,
    sourceProvenance: options.source,
  });

  process.stdout.write(`status: ${outcome.status}${outcome.reason !== null ? ` (${outcome.reason})` : ""}\n`);
  if (outcome.detail !== null) process.stdout.write(`${outcome.detail}\n`);
  if (outcome.verdict !== null) process.stdout.write(`verdict: ${outcome.verdict}\n`);
  process.stdout.write(`output: ${outcome.outDir}\n`);

  process.exit(outcome.status === "COMPLETED" ? 0 : 1);
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Demo failed"}\n`); process.exitCode = 1; }
