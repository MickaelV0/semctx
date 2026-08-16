import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ToolPublicError } from "./public-tool-error";

/**
 * Claude-style `${NAME}` left unexpanded by a host that does not substitute plugin env templates.
 * Start-anchored: a value only counts as a placeholder when it *begins* with one, so a real
 * filesystem path that merely contains a `${…}`-shaped segment still binds at construction.
 */
const UNEXPANDED_HOST_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

function canonicalKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function canonicalRepositoryRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new ToolPublicError("REPOSITORY_ROOT_INVALID", {
      cause: { repositoryRoot: root },
    });
  }

  try {
    return realpathSync.native(root);
  } catch {
    throw new ToolPublicError("REPOSITORY_ROOT_UNAVAILABLE", {
      cause: { repositoryRoot: root },
    });
  }
}

/**
 * Process-bound `SEMCTX_ROOT` is optional. Empty values and unsubstituted host placeholders
 * (for example `${CLAUDE_PROJECT_DIR}` passed literally) are equivalent to unset so the
 * server can start and pin on the first valid `repositoryRoot` argument.
 */
export function optionalProcessBoundRoot(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "" || UNEXPANDED_HOST_PLACEHOLDER.test(value)) return undefined;
  return value;
}

export interface RepositoryRootResolver {
  resolve(repositoryRoot: string): string;
  current(): string | undefined;
}

/** Strictly binds a server to one canonical repository, pinning on first use when omitted. */
export function createRepositoryRootResolver(root?: string): RepositoryRootResolver {
  const processBound = optionalProcessBoundRoot(root);
  let boundRoot = processBound === undefined ? undefined : canonicalRepositoryRoot(processBound);

  return {
    resolve(repositoryRoot: string): string {
      const requestedRoot = canonicalRepositoryRoot(repositoryRoot);

      if (boundRoot === undefined) {
        boundRoot = requestedRoot;
        return requestedRoot;
      }

      if (canonicalKey(requestedRoot) !== canonicalKey(boundRoot)) {
        throw new ToolPublicError("REPOSITORY_ROOT_MISMATCH", {
          cause: { requestedRoot, boundRoot },
        });
      }

      return boundRoot;
    },
    current(): string | undefined {
      return boundRoot;
    },
  };
}
