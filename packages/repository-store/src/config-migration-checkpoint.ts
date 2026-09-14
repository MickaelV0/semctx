/**
 * Process-local instrumentation of config-migration persistence boundaries, for ADR 0028's crash
 * evidence. Deliberately internal: not re-exported from the package index, not reachable from the
 * CLI, and not driven by any environment variable. Production never installs an observer, so every
 * checkpoint is a no-op. A crash test's child process installs one by importing this file directly,
 * runs the real service against the real filesystem, and is killed while held at one boundary.
 */

export type ConfigMigrationCheckpoint =
  /** `prepare-<run-id>` is fully written and synced; the atomic rename to `runs/<run-id>` is next. */
  | "publish:before-rename"
  /** The replacement config temp is written and its preimage checked; the rename is next. */
  | "config:before-rename"
  /** config.json now holds the new bytes; directory sync and readback are next. */
  | "config:after-rename";

export type ConfigMigrationCheckpointObserver = (checkpoint: ConfigMigrationCheckpoint) => void;

let observer: ConfigMigrationCheckpointObserver | undefined;

/** Install (or, with `undefined`, remove) this process's observer; returns the previous one. */
export function setConfigMigrationCheckpointObserver(
  next: ConfigMigrationCheckpointObserver | undefined,
): ConfigMigrationCheckpointObserver | undefined {
  const previous = observer;
  observer = next;
  return previous;
}

export function configMigrationCheckpoint(checkpoint: ConfigMigrationCheckpoint): void {
  observer?.(checkpoint);
}
