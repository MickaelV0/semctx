import {
  isInitialized,
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

/** True when the structured body is a completed setup that agents must treat as failure. */
export function isSetupDomainFailure(body: SetupToolResult): boolean {
  return body.kind === "setup_refused"
    || (body.kind === "setup" && body.verdict === "SETUP_NOT_READY");
}

/** Agent success gate: only a full setup with SETUP_READY. */
export function isSetupAgentSuccess(body: SetupToolResult): boolean {
  return body.kind === "setup" && body.verdict === "SETUP_READY";
}

/**
 * Plugin-native workspace bootstrap.
 *
 * - `confirm: false` (default) → dry preflight only (no writes).
 * - `confirm: true` → full setup via shared `setupRepository` (no global CLI install).
 *
 * After confirm:true:
 * - `kind: "setup" && verdict: "SETUP_READY"` → success (`isError: false`)
 * - `setup_refused` / `SETUP_NOT_READY` → domain failure (`isError: true` with structured body)
 *
 * Verdict values are namespaced (`SETUP_*`) so they never collide with Plane C `READY`/`BLOCKED`.
 */
export function setupTool(
  root: string,
  input: { confirm?: boolean; polyglot?: boolean; now?: string } = {},
): SetupToolResult {
  if (input.confirm !== true) {
    const initialized = isInitialized(root);
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
