/**
 * Config-migration persistence and cooperative mutex (ADR 0028).
 *
 * A separate `.semctx/config-migrations/coordinator.db`, opened directly through bundled Bun
 * SQLite, never through `SqliteRepositoryStore` — that constructor creates and migrates the index
 * schema, which this coordinator must never touch. `BEGIN IMMEDIATE` takes SQLite's own reserved
 * lock as the mutex: no PID file is written, so there is nothing for a killed owner to leave
 * behind — the OS releases the file lock the moment the process dies, and the next acquire simply
 * succeeds. A bounded `busy_timeout` keeps contention fail-fast rather than hanging.
 *
 * Every artifact this module writes — the published manifest, and the before/after config blobs —
 * is written to an exclusive, unpredictable temporary name, fsynced, and read back before the
 * caller may trust it landed. `prepare-<run-id>` is built up out-of-band and only ever made visible
 * by one atomic rename to `runs/<run-id>`; a crash before that rename leaves an inert, reported,
 * never-auto-deleted directory behind. Nothing here decides *whether* to apply or restore — that
 * policy lives in `@semantic-context/control-engine` and `app-services`.
 */

import { Database, SQLiteError } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SemctxError, attachSuppressedError } from "@semantic-context/core";
import { configMigrationCheckpoint } from "./config-migration-checkpoint";
import { assertUnlinkedDatabase } from "./store";
import { assertUnlinkedBelow, configPath, isLinkedEntry, semctxDir } from "./workspace";

export const CONFIG_MIGRATION_MANIFEST_FILE = "manifest.json";
export const CONFIG_MIGRATION_BEFORE_FILE = "before.json";
export const CONFIG_MIGRATION_AFTER_FILE = "after.json";

const MUTEX_BUSY_TIMEOUT_MS = 2_000;
const RUN_ID_RE = /^[0-9]{13,}-[0-9a-f]{32}$/;
const PREPARE_PREFIX = "prepare-";

export function configMigrationsDir(root: string): string {
  return join(semctxDir(root), "config-migrations");
}

export function coordinatorDbPath(root: string): string {
  return join(configMigrationsDir(root), "coordinator.db");
}

export function runsDir(root: string): string {
  return join(configMigrationsDir(root), "runs");
}

export function runDir(root: string, runId: string): string {
  assertSafeRunId(runId);
  return join(runsDir(root), runId);
}

function prepareDir(root: string, runId: string): string {
  assertSafeRunId(runId);
  return join(configMigrationsDir(root), `${PREPARE_PREFIX}${runId}`);
}

export function generateConfigMigrationRunId(): string {
  return `${Date.now()}-${randomBytes(16).toString("hex")}`;
}

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new SemctxError("CONFIG_INVALID", "unsafe config-migration run id", { runId });
  }
}

function assertNotLinked(path: string): void {
  if (isLinkedEntry(path)) {
    throw new SemctxError("CONFIG_INVALID", "linked config-migration entries are unsupported", { path });
  }
}

/** Every ancestor down to and including the config-migrations tree must be link-free. */
export function assertUnlinkedConfigMigrationsTree(root: string): void {
  assertUnlinkedBelow(root, configMigrationsDir(root));
  for (const path of [configMigrationsDir(root), runsDir(root)]) assertNotLinked(path);
}

/** POSIX directory fsync; tolerated as unsupported on Windows, exactly like the anchor migration. */
function fsyncDirectoryTolerant(path: string): void {
  try {
    const handle = openSync(path, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupportedOnWindows = process.platform === "win32"
      && new Set(["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"]).has(code ?? "");
    if (!unsupportedOnWindows) throw error;
  }
}

/**
 * Never deletes on failure: a partially written artifact is kept and the caller reports the
 * failed publication, rather than this module silently erasing evidence of what was attempted.
 */
function writeExclusiveFsyncReadback(path: string, bytes: Buffer): void {
  assertNotLinked(path);
  const fd = openSync(path, "wx", 0o600);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const readback = readFileSync(path);
  if (!readback.equals(bytes)) {
    throw new SemctxError("STORE_ERROR", "config-migration artifact failed readback verification", { path });
  }
}

/**
 * Exclusive temp + fsync + atomic rename over an existing path, then fsync the directory and read
 * back. Never deletes the temp on failure — it is a created artifact, not disposable scratch.
 */
function replaceExclusiveFsyncReadback(path: string, bytes: Buffer): void {
  assertNotLinked(path);
  const temp = `${path}.${randomBytes(9).toString("hex")}.tmp`;
  assertNotLinked(temp);
  const fd = openSync(temp, "wx", 0o600);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectoryTolerant(dirname(path));
  const readback = readFileSync(path);
  if (!readback.equals(bytes)) {
    throw new SemctxError("STORE_ERROR", "config-migration artifact failed readback verification", { path });
  }
}

/** Directory entries proper: refuses a linked/dangling directory instead of reporting it absent. */
function assertReadableDirectory(root: string, directory: string): void {
  assertUnlinkedBelow(root, directory);
  if (!existsSync(directory)) return;
  const info = lstatSync(directory);
  if (!info.isDirectory()) {
    throw new SemctxError("STORE_ERROR", "config-migration path is not a regular directory", { directory });
  }
}

/** Names of `prepare-<run-id>` directories still present — never published, never removed. */
export function listAbandonedConfigMigrationPreparations(root: string): string[] {
  const directory = configMigrationsDir(root);
  assertReadableDirectory(root, directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(PREPARE_PREFIX))
    .sort();
}

export function listConfigMigrationRuns(root: string): string[] {
  const directory = runsDir(root);
  assertReadableDirectory(root, directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

/**
 * Build `prepare-<run-id>` out of band (before.json, after.json, manifest.json — each exclusively
 * written, fsynced, and read back) and publish it with one atomic rename. No config replacement
 * may precede this call returning. A failure here never deletes what was already written: the
 * caller reports the failed publication and the `prepare-<run-id>` directory remains, inspectable,
 * for `listAbandonedConfigMigrationPreparations`. A run-id collision refuses outright rather than
 * replacing whatever is already published under that id.
 */
export function publishConfigMigrationRun(
  root: string,
  runId: string,
  beforeBytes: Buffer,
  afterBytes: Buffer,
  manifestBytes: Buffer,
): void {
  assertSafeRunId(runId);
  assertUnlinkedConfigMigrationsTree(root);
  mkdirSync(configMigrationsDir(root), { recursive: true });
  const prepare = prepareDir(root, runId);
  assertNotLinked(prepare);
  const published = runDir(root, runId);
  assertNotLinked(published);
  if (existsSync(published)) {
    throw new SemctxError("STORE_ERROR", "config-migration run id already published", { runId, path: published });
  }
  mkdirSync(prepare);
  writeExclusiveFsyncReadback(join(prepare, CONFIG_MIGRATION_BEFORE_FILE), beforeBytes);
  writeExclusiveFsyncReadback(join(prepare, CONFIG_MIGRATION_AFTER_FILE), afterBytes);
  writeExclusiveFsyncReadback(join(prepare, CONFIG_MIGRATION_MANIFEST_FILE), manifestBytes);
  fsyncDirectoryTolerant(prepare);
  mkdirSync(runsDir(root), { recursive: true });
  if (existsSync(published)) {
    throw new SemctxError("STORE_ERROR", "config-migration run id already published", { runId, path: published });
  }
  configMigrationCheckpoint("publish:before-rename");
  renameSync(prepare, published);
  fsyncDirectoryTolerant(runsDir(root));
}

/** Rewrite an already-published run's manifest (state transition), fsync, and read back. */
export function rewriteConfigMigrationManifest(root: string, runId: string, manifestBytes: Buffer): void {
  const path = join(runDir(root, runId), CONFIG_MIGRATION_MANIFEST_FILE);
  assertUnlinkedBelow(root, path);
  replaceExclusiveFsyncReadback(path, manifestBytes);
}

function readRunArtifact(root: string, runId: string, fileName: string): Buffer {
  const path = join(runDir(root, runId), fileName);
  assertUnlinkedBelow(root, path);
  if (!existsSync(path)) {
    throw new SemctxError("STORE_ERROR", "config-migration run artifact is missing", { runId, path });
  }
  const info = lstatSync(path);
  if (!info.isFile()) {
    throw new SemctxError("STORE_ERROR", "config-migration run artifact is not a regular file", { runId, path });
  }
  return readFileSync(path);
}

export function readConfigMigrationManifest(root: string, runId: string): Buffer {
  return readRunArtifact(root, runId, CONFIG_MIGRATION_MANIFEST_FILE);
}

export function readConfigMigrationBefore(root: string, runId: string): Buffer {
  return readRunArtifact(root, runId, CONFIG_MIGRATION_BEFORE_FILE);
}

export function readConfigMigrationAfter(root: string, runId: string): Buffer {
  return readRunArtifact(root, runId, CONFIG_MIGRATION_AFTER_FILE);
}

/**
 * Read `config.json` bytes under the same link/regular-file guard used everywhere in this module.
 * Every ancestor from `root` down to the file is checked, not only the final component: a linked
 * `.semctx` would otherwise silently serve another repository's config as this one's.
 */
export function readCurrentConfigBytes(root: string): Buffer {
  const path = configPath(root);
  assertUnlinkedBelow(root, path);
  if (!existsSync(path)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `no semctx config at ${path}`, { root });
  }
  const info = lstatSync(path);
  if (!info.isFile()) {
    throw new SemctxError("CONFIG_INVALID", "config.json is not a regular file", { path });
  }
  return readFileSync(path);
}

/**
 * Durable config.json replacement, bound to an expected preimage: exclusive temp, fsync, then —
 * immediately before the rename that makes the new bytes visible — re-read the live config.json
 * and refuse if it no longer equals `expectedCurrentBytes`. This is not a general compare-and-swap
 * against every outside editor (the module's supported environment is a trusted local worktree
 * with no concurrent external writer), but it closes the specific window between this call reading
 * its own preimage and committing the replacement. On drift, the temp is left in place (never
 * deleted) and no rename occurs. On success, the written bytes are read back before returning.
 */
export function swapCurrentConfigBytes(root: string, expectedCurrentBytes: Buffer, newBytes: Buffer): void {
  const path = configPath(root);
  assertUnlinkedBelow(root, path);
  const temp = `${path}.${randomBytes(9).toString("hex")}.tmp`;
  assertNotLinked(temp);
  const fd = openSync(temp, "wx", 0o600);
  try {
    let written = 0;
    while (written < newBytes.length) written += writeSync(fd, newBytes, written, newBytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  assertUnlinkedBelow(root, path);
  const actualCurrent = readFileSync(path);
  if (!actualCurrent.equals(expectedCurrentBytes)) {
    throw new SemctxError("STORE_ERROR", "current config.json diverged from the expected preimage immediately before replacement", {
      path,
      reason: "PREIMAGE_DRIFTED",
    });
  }
  configMigrationCheckpoint("config:before-rename");
  renameSync(temp, path);
  configMigrationCheckpoint("config:after-rename");
  fsyncDirectoryTolerant(dirname(path));
  const readback = readFileSync(path);
  if (!readback.equals(newBytes)) {
    throw new SemctxError("STORE_ERROR", "config-migration artifact failed readback verification", { path });
  }
}

function isMutexContention(error: unknown): boolean {
  return error instanceof SQLiteError && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
}

/**
 * Hold the cooperative config-migration mutex for the duration of `fn`. `BEGIN IMMEDIATE` is the
 * lock; nothing is ever written into the coordinator database itself. Bounded and fail-fast: a
 * live concurrent holder surfaces as `SQLITE_BUSY`/`SQLITE_LOCKED` within `busyTimeoutMs`, never a
 * hang — every other `BEGIN` failure (a genuine storage error) is preserved and reported as such,
 * never mistaken for contention. `fn` must be synchronous: holding a SQLite transaction across an
 * async gap is never a supported use of this lock.
 *
 * Every exit once the transaction has begun — `fn` throwing, `fn` returning a thenable, `COMMIT`
 * failing, or the final `close()` failing after a successful rollback — runs through the same
 * rollback-then-close path, so the database handle is never left open on the way out. Only the
 * primary failure decides `isMutexBusy`/`isPreimageDrifted` classification upstream; a rollback or
 * close failure encountered while handling it is attached as a suppressed error, never silently
 * dropped.
 */
export function withConfigMigrationLock<T>(
  root: string,
  fn: () => T,
  busyTimeoutMs: number = MUTEX_BUSY_TIMEOUT_MS,
): T {
  assertUnlinkedConfigMigrationsTree(root);
  mkdirSync(configMigrationsDir(root), { recursive: true });
  const dbPath = coordinatorDbPath(root);
  assertUnlinkedDatabase(dbPath);
  assertUnlinkedBelow(root, dbPath);
  const db = new Database(dbPath, { create: true });

  let began = false;

  /** Rollback + close, attaching any secondary failure to the primary one; never returns. */
  // Explicitly typed so control-flow analysis treats each call as terminating.
  const abortTransaction: (primary: unknown) => never = (primary) => {
    let toThrow = primary;
    try {
      db.exec("ROLLBACK;");
    } catch (rollbackError) {
      toThrow = attachSuppressedError(primary, rollbackError);
    }
    try {
      db.close();
    } catch (closeError) {
      toThrow = attachSuppressedError(toThrow, closeError);
    }
    throw toThrow;
  };

  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)};`);
    db.exec("PRAGMA journal_mode = DELETE;");
    try {
      db.exec("BEGIN IMMEDIATE;");
      began = true;
    } catch (cause) {
      if (isMutexContention(cause)) {
        throw new SemctxError("STORE_ERROR", "another config migration is currently active", {
          reason: "MUTEX_BUSY",
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      throw new SemctxError("STORE_ERROR", "failed to begin config-migration transaction", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    let result: T;
    try {
      result = fn();
    } catch (error) {
      abortTransaction(error);
    }
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      abortTransaction(new SemctxError("STORE_ERROR", "config-migration lock callback must be synchronous", {}));
    }

    try {
      db.exec("COMMIT;");
    } catch (error) {
      abortTransaction(error);
    }
    db.close();
    return result;
  } catch (error) {
    if (!began) {
      try {
        db.close();
      } catch (closeError) {
        throw attachSuppressedError(error, closeError);
      }
    }
    throw error;
  }
}
