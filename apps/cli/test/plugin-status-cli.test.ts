import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const roots: string[] = [];

/**
 * Each case spawns the real CLI, which loads the whole TypeScript entrypoint through Bun. That is
 * seconds per spawn on Windows, so the default per-test budget is raised the way the packaged
 * runtime suite already does (#87) rather than trading away the end-to-end coverage.
 */
const SPAWN_TIMEOUT_MS = 60_000;

/** Isolated, throwaway root: the diagnostic must never depend on, or touch, a real workspace. */
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-plugin-status-cli-"));
  roots.push(root);
  return root;
}

/**
 * `PATH: ""` makes the run deterministic on any machine: no host CLI and no `git` can resolve, so
 * every layer is legitimately unprovable and the fail-closed contract is what gets exercised.
 */
function runPluginStatus(
  root: string,
  { json = false, path = "", args = [] }: { json?: boolean; path?: string; args?: readonly string[] } = {},
): { code: number; out: string } {
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    CLI,
    "plugin-status",
    "--root",
    root,
    ...args,
    ...(json ? ["--json"] : []),
  ], {
    env: { ...process.env, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    out: new TextDecoder().decode(result.stdout),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("semctx plugin-status — read-only cross-host delivery report", () => {
  test("is listed in the CLI help", () => {
    const result = Bun.spawnSync([process.execPath, "run", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(out).toContain("plugin-status");
  }, SPAWN_TIMEOUT_MS);

  test("emits the versioned machine contract and fails closed when no evidence resolves", () => {
    // `--host all` names both hosts, so their absence is part of the answer rather than omitted.
    const result = runPluginStatus(temporaryRoot(), { json: true, args: ["--host", "all"] });
    const report = JSON.parse(result.out);

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("plugin_delivery_status");
    // No host, no git, therefore no proof — and therefore never UP_TO_DATE.
    expect(report.verdict).toBe("UNKNOWN");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.publicRelease.status).toBe("unknown");
    expect(report.hosts.codex.detected).toBe(false);
    expect(report.hosts.claude.detected).toBe(false);
    expect(report.hosts.codex.reasons).toContain("HOST_NOT_DETECTED");
    expect(report.hosts.codex.updateAvailable).toBeNull();
    expect(result.code).toBe(3);
  }, SPAWN_TIMEOUT_MS);

  test("never claims the repository checkout delivers anything", () => {
    const result = runPluginStatus(temporaryRoot(), { json: true });
    const report = JSON.parse(result.out);

    expect(report.repository.conveysDelivery).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  test("is deterministic: two runs over identical evidence are byte-identical", () => {
    const root = temporaryRoot();
    const first = runPluginStatus(root, { json: true });
    const second = runPluginStatus(root, { json: true });

    expect(second.out).toBe(first.out);
    expect(second.code).toBe(first.code);
  }, SPAWN_TIMEOUT_MS);

  test("writes nothing into the repository root it inspects", () => {
    const root = temporaryRoot();
    runPluginStatus(root, { json: true });

    // A read-only diagnostic must not initialise a workspace or leave any artifact behind.
    expect(Array.from(new Bun.Glob("**/*").scanSync({ cwd: root, dot: true }))).toEqual([]);
  }, SPAWN_TIMEOUT_MS);

  test("prints the three delivery layers and the activation step in human output", () => {
    const result = runPluginStatus(temporaryRoot());

    expect(result.out).toContain("repository");
    expect(result.out).toContain("stable");
    expect(result.out).toContain("delivery");
    expect(result.code).toBe(3);
  }, SPAWN_TIMEOUT_MS);
});
