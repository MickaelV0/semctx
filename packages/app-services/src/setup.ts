import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SemctxError,
  createDefaultConfig,
  createGlobSelectionConfig,
  type SemctxConfig,
} from "@semantic-context/core";
import {
  isInitialized,
  loadConfig,
  saveConfig,
  semctxDir,
} from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  loadSemanticModel,
  checkSemanticModel,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import { countTypeScriptFiles, discoverRepository } from "@semantic-context/ts-analyzer";
import { indexHealth } from "./index-health";
import { indexRepository } from "./indexing";
import { openReadyRepository } from "./readiness";

/** Options for repository bootstrap (CLI + MCP share this path). */
export interface SetupRepositoryOptions {
  /** Prefer a polyglot v2 glob selection when writing a fresh config. */
  polyglot?: boolean;
  /** Capture timestamp; defaults to now. */
  now?: string;
}

export interface SetupRepositoryReport {
  schemaVersion: 1;
  kind: "setup";
  repositoryRoot: string;
  configWritten: boolean;
  configPath: string;
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
    workspaceDiagnostics: unknown[];
    reasonSummary: unknown[];
  };
  semanticFilesCreated: number;
  gitignore: string;
  check: { ok: boolean; nodes: number; changes: number; errors: number };
  setupReady: boolean;
  analysisReady: boolean;
}

/** Layout-aware default config: monorepos also index package sources. */
function smartConfig(root: string, polyglot: boolean): SemctxConfig {
  if (polyglot) return createGlobSelectionConfig(root);
  const hasPackages = existsSync(join(root, "packages"));
  return {
    ...createDefaultConfig(root),
    include: hasPackages ? ["packages/*/src/**/*.ts", "src/**/*.ts"] : ["src/**/*.ts"],
  };
}

function nowIso(override?: string): string {
  return override ?? new Date().toISOString();
}

/**
 * One-shot repository bootstrap: config + semantic scaffold + graph index + validation.
 *
 * Idempotent and non-destructive for existing config / authored `.sem` files.
 * Shared by the CLI (`semctx setup`) and the plugin MCP tool (`semctx_setup`) so agents
 * do not need a global package install.
 */
export function setupRepository(
  root: string,
  options: SetupRepositoryOptions = {},
): SetupRepositoryReport {
  const polyglot = options.polyglot === true;
  const already = isInitialized(root);
  let configWritten = false;

  if (!already) {
    saveConfig(root, smartConfig(root, polyglot));
    configWritten = true;
  }

  const config = loadConfig(root);
  if (already && polyglot && config.version !== 2) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--polyglot does not overwrite an existing v1 config; migrate .semctx/config.json explicitly",
      { configVersion: config.version },
    );
  }

  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;

  const discovery = discoverRepository(config);
  const fileCount = countTypeScriptFiles(config);
  const selectedCount = discovery.files.length;
  const selectedByLanguage = Object.fromEntries(
    ["typescript", "python", "markdown", "sql"].map((language) => [
      language,
      discovery.files.filter((file) =>
        (file.language ?? (/\.(?:ts|tsx|mts|cts)$/.test(file.relPath) ? "typescript"
          : /\.mdx?$/.test(file.relPath) ? "markdown"
            : /\.sql$/.test(file.relPath) ? "sql"
              : "unknown")) === language
      ).length,
    ]),
  );

  const { analysis, claims, freshnessSeal } = indexRepository(root, nowIso(options.now));
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

  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({
    model: loaded.model,
    diagnostics: loaded.diagnostics,
    duplicateIds: loaded.duplicateIds,
    facts,
    graphIndexed: true,
  });
  const health = indexHealth(root);
  const analysisReady =
    config.version !== 2
    || (
      health.binding.status === "valid"
      && health.freshness.canRunHighRiskControl
      && health.coverage.status !== "insufficient"
    );
  const setupReady = check.ok && analysisReady;

  return {
    schemaVersion: 1,
    kind: "setup",
    repositoryRoot: root,
    configWritten,
    configPath: semctxDir(root),
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
      workspaceDiagnostics: health.workspace?.diagnostics ?? [],
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
  };
}
