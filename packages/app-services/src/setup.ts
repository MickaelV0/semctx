import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultConfig,
  createGlobSelectionConfig,
  type SemctxConfig,
} from "@semantic-context/core";
import {
  isInitialized,
  loadConfig,
  saveConfig,
  semctxDir as resolveSemctxDir,
} from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  loadSemanticModel,
  checkSemanticModel,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import {
  countTypeScriptFiles,
  discoverRepository,
  sourceLanguage,
} from "@semantic-context/ts-analyzer";
import { indexHealth } from "./index-health";
import { indexRepository } from "./indexing";
import { openReadyRepository } from "./readiness";

/**
 * Bootstrap readiness — namespaced away from Plane C migration `READY`/`BLOCKED`
 * so agents never conflate workspace bootstrap with plan admission / execution authority.
 */
export type SetupVerdict = "SETUP_READY" | "SETUP_NOT_READY" | "SETUP_REFUSED";

/** Progress events for transports that want live phase output (CLI). MCP may ignore. */
export type SetupPhaseEvent =
  | { phase: "config"; detail: "written" | "kept" }
  | { phase: "semantic"; created: number }
  | { phase: "index"; stage: "start"; selectedFiles: number; selectedByLanguage: Record<string, number> }
  | { phase: "index"; stage: "done"; nodes: number; edges: number; claims: number }
  | { phase: "check"; ok: boolean; errors: number }
  | { phase: "analysis"; ready: boolean; coverageStatus?: string };

/** Options for repository bootstrap (CLI + MCP share this path). */
export interface SetupRepositoryOptions {
  /** Prefer a polyglot v2 glob selection when writing a fresh config. */
  polyglot?: boolean;
  /**
   * Capture timestamp for the index seal.
   * Prefer injecting an explicit ISO-8601 value (CLI/MCP) so ambient clock use stays at the transport edge.
   * When omitted, a wall-clock ISO string is used once for this run.
   */
  now?: string;
  /** Optional phase callback (CLI live progress). Never required for correctness. */
  onPhase?: (event: SetupPhaseEvent) => void;
}

export interface SetupRepositoryReport {
  schemaVersion: 1;
  kind: "setup";
  repositoryRoot: string;
  configWritten: boolean;
  /**
   * Absolute path to the `.semctx/` workspace directory (`semctxDir(root)`).
   * Not the config file path — use repository-store `configPath(root)` for `…/config.json`.
   */
  semctxDir: string;
  alreadyInitialized: boolean;
  polyglot: boolean;
  sourceFiles: number;
  selectedFiles: number;
  selection: {
    configVersion: number;
    mode: string;
    selectedByLanguage: Record<string, number>;
    excluded: number;
    disabled: number;
    unsupported: number;
    failed: number;
  };
  nodes: number;
  edges: number;
  claims: number;
  freshnessSeal: unknown;
  indexHealth: {
    binding: unknown;
    freshness: unknown;
    coverage: unknown;
    workspaceDiagnostics: readonly unknown[];
    reasonSummary: readonly unknown[];
  };
  semanticFilesCreated: number;
  gitignore: "create" | "update" | "present";
  check: { ok: boolean; nodes: number; changes: number; errors: number };
  setupReady: boolean;
  analysisReady: boolean;
  /** SETUP_READY only when check.ok && analysisReady. Distinct from Plane C READY. */
  verdict: "SETUP_READY" | "SETUP_NOT_READY";
}

/**
 * Policy refusal before mutation (e.g. polyglot against an existing v1 config).
 * Returned instead of throwing so MCP can surface actionable guidance in structuredContent
 * (public SemctxError messages are stripped at the MCP catalogue boundary).
 */
/**
 * Domain policy refuse codes (structured success path — not MCP catalogue error codes).
 * Keep MCP tool descriptions and TOOL_OUTPUT_SCHEMAS in lockstep with this union.
 */
export type SetupRefuseReasonCode = "POLYGLOT_REQUIRES_CONFIG_V2";

/** Canonical polyglot-vs-v1 refuse code (shared with MCP metadata). */
export const SETUP_POLYGLOT_V1_REFUSE_REASON_CODE: SetupRefuseReasonCode =
  "POLYGLOT_REQUIRES_CONFIG_V2";

export interface SetupRefusedReport {
  schemaVersion: 1;
  kind: "setup_refused";
  repositoryRoot: string;
  reasonCode: SetupRefuseReasonCode;
  reason: string;
  configVersion: number;
  polyglot: boolean;
  alreadyInitialized: true;
  setupReady: false;
  analysisReady: false;
  verdict: "SETUP_REFUSED";
  /** Safe migration guidance for agents/hosts. */
  nextSteps: string[];
}

export type SetupResult = SetupRepositoryReport | SetupRefusedReport;

/** Layout-aware default config: monorepos also index package sources. */
function smartConfig(root: string, polyglot: boolean): SemctxConfig {
  if (polyglot) return createGlobSelectionConfig(root);
  const hasPackages = existsSync(join(root, "packages"));
  return {
    ...createDefaultConfig(root),
    include: hasPackages ? ["packages/*/src/**/*.ts", "src/**/*.ts"] : ["src/**/*.ts"],
  };
}

function resolveIndexedAt(now: string | undefined): string {
  if (now !== undefined) return now;
  return new Date().toISOString();
}

/**
 * One-shot repository bootstrap: config + semantic scaffold + graph index + validation.
 *
 * Idempotent and non-destructive for existing config / authored `.sem` files.
 * Shared by the CLI (`semctx setup`) and the plugin MCP tool (`semctx_setup`) so agents
 * do not need a global package install.
 *
 * Policy refusals (e.g. polyglot on v1 config) return `kind: "setup_refused"` instead of
 * throwing, so transports can fail closed with structured guidance.
 */
export function setupRepository(
  root: string,
  options: SetupRepositoryOptions = {},
): SetupResult {
  const polyglot = options.polyglot === true;
  const onPhase = options.onPhase;
  const already = isInitialized(root);
  let configWritten = false;

  if (!already) {
    saveConfig(root, smartConfig(root, polyglot));
    configWritten = true;
  }

  const config = loadConfig(root);
  if (already && polyglot && config.version !== 2) {
    return {
      schemaVersion: 1,
      kind: "setup_refused",
      repositoryRoot: root,
      reasonCode: SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
      reason:
        "polyglot does not overwrite an existing v1 config; migrate .semctx/config.json explicitly to config version 2",
      configVersion: config.version,
      polyglot: true,
      alreadyInitialized: true,
      setupReady: false,
      analysisReady: false,
      verdict: "SETUP_REFUSED",
      nextSteps: [
        "Open .semctx/config.json and migrate to config version 2 (polyglot / glob selection), or remove .semctx/ and re-run setup with polyglot on a fresh workspace",
        "Do not pass polyglot:true against a v1 workspace expecting an in-place overwrite",
        "After migration, re-run setup without expecting config overwrite of authored .sem files",
      ],
    };
  }

  onPhase?.({ phase: "config", detail: configWritten ? "written" : "kept" });

  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;
  onPhase?.({ phase: "semantic", created });

  const discovery = discoverRepository(config);
  const fileCount = countTypeScriptFiles(config);
  const selectedCount = discovery.files.length;
  const selectedByLanguage = Object.fromEntries(
    ["typescript", "python", "markdown", "sql"].map((language) => [
      language,
      discovery.files.filter(
        (file) => (file.language ?? sourceLanguage(file.relPath)) === language,
      ).length,
    ]),
  );
  onPhase?.({
    phase: "index",
    stage: "start",
    selectedFiles: selectedCount,
    selectedByLanguage,
  });

  const { analysis, claims, freshnessSeal } = indexRepository(root, resolveIndexedAt(options.now));
  const reader = openReadyRepository(root);
  let facts: RepositoryFacts;
  try {
    facts = {
      graph: reader.loadGraph(),
      claims: reader.loadClaims(),
      evidence: reader.loadEvidence(),
    };
  } finally {
    reader.close();
  }
  onPhase?.({
    phase: "index",
    stage: "done",
    nodes: analysis.graph.nodes.length,
    edges: analysis.graph.edges.length,
    claims: claims.length,
  });

  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({
    model: loaded.model,
    diagnostics: loaded.diagnostics,
    duplicateIds: loaded.duplicateIds,
    facts,
    graphIndexed: true,
  });
  onPhase?.({ phase: "check", ok: check.ok, errors: check.counts.errors });

  const health = indexHealth(root);
  // Fail-closed for every config version (including legacy v1). SETUP_READY is the
  // agent/MCP success gate and must not short-circuit past insufficient coverage or
  // an index that cannot run high-risk control. CLI exit codes use the same signal.
  const analysisReady =
    health.binding.status === "valid"
    && health.freshness.canRunHighRiskControl
    && health.coverage.status !== "insufficient";
  const setupReady = check.ok && analysisReady;
  const coverageStatus =
    typeof health.coverage === "object" && health.coverage !== null && "status" in health.coverage
      ? String((health.coverage as { status: string }).status)
      : undefined;
  onPhase?.({
    phase: "analysis",
    ready: analysisReady,
    ...(coverageStatus !== undefined ? { coverageStatus } : {}),
  });

  return {
    schemaVersion: 1,
    kind: "setup",
    repositoryRoot: root,
    configWritten,
    semctxDir: resolveSemctxDir(root),
    alreadyInitialized: already,
    polyglot,
    sourceFiles: fileCount,
    selectedFiles: selectedCount,
    selection: {
      configVersion: config.version,
      mode: config.version === 2 ? config.selectionMode : "legacy-v1",
      selectedByLanguage,
      excluded: discovery.candidates.filter((candidate) => candidate.selectionDecision === "excluded").length,
      disabled: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "disabled").length,
      unsupported: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "unsupported").length,
      failed: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "failed").length,
    },
    nodes: analysis.graph.nodes.length,
    edges: analysis.graph.edges.length,
    claims: claims.length,
    freshnessSeal,
    indexHealth: {
      binding: health.binding,
      freshness: health.freshness,
      coverage: health.coverage,
      workspaceDiagnostics: health.workspace?.diagnostics ?? ([] as const),
      reasonSummary: health.reasonSummary,
    },
    semanticFilesCreated: created,
    gitignore: scaffold.gitignore.action,
    check: {
      ok: check.ok,
      nodes: check.counts.nodes,
      changes: check.counts.changes,
      errors: check.counts.errors,
    },
    setupReady,
    analysisReady,
    verdict: setupReady ? "SETUP_READY" : "SETUP_NOT_READY",
  };
}
