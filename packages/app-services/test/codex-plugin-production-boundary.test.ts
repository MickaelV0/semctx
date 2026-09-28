import { describe, expect, test } from "bun:test";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDeliveryReportV2 } from "../src/plugin-delivery";

type RawHomeSource = "HOME" | "USERPROFILE" | "CODEX_HOME" | "OS_HOME";
interface ProductionObservation {
  report: PluginDeliveryReportV2;
  rawHits: number;
  phase: number;
  cachePath: string;
  nativeCalls: string[];
}

/** Module replacements stay in a child process; every filesystem observation is synthetic. */
function productionStatus(source: RawHomeSource, drift = false, orphan = false): ProductionObservation {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "plugin-delivery.ts")).href;
  const root = resolve(parse(process.cwd()).root, "semctx-production-boundary-fixture");
  const program = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import * as os from "node:os";
    import { basename, dirname, join, resolve, sep } from "node:path";
    const originalFs = { ...fs }, originalOs = { ...os };
    const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)};
    const drift = ${JSON.stringify(drift)}, orphan = ${JSON.stringify(orphan)};
    const repo = join(root, "repo"), home = join(root, "profile");
    const osHome = join(root, "os-home"), cancelled = join(root, "cancelled");
    const rawHome = cancelled + sep + ".." + sep + "os-home";
    const rawCodexHome = cancelled + sep + ".." + sep + "profile";
    const codexHome = source === "OS_HOME" ? join(osHome, ".codex") : home;
    const cachePath = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "local");
    const dirs = new Set(), files = new Map(), identities = new Map();
    let identity = 1, phase = 0, rawHits = 0, nextDescriptor = 100;
    const nativeCalls = [], descriptors = new Map();
    const addDirectory = (path) => {
      let current = resolve(path);
      for (;;) {
        dirs.add(current);
        if (!identities.has(current)) identities.set(current, identity++);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };
    const addFile = (path, text) => {
      addDirectory(dirname(path));
      files.set(path, Buffer.from(text));
      identities.set(path, identity++);
    };
    for (const path of [repo, home, osHome, cancelled, codexHome, join(root, "program-data")]) addDirectory(path);
    if (process.platform !== "win32") addDirectory("/etc");
    addFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\\n");
    if (orphan) addFile(join(cachePath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
    const missing = () => Object.assign(new Error("synthetic absence"), { code: "ENOENT" });
    const stat = (path) => {
      const physical = resolve(String(path));
      // The home marketplace is the last part of a snapshot. Swap its cancelled ancestor
      // only after that snapshot has captured the selected raw home traversal.
      if (drift && (source === "HOME" || source === "USERPROFILE")
        && physical === join(osHome, ".cursor-plugin")) phase = 1;
      if (!dirs.has(physical) && !files.has(physical)) throw missing();
      if (physical === cancelled) rawHits += 1;
      return {
        dev: 1, ino: identities.get(physical) + (physical === cancelled ? phase * 1000 : 0),
        mode: dirs.has(physical) ? 16877 : 33188, size: files.get(physical)?.length ?? 0,
        isDirectory: () => dirs.has(physical), isFile: () => files.has(physical), isSymbolicLink: () => false,
      };
    };
    const realpath = (path) => { stat(path); return resolve(String(path)); };
    realpath.native = realpath;
    mock.module("node:fs", () => ({
      ...originalFs,
      lstatSync: stat, realpathSync: realpath,
      existsSync: (path) => dirs.has(resolve(String(path))) || files.has(resolve(String(path))),
      openSync: (path) => {
        const physical = resolve(String(path));
        if (!files.has(physical)) throw missing();
        const descriptor = nextDescriptor++;
        descriptors.set(descriptor, { path: physical, offset: 0 });
        return descriptor;
      },
      fstatSync: (descriptor) => stat(descriptors.get(descriptor).path),
      readSync: (descriptor, buffer, offset, length, position) => {
        const opened = descriptors.get(descriptor), bytes = files.get(opened.path);
        const start = position ?? opened.offset, count = Math.max(0, Math.min(length, bytes.length - start));
        bytes.copy(buffer, offset, start, start + count);
        opened.offset = start + count;
        return count;
      },
      closeSync: (descriptor) => {
        const opened = descriptors.get(descriptor);
        if (drift && (source === "CODEX_HOME" || source === "OS_HOME")
          && opened.path === join(repo, ".git", "HEAD")) phase = 1;
        descriptors.delete(descriptor);
      },
      readdirSync: (path) => [...dirs].filter((entry) => dirname(entry) === resolve(String(path))
        && entry !== resolve(String(path))).map((entry) => ({
          name: basename(entry), isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
        })),
    }));
    mock.module("node:os", () => ({ ...originalOs, homedir: () => source === "OS_HOME" ? rawHome : osHome }));
    process.env.CODEX_HOME = source === "CODEX_HOME" ? rawCodexHome : codexHome;
    if (source === "OS_HOME") delete process.env.CODEX_HOME;
    process.env.HOME = source === "HOME" ? rawHome : osHome;
    process.env.USERPROFILE = source === "USERPROFILE" ? rawHome : osHome;
    if (source === "USERPROFILE" || source === "OS_HOME") delete process.env.HOME;
    if (source === "OS_HOME") delete process.env.USERPROFILE;
    process.env.ProgramData = join(root, "program-data");
    process.env.PROGRAMDATA = process.env.ProgramData;
    // macOS managed-preference presence is also synthetic; no native process is launched.
    Bun.spawnSync = (argv) => {
      if (argv[0] !== "/usr/bin/osascript") throw new Error("unexpected native query: " + argv[0]);
      nativeCalls.push("managed-preferences");
      return { exitCode: 0, stdout: Buffer.from("absent"), stderr: Buffer.alloc(0) };
    };
    const { pluginDeliveryStatus } = await import(${JSON.stringify(moduleUrl)});
    const report = pluginDeliveryStatus(
      { repositoryRoot: repo, version: "0.3.7", scope: "codex" },
      {
        findHostExecutable: () => join(root, "bin", "codex"),
        readRepositoryChannel: () => ({ commit: null, originIsSemctx: false }),
        resolvePublicRelease: () => ({ status: "unresolved", authority: "absent", version: null,
          commit: null, source: null, bundles: null, reasons: [] }),
      },
    );
    process.stdout.write(JSON.stringify({ report, rawHits, phase, cachePath, nativeCalls }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout)) as ProductionObservation;
  expect(result.nativeCalls).toEqual(process.platform === "darwin" ? ["managed-preferences", "managed-preferences"] : []);
  return result;
}

describe("pluginDeliveryStatus production Codex metadata boundary", () => {
  for (const source of ["HOME", "USERPROFILE", "CODEX_HOME", "OS_HOME"] as const) {
    test(`raw ${source} cancelled-directory inode drift stays unknown through the default service`, () => {
      const unchanged = productionStatus(source);
      expect(unchanged.rawHits).toBeGreaterThan(0);
      expect(unchanged.report.hosts.codex.marketplace.configured).toBe(false);
      expect(unchanged.report.hosts.codex.installed.installed).toBeNull();

      const changed = productionStatus(source, true);
      expect(changed.phase).toBe(1);
      expect(changed.rawHits).toBeGreaterThan(0);
      expect(changed.report.hosts.codex.marketplace.configured).toBeNull();
      expect(changed.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
      expect(changed.report.hosts.codex.reasons).not.toContain("MARKETPLACE_NOT_CONFIGURED");
      expect(changed.report.hosts.codex.delivery).toBe("UNKNOWN");
    });
  }

  test("orphan physical local cache remains visible through the default public service", () => {
    const result = productionStatus("CODEX_HOME", false, true);
    const state = result.report.hosts.codex;
    expect(state.marketplace.configured).toBe(false);
    expect(state.installed).toEqual({
      installed: true, path: result.cachePath, version: "0.3.7", enabled: null,
      contentMatchesSnapshot: null, contentMatchesPublicRelease: null,
    });
    expect(state.session.status).toBe("unknown");
    expect(state.session.version).toBeNull();
    expect(state.updateAvailable).toBeNull();
    expect(state.delivery).toBe("UNKNOWN");
    expect(state.verdict).toBe("UNKNOWN");
    expect(state.activation).toBeNull();
    expect(state.convergence).toEqual([]);
    expect(state.reasons).toContain("MARKETPLACE_NOT_CONFIGURED");
  });
});
