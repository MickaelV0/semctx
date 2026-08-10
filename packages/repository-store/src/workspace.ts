import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SemctxError, SemctxConfigSchema, createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { SqliteRepositoryStore } from "./store";

export const SEMCTX_DIR = ".semctx";

export function semctxDir(root: string): string {
  return join(root, SEMCTX_DIR);
}

export function configPath(root: string): string {
  return join(semctxDir(root), "config.json");
}

export function dbPath(root: string): string {
  return join(semctxDir(root), "semctx.db");
}

export function contextPacksDir(root: string): string {
  return join(semctxDir(root), "context-packs");
}

export function isInitialized(root: string): boolean {
  return existsSync(configPath(root));
}

/**
 * Policy-only view of a config for disk. Machine `repositoryRoot` is never versioned — the
 * call/CLI root is the source of truth and is re-injected by `loadConfig`.
 */
export function toDiskConfig<T extends SemctxConfig>(config: T): Omit<T, "repositoryRoot"> {
  const { repositoryRoot: _repositoryRoot, ...policy } = config;
  return policy;
}

/** Create `.semctx/`, write config, return the resolved config. Idempotent-ish. */
export function initWorkspace(root: string, overrides?: Partial<SemctxConfig>): SemctxConfig {
  mkdirSync(semctxDir(root), { recursive: true });
  mkdirSync(contextPacksDir(root), { recursive: true });
  const repositoryRoot = realpathSync.native(resolve(root));
  // Validate policy shape (repositoryRoot is optional on disk / ignored at load).
  const policy = SemctxConfigSchema.parse({
    ...createDefaultConfig(repositoryRoot),
    ...overrides,
  });
  const config: SemctxConfig = { ...policy, repositoryRoot };
  saveConfig(root, config);
  return config;
}

export function saveConfig(root: string, config: SemctxConfig): void {
  mkdirSync(semctxDir(root), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(toDiskConfig(config), null, 2)}\n`, "utf8");
}

export function loadConfig(root: string): SemctxConfig {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `no semctx config at ${path}. Run 'semctx init' first.`, { root });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SemctxError("CONFIG_INVALID", `config.json is not valid JSON`, { path, cause: String(cause) });
  }
  const parsed = SemctxConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SemctxError("CONFIG_INVALID", `config.json failed schema validation`, {
      path,
      issues: parsed.error.issues,
    });
  }
  // Call/CLI root is authoritative; on-disk repositoryRoot (legacy) is ignored.
  return { ...parsed.data, repositoryRoot: realpathSync.native(resolve(root)) };
}

export function openStore(root: string): SqliteRepositoryStore {
  mkdirSync(semctxDir(root), { recursive: true });
  return SqliteRepositoryStore.open(dbPath(root));
}
