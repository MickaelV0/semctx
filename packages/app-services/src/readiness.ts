import { existsSync } from "node:fs";
import { SemctxError, attachSuppressedError } from "@semantic-context/core";
import {
  SqliteRepositoryReader,
  SqliteRepositoryStore,
  dbPath,
  isInitialized,
  openStore,
} from "@semantic-context/repository-store";

function requireReadyDatabase(root: string): void {
  if (!isInitialized(root)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `repository is not initialized/prepared at ${root}; run MCP semctx_setup (confirm:true) or 'semctx setup' first`, {
      root,
    });
  }
  if (!existsSync(dbPath(root))) {
    throw new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run MCP semctx_setup (confirm:true) or 'semctx setup' first`, {
      root,
    });
  }
}

/** Open an indexed repository through an immutable reader, without creating readiness state. */
export function openReadyRepository(root: string): SqliteRepositoryReader {
  requireReadyDatabase(root);
  const database = dbPath(root);
  const reader = SqliteRepositoryReader.openExisting(database);
  if (!reader.isIndexed()) {
    reader.close();
    throw new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run MCP semctx_setup (confirm:true) or 'semctx setup' first`, {
      root,
    });
  }
  return reader;
}

/** Open an indexed repository through a mutable store, allowing WAL recovery before immutable reads resume. */
export function openReadyRepositoryWriter(root: string): SqliteRepositoryStore {
  requireReadyDatabase(root);
  const store = openStore(root);
  if (!store.isIndexed()) {
    const readinessError = new SemctxError("REPO_NOT_INDEXED", `repository index is absent at ${root}; run MCP semctx_setup (confirm:true) or 'semctx setup' first`, {
      root,
    });
    try {
      store.close();
    } catch (closeError) {
      throw attachSuppressedError(readinessError, closeError);
    }
    throw readinessError;
  }
  return store;
}
