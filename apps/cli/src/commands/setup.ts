import { setupRepository } from "@semantic-context/app-services";
import { runPreset } from "./preset";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c } from "../output";

/**
 * `semctx setup` — one command that makes a repository ready: config + graph index + semantic
 * scaffold + validation. Idempotent and non-destructive (never overwrites an existing config or
 * authored `.sem` files).
 *
 * Progress: a short banner, then a blocking setup run (config · semantic · index · check), then a
 * phase summary. Live mid-index streaming is not yet re-exposed via a shared progress port.
 *
 * The core mutation lives in `@semantic-context/app-services` (`setupRepository`) so the plugin MCP
 * tool can call the same path without a global package install.
 */
export function runSetup(root: string, args: ParsedArgs): number {
  const preset = flagString(args, "preset");
  const asJson = flagBool(args, "json");
  const polyglot = flagBool(args, "polyglot");

  if (!asJson) heading(`semctx setup  ${c.dim("·")}  ${root}`);

  // Optional host presets (GitHub Action / Claude Code files) remain CLI-only.
  if (preset !== undefined) {
    if (!asJson) info(c.dim(`  applying preset "${preset}"…`));
    const code = runPreset(root, preset, args);
    if (code !== 0) return code;
  }

  if (!asJson) info(c.dim("  running setup (config · semantic · index · check)…"));
  const report = setupRepository(root, { polyglot });

  if (report.kind === "setup_refused") {
    if (asJson) {
      json(report);
      return 1;
    }
    fail(report.reason);
    for (const step of report.nextSteps) info(c.dim(`  → ${step}`));
    return 1;
  }

  if (asJson) {
    // Historical CLI JSON projection (not the full MCP envelope). Readiness = exit code.
    // Canonical versioned report fields (verdict, setupReady, analysisReady) live on MCP / SetupResult.
    json({
      configWritten: report.configWritten || preset !== undefined,
      preset: preset ?? null,
      sourceFiles: report.sourceFiles,
      selectedFiles: report.selectedFiles,
      selection: report.selection,
      nodes: report.nodes,
      edges: report.edges,
      claims: report.claims,
      freshnessSeal: report.freshnessSeal,
      indexHealth: report.indexHealth,
      semanticFilesCreated: report.semanticFilesCreated,
      gitignore: report.gitignore,
      check: report.check,
      // Additive readiness keys (safe for older consumers that ignore unknown fields).
      setupReady: report.setupReady,
      analysisReady: report.analysisReady,
      verdict: report.verdict,
    });
    return report.setupReady ? 0 : 1;
  }

  const configNote = preset !== undefined
    ? c.dim(`preset "${preset}"`)
    : report.configWritten
      ? c.dim("written to " + report.configPath)
      : c.dim("existing, kept");
  info(`  ${c.green("ok")} config    ${configNote}`);
  info(
    `  ${c.green("ok")} semantic  ${
      report.semanticFilesCreated > 0
        ? `${report.semanticFilesCreated} file(s) scaffolded ${c.dim("(.semctx/semantic/, versioned)")}`
        : c.dim("already present")
    }`,
  );
  if (report.selectedFiles === 0) {
    info(`  ${c.yellow("!!")} index     ${c.yellow("no analyzable files selected")} under ${root}`);
  }
  info(
    `  ${c.green("ok")} index     ${c.bold(String(report.nodes))} nodes, `
    + `${c.bold(String(report.edges))} edges, ${c.bold(String(report.claims))} claims`,
  );
  info(
    `  ${report.check.ok ? c.green("ok") : c.red("!!")} check     ${
      report.check.ok ? "model consistent" : `${report.check.errors} error(s)`
    }`,
  );

  const coverage = report.indexHealth.coverage as { status?: string } | undefined;
  const coverageStatus = coverage?.status;
  if (report.selection.configVersion === 2 && coverageStatus !== undefined) {
    const healthColor = !report.analysisReady
      ? c.red
      : coverageStatus === "complete"
        ? c.green
        : c.yellow;
    const reasons = (report.indexHealth.reasonSummary as unknown[]).map(String);
    info(
      `  ${!report.analysisReady
        ? c.red("!!")
        : coverageStatus === "complete"
          ? c.green("ok")
          : c.yellow("!!")} analysis  `
      + `${healthColor(coverageStatus)}`
      + `${reasons.length === 0 ? "" : c.dim(` (${reasons.join(", ")})`)}`,
    );
  }

  info("");
  if (report.nodes === 0) {
    warn(
      report.selection.configVersion === 1
        ? "index found 0 nodes — config v1 keeps legacy discovery and does not apply include; use 'semctx setup --polyglot' in a new workspace or migrate explicitly to config v2."
        : "index found 0 nodes — review v2 include/exclude globs and language modes, then re-run 'semctx setup'.",
    );
  }
  if (report.setupReady) {
    const analysisQualification =
      report.selection.configVersion === 2 && coverageStatus !== "complete"
        ? ` (analysis ${coverageStatus})`
        : "";
    success(`ready${analysisQualification}`);
    if (report.selection.configVersion === 2 && coverageStatus !== "complete") {
      warn(
        "setup succeeded, but incomplete analysis cannot justify negative conclusions; "
        + "run 'semctx index-health --json' for the exact gates and reasons.",
      );
    }
    info(c.dim("Next: open a change and verify it —"));
    info(c.dim("  semctx change open change.my-change --preserves <invariant-ids>"));
    info(c.dim("  # edit code, then:  semctx change verify change.my-change --base origin/main"));
  } else if (!report.check.ok) {
    fail("setup completed with model issues — run 'semctx semantic check' for details");
  } else {
    fail(
      "setup completed, but analysis is not ready — "
      + "run 'semctx index-health --json' for the exact gates and reasons.",
    );
  }
  return report.setupReady ? 0 : 1;
}
