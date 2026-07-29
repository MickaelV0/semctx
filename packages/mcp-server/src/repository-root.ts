import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function canonicalKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function canonicalRepositoryRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error("repository root must be absolute");
  }

  try {
    return realpathSync.native(root);
  } catch {
    throw new Error(`repository root does not exist or is not accessible: ${root}`);
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
        throw new Error(
          `repository root does not match the server-bound root: requested ${requestedRoot}`,
        );
      }

      return boundRoot;
    },
    current(): string | undefined {
      return boundRoot;
    },
  };
}
