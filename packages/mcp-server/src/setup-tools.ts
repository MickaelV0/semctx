import {
  isInitialized,
  loadConfig,
} from "@semantic-context/repository-store";
import {
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  evaluatePolyglotSetupPolicy,
  setupRepository,
  type SetupRepositoryReport,
  type SetupRefusedReport,
  type SetupResult,
} from "@semantic-context/app-services";

export { SETUP_POLYGLOT_V1_REFUSE_REASON_CODE };

/** Agent-facing polyglot input description (must name the exact reasonCode). */
export const SETUP_POLYGLOT_INPUT_DESCRIPTION =
  "when writing a FRESH config, use polyglot v2 glob selection. If a non-v2 config already exists, polyglot:true is REFUSED (kind setup_refused / reasonCode "
  + SETUP_POLYGLOT_V1_REFUSE_REASON_CODE
  + " / verdict SETUP_REFUSED) — migrate .semctx/config.json to v2 explicitly; it does not silently ignore or overwrite";

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
 * isError / no structuredContent on catalogue errors), except catalogue failures that throw
 * (e.g. CONFIG_INVALID on unreadable config during polyglot preflight policy check):
 * - `kind: "setup" && verdict: "SETUP_READY"` → agent success
 * - `setup_refused` / `SETUP_NOT_READY` → domain failure; read reason/nextSteps/indexHealth
 *
 * Polyglot-vs-config-version refusal is owned by app-services (`evaluatePolyglotSetupPolicy`).
 * This adapter may load config for no-write preflight but must not reconstruct refuse payloads.
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
    // Unreadable / schema-invalid config must NOT fall through to a healthy preflight —
    // rethrow so MCP maps CONFIG_INVALID via the public catalogue (ADR 0012).
    if (initialized && input.polyglot === true) {
      const config = loadConfig(root);
      const refused = evaluatePolyglotSetupPolicy({
        repositoryRoot: root,
        polyglot: true,
        alreadyInitialized: true,
        configVersion: config.version,
      });
      if (refused !== null) {
        return refused;
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
