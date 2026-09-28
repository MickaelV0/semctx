import { describe, expect, test } from "bun:test";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDeliveryReportV2 } from "../src/plugin-delivery";
import type { InstallReport } from "../../../apps/cli/src/commands/install";

type RawHomeSource = "HOME" | "USERPROFILE" | "CODEX_HOME" | "OS_HOME";
interface ProductionObservation {
  report: PluginDeliveryReportV2;
  rawHits: number;
  phase: number;
  cachePath: string;
  nativeCalls: string[];
}
interface InstallObservation extends Omit<ProductionObservation, "report"> { report: InstallReport }
type SystemPolicy = "absent" | "disabled" | "unresolved" | "root-drift" | "raw-root-drift";
type FallbackFault = "safe" | "drift" | "link" | "regular";

function productionStatus(source: RawHomeSource, drift = false, orphan = false,
  systemPolicy: SystemPolicy = "absent"): ProductionObservation {
  return productionFixture(source, drift, orphan, systemPolicy) as ProductionObservation;
}

function productionInstall(fault: FallbackFault): InstallObservation {
  return productionFixture("OS_HOME", fault === "drift", false, "absent", "install", fault) as InstallObservation;
}

/** Module replacements stay in a child process; every filesystem observation is synthetic. */
function productionFixture(source: RawHomeSource, drift: boolean, orphan: boolean,
  systemPolicy: SystemPolicy, caller = "status", fallbackFault: FallbackFault = "safe",
): ProductionObservation | InstallObservation {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "plugin-delivery.ts")).href;
  const installUrl = pathToFileURL(join(import.meta.dir, "../../../apps/cli/src/commands/install.ts")).href;
  const argsUrl = pathToFileURL(join(import.meta.dir, "../../../apps/cli/src/args.ts")).href;
  const root = resolve(parse(process.cwd()).root, "semctx-production-boundary-fixture");
  const program = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import * as os from "node:os";
    import { basename, dirname, join, resolve, sep } from "node:path";
    const originalFs = { ...fs }, originalOs = { ...os };
    const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)};
    const drift = ${JSON.stringify(drift)}, orphan = ${JSON.stringify(orphan)};
    const systemPolicy = ${JSON.stringify(systemPolicy)}, caller = ${JSON.stringify(caller)};
    const fallbackFault = ${JSON.stringify(fallbackFault)};
    const repo = join(root, "repo"), home = join(root, "profile");
    const osHome = join(root, "os-home"), cancelled = join(root, "cancelled");
    const knownFolder = join(root, "known-program-data"), systemCancelled = join(root, "system-cancelled");
    const rawHome = cancelled + sep + ".." + sep + "os-home";
    const rawCodexHome = cancelled + sep + ".." + sep + "profile";
    const codexHome = source === "OS_HOME" ? join(osHome, ".codex") : home;
    const cachePath = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "local");
    const dirs = new Set(), files = new Map(), identities = new Map();
    let identity = 1, phase = 0, systemPhase = 0, rawHits = 0, nextDescriptor = 100;
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
    for (const path of [repo, home, osHome, cancelled, codexHome, knownFolder, systemCancelled, join(root, "owned-temp"),
      join(root, "program-data")]) addDirectory(path);
    if (process.platform !== "win32") addDirectory("/etc");
    addFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\\n");
    if (systemPolicy === "disabled") addFile(join(knownFolder, "OpenAI", "Codex", "config.toml"),
      "[features]\\nplugins = false\\n");
    if (orphan) addFile(join(cachePath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
    const missing = () => Object.assign(new Error("synthetic absence"), { code: "ENOENT" });
    const stat = (path) => {
      const physical = resolve(String(path));
      // The home marketplace is the last part of a snapshot. Swap its cancelled ancestor
      // only after that snapshot has captured the selected raw home traversal.
      if (drift && (source === "HOME" || source === "USERPROFILE")
        && physical === join(osHome, ".cursor-plugin")) phase = 1;
      if ((systemPolicy === "root-drift" || systemPolicy === "raw-root-drift")
        && physical === join(osHome, ".cursor-plugin")) systemPhase = 1;
      if (!dirs.has(physical) && !files.has(physical)) throw missing();
      if (physical === cancelled) rawHits += 1;
      return {
        dev: 1, ino: identities.get(physical)
          + (physical === cancelled ? phase * 1000 : 0)
          + (((systemPolicy === "root-drift" && physical === knownFolder)
            || (systemPolicy === "raw-root-drift" && physical === systemCancelled)) ? systemPhase * 1000 : 0),
        mode: dirs.has(physical) ? 16877 : 33188, size: files.get(physical)?.length ?? 0,
        isDirectory: () => dirs.has(physical) && !(physical === cancelled && fallbackFault === "regular"),
        isFile: () => files.has(physical) || (physical === cancelled && fallbackFault === "regular"),
        isSymbolicLink: () => physical === cancelled && fallbackFault === "link",
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
    if (source === "USERPROFILE" || (source === "OS_HOME" && caller === "status")) delete process.env.HOME;
    if (source === "OS_HOME" && caller === "status") delete process.env.USERPROFILE;
    process.env.ProgramData = join(root, "program-data");
    process.env.PROGRAMDATA = process.env.ProgramData;
    process.env.TEMP = join(root, "owned-temp");
    process.env.TMP = process.env.TEMP;
    process.env.TMPDIR = process.env.TEMP;
    // macOS managed-preference presence is also synthetic; no native process is launched.
    Bun.spawnSync = (argv) => {
      if (argv[0] === "/usr/bin/osascript") {
        nativeCalls.push("managed-preferences");
        return { exitCode: 0, stdout: Buffer.from("absent"), stderr: Buffer.alloc(0) };
      }
      if (basename(argv[0]).toLowerCase() === "powershell.exe") {
        nativeCalls.push("known-folder");
        const resolved = systemPolicy === "unresolved" ? "" : systemPolicy === "raw-root-drift"
          ? systemCancelled + sep + ".." + sep + "known-program-data" : knownFolder;
        return { exitCode: 0, stdout: Buffer.from(Buffer.from(resolved).toString("base64")), stderr: Buffer.alloc(0) };
      }
      if (caller === "install" && argv[0] === "git" && argv.includes("--show-toplevel")) {
        nativeCalls.push("git-root");
        return { exitCode: 0, stdout: Buffer.from(repo), stderr: Buffer.alloc(0) };
      }
      nativeCalls.push("unexpected:" + argv[0]);
      throw new Error("unexpected native query: " + argv[0]);
    };
    Bun.which = (name) => name === "codex" ? join(root, "bin", "codex") : null;
    const { pluginDeliveryStatus } = await import(${JSON.stringify(moduleUrl)});
    let report;
    if (caller === "install") {
      const { executeInstall } = await import(${JSON.stringify(installUrl)});
      const { parseArgs } = await import(${JSON.stringify(argsUrl)});
      report = executeInstall(repo, parseArgs(["install", "--host", "codex", "--dry-run", "--skip-setup"]));
    } else report = pluginDeliveryStatus(
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
  const result = JSON.parse(new TextDecoder().decode(child.stdout)) as ProductionObservation | InstallObservation;
  expect(result.nativeCalls.every((call) => call === "known-folder"
    || call === "managed-preferences" || (caller === "install" && call === "git-root"))).toBe(true);
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

describe("pluginDeliveryStatus production Windows policy authority", () => {
  test.skipIf(process.platform !== "win32")("redirected ProgramData cannot hide the actual known-folder policy", () => {
    const result = productionStatus("CODEX_HOME", false, false, "disabled");
    expect(result.report.hosts.codex.marketplace.configured).toBeNull();
    expect(result.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    expect(result.nativeCalls).toEqual(["known-folder"]);
  });

  test.skipIf(process.platform !== "win32")("actual system-policy absence is proven only after both known-folder reads", () => {
    const result = productionStatus("CODEX_HOME");
    expect(result.report.hosts.codex.marketplace.configured).toBe(false);
    expect(result.nativeCalls).toEqual(["known-folder", "known-folder"]);
  });

  for (const policy of ["unresolved", "root-drift", "raw-root-drift"] as const) {
    test.skipIf(process.platform !== "win32")(`Windows known-folder ${policy} remains unknown`, () => {
      const result = productionStatus("CODEX_HOME", false, false, policy);
      expect(result.report.hosts.codex.marketplace.configured).toBeNull();
      expect(result.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    });
  }
});

describe("executeInstall production fallback metadata boundary", () => {
  test("unchanged raw OS home remains a read-only default install plan", () => {
    const result = productionInstall("safe");
    expect(result.report.ok).toBe(true);
    expect(result.report.hosts.codex.status).toBe("planned");
  });

  for (const fault of ["drift", "link", "regular"] as const) {
    test(`raw fallback home ${fault} refuses the default installer callback before host mutation`, () => {
      const result = productionInstall(fault);
      expect(result.report.ok).toBe(false);
      expect(result.report.hosts.codex.status).toBe("failed");
      expect(result.report.hosts.codex.error).toContain("declarative plugin metadata safely");
      expect(result.rawHits).toBeGreaterThan(0);
      expect(result.nativeCalls).not.toContain("codex");
    });
  }
});
