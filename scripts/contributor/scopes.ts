/**
 * Named scopes a contributor may target with `bun scripts/contributor.ts check <scope>`.
 *
 * Each scope maps to one real, already-maintained `bun test` invocation — the same commands
 * CONTRIBUTING.md documents for narrow iteration. A scope's success proves only what it covers;
 * it never substitutes for `bun run verify:pr` (ADR 0022). Deliberately small: an unlisted or
 * cross-cutting area is exactly what the full gate exists for.
 */

export interface ContributorScope {
  readonly name: string;
  /** One line explaining what a contributor is actually exercising. */
  readonly description: string;
  /** Exact argv, run through Bun exactly as documented — no extensionless node_modules shim. */
  readonly argv: readonly string[];
  /** Directory the mapped tests must exist under, checked before the child process is spawned. */
  readonly testDirectory: string;
  /** What a passing run of this scope actually proves. */
  readonly covers: readonly string[];
  /** What a passing run of this scope does NOT prove, printed so success is never over-read. */
  readonly omits: readonly string[];
}

const COMMON_OMISSIONS: readonly string[] = [
  "every other workspace package",
  "typecheck (tsc)",
  "lint (eslint, ruff, zizmor)",
  "compatibility declarations (compatibility.json vs docs vs workflows)",
  "plugin runtime parity (plugin:check)",
  "Python compileall / benchmark smoke test",
  "diff hygiene (trailing whitespace, untracked files)",
];

export const CONTRIBUTOR_CHECK_SCOPES: readonly ContributorScope[] = [
  {
    name: "core",
    description:
      "Pure, dependency-free primitives shared by every analyzer and service (ids, schemas, errors).",
    argv: [process.execPath, "test", "packages/core"],
    testDirectory: "packages/core/test",
    covers: ["existing packages/core/test tests against the core package"],
    omits: COMMON_OMISSIONS,
  },
  {
    name: "app-services",
    description: "Use-case orchestration and transport-facing report construction.",
    argv: [process.execPath, "test", "packages/app-services"],
    testDirectory: "packages/app-services/test",
    covers: ["existing packages/app-services/test tests against app-services"],
    omits: COMMON_OMISSIONS,
  },
  {
    name: "mcp-server",
    description: "MCP tool registration, structured schemas and transport parity.",
    argv: [process.execPath, "test", "packages/mcp-server"],
    testDirectory: "packages/mcp-server/test",
    covers: ["existing packages/mcp-server/test tests against mcp-server"],
    omits: COMMON_OMISSIONS,
  },
];

export function findContributorScope(name: string): ContributorScope | undefined {
  return CONTRIBUTOR_CHECK_SCOPES.find((scope) => scope.name === name);
}

export const CONTRIBUTOR_SCOPE_NAMES: readonly string[] = CONTRIBUTOR_CHECK_SCOPES.map(
  (scope) => scope.name,
);
