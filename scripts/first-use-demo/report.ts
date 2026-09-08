/** Render the concise Markdown report from a completed or blocked demo outcome. Real data only. */

import type { DemoOutcome } from "./runner";

function verdictLine(outcome: DemoOutcome): string {
  if (outcome.verdict === null) return "_no verdict — the run did not complete a verification._";
  return `**${outcome.verdict}**`;
}

function caseSection(outcome: DemoOutcome): string {
  if (outcome.cases.length === 0) return "";
  const lines: string[] = ["## Cases"];
  for (const c of outcome.cases) {
    lines.push("");
    lines.push(`### ${c.title} (\`${c.relPath}\`)`);
    lines.push("");
    lines.push(c.explanation);
    lines.push("");
    lines.push(`- Documented expectation: **${c.expectedFinding === "none" ? "no finding" : "advisory WARN"}**`);
    lines.push(
      `- Observed rule(s) on this file: ${c.observedRules.length === 0 ? "none" : c.observedRules.map((r) => `\`${r}\``).join(", ")}`,
    );
    lines.push(`- Matches documented expectation: ${c.matchedExpectation ? "yes" : "**no — see raw evidence below**"}`);
    lines.push(`- Next check: ${c.nextCheck}`);
  }
  return lines.join("\n");
}

function recipeSection(): string {
  return `## Prerequisites

- \`bun\` on \`PATH\` (the packaged CLI runs as \`bun <dist/index.js> <args>\`).
- \`git\` on \`PATH\` (the fixture repository is real, disposable, and built with real Git commands).

## Recipes

Build the packaged CLI once, then point this demo at the built bundle. Always use a **new**
output directory. Existing destinations, links and junctions are rejected:

\`\`\`sh
bun run cli:build
bun scripts/first-use-demo.ts --cli apps/cli/dist/index.js --out .tmp/first-use-demo
\`\`\`

Run it from a fresh Codex or Claude Code session the same way — this tool takes no session
state and installs nothing; it only spawns the packaged CLI you point it at.

## Limitations

- One combined analysis covers three changes; it does not return separate verdicts per file.
- Absence of a finding is not a claim that the change is correct — see the "unsupported/unproven
  limit" case above for a real example of a change this version of semctx cannot see.
- \`documented expectation\` above describes what this demo's own authored tests assert against
  the real packaged CLI output; it is a claim about this fixture, not a general product guarantee.
- Test links are suggestions, not proof of coverage: \`scripts/first-use-demo.test.ts\` exercises
  this exact pipeline, but reading it is not the same as having run it yourself.
`;
}

export function renderReportMarkdown(outcome: DemoOutcome): string {
  const lines: string[] = [];
  lines.push("# semctx first-use demo");
  lines.push("");
  lines.push(`Generated: ${outcome.createdAt}`);
  lines.push("");
  lines.push(`Status: **${outcome.status}**${outcome.reason !== null ? ` (${outcome.reason})` : ""}`);
  if (outcome.detail !== null) {
    lines.push("");
    lines.push(outcome.detail);
  }
  lines.push("");
  lines.push("## Artifact identity");
  lines.push("");
  lines.push(`- CLI path: \`${outcome.cli.cliPath}\``);
  lines.push(
    `- CLI sha256: ${outcome.cli.cli.present ? `\`${outcome.cli.cli.sha256}\` (${outcome.cli.cli.sizeBytes} bytes)` : "UNKNOWN (file absent)"}`,
  );
  lines.push(
    `- Index worker sha256: ${outcome.cli.indexWorker?.present === true ? `\`${outcome.cli.indexWorker.sha256}\`` : "UNKNOWN (not colocated)"}`,
  );
  lines.push(`- Build/source provenance: \`${outcome.cli.sourceProvenance}\` (UNKNOWN unless proven; never a verified build binding)`);
  lines.push(`- Authenticated source: **UNKNOWN**. Caller labels and self-reported versions do not authenticate a release.`);
  lines.push(`- Reported package version: \`${outcome.packageVersion ?? "UNKNOWN"}\``);
  lines.push(`- Complete runtime digest: \`${outcome.cli.runtimeDigest ?? "UNKNOWN"}\` (${outcome.cli.runtimeFiles.length} files, including support libraries)`);
  lines.push(`- Fixture base digest: \`${outcome.fixture.baseDigest}\``);
  lines.push(`- Fixture changed digest: \`${outcome.fixture.changedDigest}\``);
  lines.push(`- Fixture Git HEAD: ${outcome.fixtureHeadCommit !== null ? `\`${outcome.fixtureHeadCommit}\`` : "UNKNOWN"}`);
  lines.push(`- Working diff digest: \`${outcome.workingDiffDigest ?? "UNKNOWN"}\` (uncommitted changes, no invented head commit)`);
  lines.push("");
  lines.push("## Real commands run");
  lines.push("");
  if (outcome.commands.length === 0) lines.push("_none — the run was blocked before any command._");
  for (const cmd of outcome.commands) {
    lines.push(`- \`${cmd.argv.join(" ")}\` → exit \`${cmd.code}\`, signal \`${cmd.signal ?? "none"}\`, ${cmd.durationMs.toFixed(3)} ms (raw: \`${cmd.stdoutFile}\`, \`${cmd.stderrFile}\`)`);
  }
  lines.push("- Artifact download: not performed or measured; the caller supplied the prebuilt CLI.");
  lines.push("");
  lines.push(`## Global verdict for the combined diff`);
  lines.push("");
  lines.push(verdictLine(outcome));
  lines.push("", "## Product uncertainty", "");
  lines.push(...(outcome.unknowns.length > 0 ? outcome.unknowns.map(u => `- ${u}`) : ["No unknowns reported by this execution. This is not proof of runtime correctness."]));
  lines.push("");
  const cases = caseSection(outcome);
  if (cases.length > 0) {
    lines.push(cases);
    lines.push("");
  }
  lines.push(recipeSection());
  return lines.join("\n");
}
