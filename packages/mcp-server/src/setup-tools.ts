import {
  isInitialized,
  loadConfig,
} from "@semantic-context/repository-store";
import {
  setupRepository,
  type SetupRepositoryReport,
  type SetupRefusedReport,
  type SetupResult,
} from "@semantic-context/app-services";

export interface SetupPreflightReport {
  schemaVersion: 1;
  kind: "setup_preflight";
  repositoryRoot: string;
  initialized: boolean;
  confirmRequired: true;
  message: string;
  next: {
    tool: "semctx_setup";
    arguments: {
      repositoryRoot: string;
      confirm: true;
      polyglot?: boolean;
    };
  };
}

export type SetupToolResult =
  | SetupPreflightReport
  | SetupRepositoryReport
  | SetupRefusedReport;

/**
 * True when the structured body is a completed setup that agents must treat as failure.
 * Wire transport still returns isError false (ADR 0012); agents must read kind/verdict.
 */
export function isSetupDomainFailure(body: SetupToolResult): boolean {
  return body.kind === "setup_refused"
    || (body.kind === "setup" && body.verdict === "SETUP_NOT_READY");
}

/** Agent success gate: only a full setup with SETUP_READY (ignore isError for domain outcomes). */
export function isSetupAgentSuccess(body: SetupToolResult): boolean {
  return body.kind === "setup" && body.verdict === "SETUP_READY";
}

/**
 * Plugin-native workspace bootstrap.
 *
 * - `confirm: false` (default) → dry preflight only (no writes).
 * - `confirm: true` → full setup via shared `setupRepository` (no global CLI install).
 *
 * All outcomes are ordinary schema-valid structured results (ADR 0012: no handler-authored
 * isError / no structuredContent on catalogue errors):
 * - `kind: "setup" && verdict: "SETUP_READY"` → agent success
 * - `setup_refused` / `SETUP_NOT_READY` → domain failure; read reason/nextSteps/indexHealth
 *
 * Verdict values are namespaced (`SETUP_*`) so they never collide with Plane C `READY`/`BLOCKED`.
 */
export function setupTool(
  root: string,
  input: { confirm?: boolean; polyglot?: boolean; now?: string } = {},
): SetupToolResult {
  if (input.confirm !== true) {
    const initialized = isInitialized(root);
    // Non-mutating policy preview: polyglot against existing non-v2 is refused without writes.
    if (initialized && input.polyglot === true) {
      try {
        const config = loadConfig(root);
        if (config.version !== 2) {
          return {
            schemaVersion: 1,
            kind: "setup_refused",
            repositoryRoot: root,
            reasonCode: "POLYGLOT_REQUIRES_CONFIG_V2",
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
      } catch {
        // Unreadable config: fall through to ordinary preflight (confirm path will fail closed).
      }
    }
    return {
      schemaVersion: 1,
      kind: "setup_preflight",
      repositoryRoot: root,
      initialized,
      confirmRequired: true,
      message: initialized
        ? "Workspace already has .semctx/. Re-run with confirm:true to re-index and re-validate (idempotent; does not overwrite authored .sem files or an existing config). Preflight only — no writes performed."
        : "Workspace is not initialized. Re-run with confirm:true to write .semctx/, scaffold semantic files, and build the deterministic index. No global semctx package install is required when using the plugin MCP.",
      // Suggest confirm without auto-firing polyglot when policy is unknown to the host UI.
      next: {
        tool: "semctx_setup",
        arguments: {
          repositoryRoot: root,
          confirm: true,
          ...(input.polyglot === true ? { polyglot: true } : {}),
        },
      },
    };
  }

  const result: SetupResult = setupRepository(root, {
    ...(input.polyglot === true ? { polyglot: true } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return result;
}
