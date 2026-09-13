/** Render the concise Markdown report from a completed or blocked continuity demo run. */

import type { ContinuityDemoOutcome } from "./runner";

export function renderContinuityReport(outcome: ContinuityDemoOutcome): string {
  const lines: string[] = [];
  lines.push("# semctx continuity demo");
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
  lines.push(`- CLI sha256: ${outcome.cli.cli.present ? `\`${outcome.cli.cli.sha256}\` (${outcome.cli.cli.sizeBytes} bytes)` : "UNKNOWN (file absent)"}`);
  lines.push(`- Complete runtime digest: \`${outcome.cli.runtimeDigest ?? "UNKNOWN"}\` (${outcome.cli.runtimeFiles.length} files)`);
  lines.push(`- Fixture Git HEAD: ${outcome.fixtureHeadCommit !== null ? `\`${outcome.fixtureHeadCommit}\`` : "UNKNOWN"}`);
  lines.push("");
  lines.push("### Base fixture files (fixture-relative path, sha256)");
  lines.push("");
  if (outcome.fixtureFiles.length === 0) lines.push("_none recorded._");
  for (const file of outcome.fixtureFiles) lines.push(`- \`${file.relPath}\`: \`${file.sha256}\``);
  lines.push("");
  lines.push("## Recorded commands");
  lines.push("");
  if (outcome.commands.length === 0) lines.push("_No command evidence was recorded._");
  for (const cmd of outcome.commands) {
    lines.push(`- \`${cmd.argv.join(" ")}\` → exit \`${cmd.code}\`, signal \`${cmd.signal ?? "none"}\`, ${cmd.durationMs.toFixed(3)} ms (raw: \`${cmd.stdoutFile}\`, \`${cmd.stderrFile}\`)`);
  }
  lines.push("");
  lines.push("## Journey facts");
  lines.push("");
  lines.push(`- Discovered coordinate: ${outcome.discoveredCoordinateId !== null ? `\`${outcome.discoveredCoordinateId}\`` : "UNKNOWN"} (path \`${outcome.discoveredRepositoryPath ?? "UNKNOWN"}\`)`);
  lines.push(`- Discovery evidence id: ${outcome.discoveryEvidenceId !== null ? `\`${outcome.discoveryEvidenceId}\`` : "UNKNOWN"}`);
  lines.push(`- Task frame: ${outcome.taskFrameId !== null ? `\`${outcome.taskFrameId}\`` : "UNKNOWN"}`);
  lines.push(`- Change contract: ${outcome.changeId !== null ? `\`${outcome.changeId}\`` : "UNKNOWN"}`);
  lines.push(
    `- Initial reconciliation (before any edit): ${
      outcome.initialReconciliation !== null
        ? `**${outcome.initialReconciliation.terminalStatus}**${outcome.initialReconciliation.primaryReason !== null ? ` (${outcome.initialReconciliation.primaryReason})` : ""}`
        : "UNKNOWN"
    } — a real product verdict, never relabeled as success.`,
  );
  lines.push(`- Captured capsule: ${outcome.capsuleHash !== null ? `\`${outcome.capsuleHash}\`` : "UNKNOWN"}`);
  lines.push(`- Gate admission: ${outcome.gateAdmission ?? "UNKNOWN"}`);
  lines.push(`- Execution authority: ${outcome.executionAuthority ?? "UNKNOWN"}`);
  lines.push(`- Independent user pilot: ${outcome.independentUserPilot}`);
  lines.push(
    `- Explain before mutation: ${outcome.explainBeforeMutation !== null ? `**${outcome.explainBeforeMutation.status}**, diff dependency **${outcome.explainBeforeMutation.diffStatus ?? "UNKNOWN"}**/**${outcome.explainBeforeMutation.diffClosedReason ?? "UNKNOWN"}**` : "UNKNOWN"}`,
  );
  lines.push(
    `- Explain after mutation: ${outcome.explainAfterMutation !== null ? `**${outcome.explainAfterMutation.status}**, diff dependency **${outcome.explainAfterMutation.diffStatus ?? "UNKNOWN"}**/**${outcome.explainAfterMutation.diffClosedReason ?? "UNKNOWN"}**` : "UNKNOWN"}`,
  );
  lines.push(
    `- Resume after mutation: ${outcome.resumeAfterMutation !== null ? `**${outcome.resumeAfterMutation.status}** (${outcome.resumeAfterMutation.reasonCodes.join(", ") || "no reason codes"})` : "UNKNOWN"}`,
  );
  lines.push(`- Source bytes restored exactly: ${outcome.sourceBytesRestored === null ? "UNKNOWN" : outcome.sourceBytesRestored ? "yes" : "**no**"}`);
  if (outcome.sourceRestoreError !== null) lines.push(`- Source restore detail: ${outcome.sourceRestoreError}`);
  lines.push(`- Capsule bytes unchanged across the whole run: ${outcome.capsuleBytesUnchangedAcrossMutation === null ? "UNKNOWN" : outcome.capsuleBytesUnchangedAcrossMutation ? "yes" : "**no**"}`);
  lines.push("");
  lines.push(recipeSection());
  return lines.join("\n");
}

function recipeSection(): string {
  return `## Prerequisites

- \`bun\` on \`PATH\` (the packaged CLI runs as \`bun <cli path> <args>\`).
- \`git\` on \`PATH\` (the fixture repository is real, disposable, and built with real Git commands).

## Recipes

Build the packaged CLI once, then point this demo at the built bundle. Always use a **new**
output directory. Existing destinations, links and junctions are rejected:

\`\`\`sh
bun run cli:build
bun scripts/continuity-demo.ts --cli apps/cli/dist/index.js --out .tmp/continuity-demo
\`\`\`

## Limitations

- The initial reconciliation is expected to report a real, non-\`REALIZED\` verdict: the demo
  never performs the planned repository edit, so absence of that edit is a genuine product
  finding, not a bug in this demo.
- \`gateAdmission: NOT_EVALUATED\` and \`executionAuthority: none\` throughout this journey mean
  no step here authorizes or performs an autonomous write.
- This demo proves reproducibility and honest state reporting; it does not measure independent
  human comprehension, adoption, or release readiness.
`;
}
