import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ToolPublicError } from "./public-tool-error";

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

export interface RepositoryRootResolver {
  resolve(repositoryRoot: string): string;
  current(): string | undefined;
}

/** Strictly binds a server to one canonical repository, pinning on first use when omitted. */
export function createRepositoryRootResolver(root?: string): RepositoryRootResolver {
  let boundRoot = root === undefined ? undefined : canonicalRepositoryRoot(root);

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
