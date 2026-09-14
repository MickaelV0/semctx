import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSemctxError } from "@semantic-context/core";
import {
  configMigrationsDir,
  isConfigMigrationStructuralInvalidArtifact,
  listAbandonedConfigMigrationPreparations,
  listConfigMigrationRuns,
  publishConfigMigrationRun,
  readConfigMigrationAfter,
  readConfigMigrationBefore,
  readConfigMigrationManifest,
  readCurrentConfigBytes,
  rewriteConfigMigrationManifest,
  runDir,
  runsDir,
  swapCurrentConfigBytes,
  withConfigMigrationLock,
} from "../src/config-migration-store";
import { configPath, semctxDir } from "../src/workspace";

const REPO_ROOT = process.cwd();
const CRASH_TIMEOUT_MS = 30_000;
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-config-migration-store-"));
  roots.push(root);
  return root;
}

function seedConfig(root: string, content: string): void {
  mkdirSync(semctxDir(root), { recursive: true });
  writeFileSync(configPath(root), content, "utf8");
}

/** A directory link; junctions need no privilege on Windows. */
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

const linksSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "semctx-config-migration-link-probe-"));
  try {
    link(probe, join(probe, "self"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const linked = test.skipIf(!linksSupported);

function runId(seed: string): string {
  return `1700000000000-${seed.padEnd(32, "0").slice(0, 32)}`;
}

describe("publishConfigMigrationRun", () => {
  test("writes before/after/manifest durably and publishes them under runs/<id> atomically", () => {
    const root = tempRoot();
    const id = runId("a");
    const before = Buffer.from('{"version":1}\n', "utf8");
    const after = Buffer.from('{"version":2}\n', "utf8");
    const manifest = Buffer.from('{"schemaVersion":1}\n', "utf8");

    publishConfigMigrationRun(root, id, before, after, manifest);

    expect(existsSync(join(configMigrationsDir(root), `prepare-${id}`))).toBe(false);
    expect(listConfigMigrationRuns(root)).toEqual([id]);
    expect(readConfigMigrationBefore(root, id)).toEqual(before);
    expect(readConfigMigrationAfter(root, id)).toEqual(after);
    expect(readConfigMigrationManifest(root, id)).toEqual(manifest);
  });

  test("refuses an unsafe run id before touching the filesystem", () => {
    const root = tempRoot();
    expect(() => publishConfigMigrationRun(root, "../escape", Buffer.from(""), Buffer.from(""), Buffer.from(""))).toThrow();
    expect(existsSync(configMigrationsDir(root))).toBe(false);
  });
});

describe("listAbandonedConfigMigrationPreparations", () => {
  test("reports a prepare directory that was never published, and does not remove it", () => {
    const root = tempRoot();
    const id = runId("b");
    mkdirSync(configMigrationsDir(root), { recursive: true });
    mkdirSync(join(configMigrationsDir(root), `prepare-${id}`));
    writeFileSync(join(configMigrationsDir(root), `prepare-${id}`, "before.json"), "{}", "utf8");

    expect(listAbandonedConfigMigrationPreparations(root)).toEqual([`prepare-${id}`]);
    expect(listConfigMigrationRuns(root)).toEqual([]);
    expect(existsSync(join(configMigrationsDir(root), `prepare-${id}`))).toBe(true);
  });
});

describe("listAbandonedConfigMigrationPreparations — structural validation", () => {
  test("throws a structural invalid-artifact error for a malformed prepare suffix, and never deletes it", () => {
    const root = tempRoot();
    mkdirSync(configMigrationsDir(root), { recursive: true });
    mkdirSync(join(configMigrationsDir(root), "prepare-foo"));
    writeFileSync(join(configMigrationsDir(root), "prepare-foo", "before.json"), "kept", "utf8");

    let caught: unknown;
    try {
      listAbandonedConfigMigrationPreparations(root);
    } catch (error) {
      caught = error;
    }
    expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
    expect(existsSync(join(configMigrationsDir(root), "prepare-foo", "before.json"))).toBe(true);
  });

  test("throws a structural invalid-artifact error for a non-directory prepare-<run-id>, and never deletes it", () => {
    const root = tempRoot();
    const id = runId("1");
    mkdirSync(configMigrationsDir(root), { recursive: true });
    writeFileSync(join(configMigrationsDir(root), `prepare-${id}`), "not a directory", "utf8");

    let caught: unknown;
    try {
      listAbandonedConfigMigrationPreparations(root);
    } catch (error) {
      caught = error;
    }
    expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
    expect(existsSync(join(configMigrationsDir(root), `prepare-${id}`))).toBe(true);
  });

  linked("throws a structural invalid-artifact error for a linked prepare-<run-id>, and never deletes it", () => {
    const root = tempRoot();
    const id = runId("2");
    const outside = mkdtempSync(join(tmpdir(), "semctx-config-migration-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "before.json"), "leaked", "utf8");
    mkdirSync(configMigrationsDir(root), { recursive: true });
    link(outside, join(configMigrationsDir(root), `prepare-${id}`));

    let caught: unknown;
    try {
      listAbandonedConfigMigrationPreparations(root);
    } catch (error) {
      caught = error;
    }
    expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
    expect(existsSync(join(outside, "before.json"))).toBe(true);
  });

  test("throws a structural invalid-artifact error when config-migrations itself is not a directory", () => {
    const root = tempRoot();
    mkdirSync(semctxDir(root), { recursive: true });
    writeFileSync(configMigrationsDir(root), "not a directory", "utf8");

    let caught: unknown;
    try {
      listAbandonedConfigMigrationPreparations(root);
    } catch (error) {
      caught = error;
    }
    expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
  });
});

describe("listConfigMigrationRuns and run-artifact reads — structural validation", () => {
  for (const container of ["config-migrations", "runs"] as const) {
    test(`run readers refuse a regular-file ${container} ancestor before traversing children`, () => {
      const root = tempRoot();
      mkdirSync(semctxDir(root), { recursive: true });
      if (container === "runs") mkdirSync(configMigrationsDir(root), { recursive: true });
      const path = container === "runs" ? runsDir(root) : configMigrationsDir(root);
      writeFileSync(path, "retained ancestor", "utf8");
      for (const read of [readConfigMigrationManifest, readConfigMigrationBefore, readConfigMigrationAfter]) {
        let caught: unknown;
        try { read(root, runId("5")); } catch (error) { caught = error; }
        expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
      }
      expect(readFileSync(path, "utf8")).toBe("retained ancestor");
    });
  }

  test("throws a structural invalid-artifact error when runs/ itself is not a directory", () => {
    const root = tempRoot();
    mkdirSync(configMigrationsDir(root), { recursive: true });
    writeFileSync(runsDir(root), "not a directory", "utf8");

    let caught: unknown;
    try {
      listConfigMigrationRuns(root);
    } catch (error) {
      caught = error;
    }
    expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
  });

  test("listConfigMigrationRuns lists a run entry that is a regular file rather than filtering it out", () => {
    const root = tempRoot();
    const id = runId("3");
    mkdirSync(runsDir(root), { recursive: true });
    writeFileSync(join(runsDir(root), id), "not a directory", "utf8");

    expect(listConfigMigrationRuns(root)).toEqual([id]);
  });

  test("reading manifest/before/after of a run-file (not a directory) refuses structurally, identically on every platform", () => {
    const root = tempRoot();
    const id = runId("4");
    mkdirSync(runsDir(root), { recursive: true });
    writeFileSync(join(runsDir(root), id), "not a directory", "utf8");

    for (const read of [readConfigMigrationManifest, readConfigMigrationBefore, readConfigMigrationAfter]) {
      let caught: unknown;
      try {
        read(root, id);
      } catch (error) {
        caught = error;
      }
      expect(isConfigMigrationStructuralInvalidArtifact(caught)).toBe(true);
    }
    expect(readFileSync(join(runsDir(root), id), "utf8")).toBe("not a directory");
  });
});

describe("rewriteConfigMigrationManifest", () => {
  test("replaces the published manifest and reads back the new bytes", () => {
    const root = tempRoot();
    const id = runId("c");
    publishConfigMigrationRun(root, id, Buffer.from("b"), Buffer.from("a"), Buffer.from('{"state":"PREPARED"}'));
    rewriteConfigMigrationManifest(root, id, Buffer.from('{"state":"APPLIED"}'));
    expect(readConfigMigrationManifest(root, id).toString("utf8")).toBe('{"state":"APPLIED"}');
  });
});

describe("current config swap", () => {
  test("round-trips exact bytes through swapCurrentConfigBytes / readCurrentConfigBytes", () => {
    const root = tempRoot();
    seedConfig(root, '{"version":1}\n');
    expect(readCurrentConfigBytes(root).toString("utf8")).toBe('{"version":1}\n');
    swapCurrentConfigBytes(root, Buffer.from('{"version":1}\n', "utf8"), Buffer.from('{"version":2}\n', "utf8"));
    expect(readCurrentConfigBytes(root).toString("utf8")).toBe('{"version":2}\n');
  });

  test("refuses and leaves the temp behind when the live config no longer matches the expected preimage", () => {
    const root = tempRoot();
    seedConfig(root, '{"version":1}\n');
    let caught: unknown;
    try {
      swapCurrentConfigBytes(
        root,
        Buffer.from('{"version":0}\n', "utf8"),
        Buffer.from('{"version":2}\n', "utf8"),
      );
    } catch (error) {
      caught = error;
    }
    expect(isSemctxError(caught)).toBe(true);
    expect((caught as { details: Record<string, unknown> }).details["reason"]).toBe("PREIMAGE_DRIFTED");
    expect(readCurrentConfigBytes(root).toString("utf8")).toBe('{"version":1}\n');
  });
});

describe("publishConfigMigrationRun run-id collision", () => {
  test("refuses to replace an already-published run", () => {
    const root = tempRoot();
    const id = runId("f");
    publishConfigMigrationRun(root, id, Buffer.from("before-1"), Buffer.from("after-1"), Buffer.from("manifest-1"));

    expect(() =>
      publishConfigMigrationRun(root, id, Buffer.from("before-2"), Buffer.from("after-2"), Buffer.from("manifest-2")),
    ).toThrow();
    expect(readConfigMigrationBefore(root, id).toString("utf8")).toBe("before-1");
  });
});

describe("link safety", () => {
  linked("refuses a linked config-migrations directory before any write", () => {
    const root = tempRoot();
    const outside = mkdtempSync(join(tmpdir(), "semctx-config-migration-outside-"));
    roots.push(outside);
    mkdirSync(semctxDir(root), { recursive: true });
    link(outside, configMigrationsDir(root));

    let caught: unknown;
    try {
      publishConfigMigrationRun(root, runId("d"), Buffer.from(""), Buffer.from(""), Buffer.from(""));
    } catch (error) {
      caught = error;
    }
    expect(isSemctxError(caught)).toBe(true);
    expect(existsSync(join(outside, `prepare-${runId("d")}`))).toBe(false);
  });

  linked("refuses a linked run directory on read", () => {
    const root = tempRoot();
    const outside = mkdtempSync(join(tmpdir(), "semctx-config-migration-outside-"));
    roots.push(outside);
    const id = runId("e");
    mkdirSync(join(outside, id), { recursive: true });
    writeFileSync(join(outside, id, "before.json"), "leaked", "utf8");
    mkdirSync(runsDir(root), { recursive: true });
    link(join(outside, id), runDir(root, id));

    expect(() => readConfigMigrationBefore(root, id)).toThrow();
  });
});

describe("withConfigMigrationLock cleanup on every non-happy exit", () => {
  test("a callback throw releases the lock immediately for the next acquire", () => {
    const root = tempRoot();
    let caught: unknown;
    try {
      withConfigMigrationLock(root, () => {
        throw new Error("boom");
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error)?.message).toBe("boom");

    let ran = false;
    withConfigMigrationLock(root, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("a callback returning a thenable is rejected and still releases the lock for the next acquire", () => {
    const root = tempRoot();
    let caught: unknown;
    try {
      withConfigMigrationLock(root, () => Promise.resolve(1) as unknown as number);
    } catch (error) {
      caught = error;
    }
    expect(isSemctxError(caught)).toBe(true);

    let ran = false;
    withConfigMigrationLock(root, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

function waitForStdoutMarker(stream: ReadableStream<Uint8Array>, marker: string, timeoutMs: number): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    try {
      while (!buffer.includes(marker)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for marker ${marker}; observed: ${buffer}`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}: ${buffer}`)), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
        if (result.done) throw new Error(`child stdout closed before marker ${marker}; observed: ${buffer}`);
        buffer += decoder.decode(result.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

function lockChildSource(): string {
  return `
    import { writeSync } from "node:fs";
    import { withConfigMigrationLock } from "./packages/repository-store/src/config-migration-store.ts";
    const root = process.argv[1];
    withConfigMigrationLock(root, () => {
      writeSync(1, "SIGNAL:LOCKED\\n");
      while (true) { Bun.sleepSync(50); }
    });
  `;
}

function spawnLockChild(root: string) {
  return Bun.spawn([process.execPath, "-e", lockChildSource(), root], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
}

describe("cooperative mutex: real abrupt termination of the lock holder", () => {
  test(
    "a live holder makes a concurrent acquire fail fast, and a killed holder's lock is immediately recoverable",
    async () => {
      const root = tempRoot();
      const child = spawnLockChild(root);
      try {
        await waitForStdoutMarker(child.stdout, "SIGNAL:LOCKED", CRASH_TIMEOUT_MS);
        expect(child.exitCode).toBeNull();

        let caught: unknown;
        try {
          withConfigMigrationLock(root, () => undefined, 200);
        } catch (error) {
          caught = error;
        }
        expect(isSemctxError(caught)).toBe(true);
        expect((caught as { details: Record<string, unknown> }).details["reason"]).toBe("MUTEX_BUSY");

        child.kill("SIGKILL");
        await child.exited;

        let ran = false;
        withConfigMigrationLock(root, () => {
          ran = true;
        }, 2_000);
        expect(ran).toBe(true);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
    CRASH_TIMEOUT_MS + 10_000,
  );
});
