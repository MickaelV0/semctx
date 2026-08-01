import {
  isInitialized,
} from "@semantic-context/repository-store";
import {
  setupRepository,
  type SetupRepositoryReport,
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

export type SetupToolResult = SetupPreflightReport | SetupRepositoryReport;

/**
 * Plugin-native workspace bootstrap.
 *
 * - `confirm: false` (default) → dry preflight only (no writes).
 * - `confirm: true` → full setup via shared `setupRepository` (no global CLI install).
 */
export function setupTool(
  root: string,
  input: { confirm?: boolean; polyglot?: boolean } = {},
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
        ? "Workspace already has .semctx/. Re-run with confirm:true to re-index and re-validate (idempotent; does not overwrite authored .sem files or an existing config)."
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

  return setupRepository(root, {
    ...(input.polyglot === true ? { polyglot: true } : {}),
  });
}
