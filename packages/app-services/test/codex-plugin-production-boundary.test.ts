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
interface ProductionJsonFixture {
  marketplace: string;
  dryRun?: boolean;
  artifacts?: { sidecar?: string | number[]; snapshotManifest?: string; payloadManifest?: string;
    configuredRef?: string | null; localSidecar?: boolean };
  recovery?: { snapshotManifest?: string; cacheManifest?: string };
}

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
  jsonFixture?: ProductionJsonFixture,
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
    const jsonFixture = ${JSON.stringify(jsonFixture ?? null)};
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
    if (jsonFixture !== null) {
      const marketplace = join(codexHome, ".tmp", "marketplaces", "semctx-stable");
      addDirectory(join(marketplace, "plugins", "semctx-control"));
      addFile(join(codexHome, "config.toml"),
        "[marketplaces.semctx-stable]\\nsource_type = 'git'\\nsource = 'hoklims/semctx'\\nref = 'stable'\\n");
      addFile(join(marketplace, ".agents", "plugins", "marketplace.json"), jsonFixture.marketplace);
      if (jsonFixture.artifacts !== undefined) {
        addFile(join(codexHome, "config.toml"),
          "[marketplaces.semctx-stable]\\nsource_type = " + (jsonFixture.artifacts.localSidecar ? "'local'" : "'git'")
          + "\\nsource = " + JSON.stringify(jsonFixture.artifacts.localSidecar ? marketplace : "hoklims/semctx") + "\\n"
          + (jsonFixture.artifacts.configuredRef === null || jsonFixture.artifacts.localSidecar ? ""
            : "ref = " + JSON.stringify(jsonFixture.artifacts.configuredRef ?? "stable") + "\\n")
          + "[plugins.'semctx-control@semctx-stable']\\nenabled = true\\n");
        const versionedCache = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.7");
        addFile(join(versionedCache, ".codex-plugin", "plugin.json"), jsonFixture.artifacts.payloadManifest
          ?? JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
        addFile(join(marketplace, "plugins", "semctx-control", ".codex-plugin", "plugin.json"),
          jsonFixture.artifacts.snapshotManifest ?? JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
        if (jsonFixture.artifacts.sidecar !== undefined) addFile(join(marketplace, ".codex-marketplace-install.json"),
          jsonFixture.artifacts.sidecar);
        if (jsonFixture.artifacts.localSidecar) addFile(join(marketplace, ".codex-marketplace-install.json"),
          JSON.stringify({ source_type: "local", source: marketplace, ref_name: null, sparse_paths: [], revision: "" }));
      }
      if (jsonFixture.recovery !== undefined) {
        addFile(join(codexHome, "config.toml"),
          "[marketplaces.semctx-stable]\\nsource_type = 'git'\\nsource = 'hoklims/semctx'\\nref = 'stable'\\n"
          + "[plugins.'semctx-control@semctx-stable']\\nenabled = true\\n");
        addFile(join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.6", ".codex-plugin", "plugin.json"),
          JSON.stringify({ name: "semctx-control", version: "0.3.6" }));
        addFile(join(marketplace, "plugins", "semctx-control", ".codex-plugin", "plugin.json"),
          jsonFixture.recovery.snapshotManifest ?? JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
        for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
          addFile(join(marketplace, "plugins", "semctx-control", "dist", bundle), "same bundle: " + bundle);
        }
      }
    }
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
      readFileSync: (path, options) => {
        const bytes = files.get(resolve(String(path)));
        if (bytes === undefined) throw missing();
        const encoding = typeof options === "string" ? options : options?.encoding;
        return encoding === undefined ? bytes : bytes.toString(encoding);
      },
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
      if (jsonFixture?.artifacts !== undefined && argv[0] === "git" && argv.includes("rev-parse")) {
        nativeCalls.push("git-read");
        return { exitCode: 0, stdout: Buffer.from(argv.includes("--abbrev-ref") ? "stable" : "1".repeat(40)),
          stderr: Buffer.alloc(0) };
      }
      if (caller === "install" && jsonFixture !== null && argv[0] === "codex") {
        nativeCalls.push("codex-attempt:" + argv.join(" "));
        if (jsonFixture.recovery !== undefined) {
          if (argv[1] === "plugin" && argv[2] === "marketplace") {
            return { exitCode: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
          }
          if (argv[1] === "plugin" && argv[2] === "add") {
            const versioned = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.7");
            addFile(join(versioned, ".codex-plugin", "plugin.json"), jsonFixture.recovery.cacheManifest
              ?? JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
            for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
              addFile(join(versioned, "dist", bundle), "same bundle: " + bundle);
            }
            return { exitCode: 1, stdout: Buffer.alloc(0),
              stderr: Buffer.from("failed to back up plugin cache entry: locked (os error 32)") };
          }
          if (argv[1] === "plugin" && argv[2] === "list") return {
            exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({ installed: [{
              pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: "0.3.7",
              source: { path: join(codexHome, ".tmp", "marketplaces", "semctx-stable", "plugins", "semctx-control") },
            }] })),
          };
        }
        return { exitCode: 9, stdout: Buffer.alloc(0), stderr: Buffer.from("native invocation intercepted") };
      }
      nativeCalls.push("unexpected:" + argv[0]);
      throw new Error("unexpected native query: " + argv[0]);
    };
    Bun.spawn = () => {
      nativeCalls.push("cleanup-scheduled");
      return { pid: 123, unref() {} };
    };
    Bun.which = (name) => name === "codex" ? join(root, "bin", "codex") : null;
    const { pluginDeliveryStatus } = await import(${JSON.stringify(moduleUrl)});
    let report;
    if (caller === "install") {
      const { executeInstall } = await import(${JSON.stringify(installUrl)});
      const { parseArgs } = await import(${JSON.stringify(argsUrl)});
      report = executeInstall(repo, parseArgs(["install", "--host", "codex", "--skip-setup",
        ...(jsonFixture?.dryRun === false ? [] : ["--dry-run"])]));
    } else report = pluginDeliveryStatus(
      { repositoryRoot: repo, version: "0.3.7", scope: "codex" },
      {
        findHostExecutable: () => join(root, "bin", "codex"),
        ...(jsonFixture?.artifacts?.payloadManifest === undefined ? {} : {
          // Keep inventory fixed to exercise the downstream production payload parser itself.
          readCodexPluginMetadata: () => ({
            marketplaces: [{ name: "semctx-stable", root: join(codexHome, ".tmp", "marketplaces", "semctx-stable"),
              marketplaceSource: { sourceType: "git", source: "hoklims/semctx" }, ref: "stable" }],
            plugins: [{ pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: "0.3.7",
              cachePath: join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.7") }],
          }),
        }),
        readRepositoryChannel: () => ({ commit: null, originIsSemctx: false }),
        ...(jsonFixture?.artifacts === undefined ? { readMarketplaceSnapshot: () => null } : {}),
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
    || call === "managed-preferences" || (caller === "install" && call === "git-root")
    || (jsonFixture?.artifacts !== undefined && call === "git-read")
    || (jsonFixture?.recovery !== undefined && call === "cleanup-scheduled")
    || (jsonFixture !== undefined && caller === "install" && call.startsWith("codex-attempt:")))).toBe(true);
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

describe("production Codex status artifact JSON", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const sidecar = '{"source_type":"git","source":"hoklims/semctx","ref_name":"stable","sparse_paths":[],"revision":"'
    + "1".repeat(40) + '"}';
  const observe = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) => {
    const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", { marketplace, artifacts });
    return observed as ProductionObservation;
  };
  const status = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) => observe(artifacts).report;

  for (const [name, value] of [
    ["missing sidecar structure", {}],
    ["numeric revision and ref", { source_type: "git", source: "hoklims/semctx", revision: 1, ref_name: 2 }],
    ["missing source identity", { source_type: "git", revision: "1".repeat(40), ref_name: "stable" }],
    ["unrecognized source type", { source_type: "unsupported", source: "hoklims/semctx", revision: "1".repeat(40) }],
    ["missing sparse paths", { source_type: "git", source: "hoklims/semctx", revision: "1".repeat(40), ref_name: "stable" }],
    ["wrong sparse element type", { source_type: "git", source: "hoklims/semctx", revision: "1".repeat(40),
      ref_name: "stable", sparse_paths: [1] }],
    ["raw revision whitespace", { source_type: "git", source: "hoklims/semctx", revision: " " + "1".repeat(40),
      ref_name: "stable", sparse_paths: [] }],
    ["contradictory source identity", { source_type: "git", source: "someone/else", revision: "1".repeat(40),
      ref_name: "stable", sparse_paths: [] }],
  ] as const) {
    test(`${name} refuses present sidecar without any Git fallback`, () => {
      const observed = observe({ sidecar: JSON.stringify(value) });
      expect({ version: observed.report.hosts.codex.snapshot.version,
        gitReads: observed.nativeCalls.filter((call) => call === "git-read"),
        unreadable: observed.report.hosts.codex.reasons.includes("SNAPSHOT_UNREADABLE") })
        .toEqual({ version: null, gitReads: [], unreadable: true });
    });
  }

  for (const [name, bytes] of [
    ["duplicate sidecar revision", sidecar.replace('"revision":', '"revision":"foreign","revision":')],
    ["escaped sidecar duplicate", sidecar.replace('"revision":', String.raw`"revision":"foreign","\u0072evision":`)],
    ["unpaired sidecar Unicode", sidecar.replace('"ref_name":"stable"', String.raw`"ref_name":"\ud800"`)],
    ["invalid sidecar syntax", "{"],
    ["empty present sidecar", ""],
    ["invalid sidecar UTF-8", [...Buffer.from('{"source_type":"git","source":"hoklims/semctx","ref_name":"'),
      0xff, ...Buffer.from('","revision":"' + "1".repeat(40) + '"}')]],
  ] as const) {
    test(`${name} remains unknown through the effective default status`, () => {
      const report = status({ sidecar: typeof bytes === "string" ? bytes : [...bytes] });
      expect(report.hosts.codex.snapshot.version).toBeNull();
      expect(report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
      expect(report.hosts.codex.delivery).toBe("UNKNOWN");
      expect(report.publicRelease.authority).toBe("absent");
    });
  }

  test("sidecar absence and a valid sidecar preserve version observations without release authority", () => {
    for (const artifacts of [{}, { sidecar }]) {
      const report = status(artifacts);
      expect(report.hosts.codex.snapshot.version).toBe("0.3.7");
      expect(report.hosts.codex.reasons).not.toContain("SNAPSHOT_UNREADABLE");
      expect(report.publicRelease.authority).toBe("absent");
    }
  });

  test("native optional refs and local identity remain readable without Git fallback", () => {
    const native = { source_type: "git", source: "hoklims/semctx", sparse_paths: [], revision: "1".repeat(40) };
    for (const artifacts of [{ sidecar: JSON.stringify(native), configuredRef: null },
      { sidecar: JSON.stringify({ ...native, ref_name: null }), configuredRef: null }, { localSidecar: true }]) {
      const observed = observe(artifacts);
      expect(observed.report.hosts.codex.snapshot.version).toBe("0.3.7");
      expect(observed.report.hosts.codex.reasons).not.toContain("SNAPSHOT_UNREADABLE");
      expect(observed.nativeCalls).not.toContain("git-read");
      expect(observed.report.publicRelease.authority).toBe("absent");
    }
  });

  const invalidManifest = '{"name":"semctx-control","version":"old","version":"0.3.7"}';
  test("a duplicate snapshot manifest version is unknown through default snapshot reads", () => {
    const report = status({ sidecar, snapshotManifest: invalidManifest });
    expect(report.hosts.codex.snapshot.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_VERSION_UNKNOWN");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
  });

  test("a duplicate payload manifest version is unknown through default payload reads", () => {
    const report = status({ sidecar, payloadManifest: invalidManifest });
    expect(report.hosts.codex.installed.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
  });
});

describe("default installer Windows cache-lock payload convergence", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const recover = (location: "snapshotManifest" | "cacheManifest", manifest: string) =>
    productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
      marketplace, dryRun: false, recovery: { [location]: manifest },
    }) as InstallObservation;

  for (const location of ["snapshotManifest", "cacheManifest"] as const) {
    for (const [name, manifest] of [
      ["duplicate version", '{"name":"semctx-control","version":"0.3.6","version":"0.3.7"}'],
      ["escaped equivalent version", String.raw`{"name":"semctx-control","version":"0.3.6","\u0076ersion":"0.3.7"}`],
      ["unpaired escaped surrogate", String.raw`{"name":"semctx-control","version":"0.3.7","notes":"\ud800"}`],
      ["plain stale version control", '{"name":"semctx-control","version":"0.3.6"}'],
    ] as const) {
      test.skipIf(process.platform !== "win32")(`${location} ${name} blocks native-lock recovery and cleanup`, () => {
        const observed = recover(location, manifest);
        expect({ ok: observed.report.ok, cleanup: observed.nativeCalls.includes("cleanup-scheduled"),
          deferred: observed.report.hosts.codex.cleanupDeferred === true })
          .toEqual({ ok: false, cleanup: false, deferred: false });
        expect(observed.report.hosts.codex.status).toBe("failed");
        expect(observed.report.hosts.codex.error).toContain("declares v");
      });
    }
  }

  test.skipIf(process.platform !== "win32")("plain current payloads prove recovery through the default reader", () => {
    const observed = recover("snapshotManifest", '{"name":"semctx-control","version":"0.3.7"}');
    expect(observed.report.ok).toBe(true);
    expect(observed.report.hosts.codex.cleanupDeferred).toBe(true);
    expect(observed.nativeCalls).toContain("cleanup-scheduled");
  });
});

describe("production Codex JSON metadata refusal", () => {
  const invalid = [
    ["duplicate marketplace identity", '{"name":"foreign","name":"semctx-stable","plugins":[]}'],
    ["escaped equivalent identity", String.raw`{"name":"foreign","\u006eame":"semctx-stable","plugins":[]}`],
    ["duplicate plugin identity", '{"name":"semctx-stable","plugins":[{"name":"foreign","name":"semctx-control",'
      + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}'],
    ["duplicate nested policy", '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
      + '"source":{"source":"local","path":"./plugins/semctx-control"},'
      + '"policy":{"installation":"NOT_AVAILABLE","installation":"AVAILABLE","products":["CODEX"]}}]}'],
    ["unpaired escaped high surrogate", String.raw`{"name":"semctx-stable","plugins":[],"interface":{"displayName":"\ud800"}}`],
    ["unpaired escaped low surrogate", String.raw`{"name":"semctx-stable","plugins":[],"interface":{"displayName":"\udc00"}}`],
    ["unpaired escaped surrogate key", String.raw`{"name":"semctx-stable","plugins":[],"\ud800":true}`],
  ] as const;

  for (const [name, marketplace] of invalid) {
    test(`${name} refuses default status and installer planning/apply before any native invocation`, () => {
      const status = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe",
        { marketplace }) as ProductionObservation;
      const dryRun = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
        { marketplace }) as InstallObservation;
      const apply = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
        { marketplace, dryRun: false }) as InstallObservation;
      expect({
        marketplaceConfigured: status.report.hosts.codex.marketplace.configured,
        dryRunStatus: dryRun.report.hosts.codex.status,
        applyStatus: apply.report.hosts.codex.status,
        nativeAttempts: [...dryRun.nativeCalls, ...apply.nativeCalls].filter((call) => call.startsWith("codex-attempt:")),
      }).toEqual({ marketplaceConfigured: null, dryRunStatus: "failed", applyStatus: "failed", nativeAttempts: [] });
      expect(status.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
      expect(apply.report.hosts.codex.error).toContain("declarative plugin metadata safely");
    });
  }

  test("distinct nested scopes, quoted JSON and valid paired/raw Unicode remain admissible", () => {
    const marketplace = JSON.stringify({
      name: "semctx-stable", plugins: [], interface: { displayName: "Emoji 😀" },
      first: { name: "one", items: [{ name: "two" }, { name: "three" }],
        quoted: '{"name":"foreign","name":"semctx-stable"}', escaped: '\\ud800',
        punctuation: '\\"{,}:[]', "é": 1, "e\u0301": 2 },
      second: { name: "four", items: ["name", "name", null, true, -1.2e3] },
    }).replace('"displayName":"Emoji 😀"', String.raw`"displayName":"Emoji \ud83d\ude00"`);
    const status = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe",
      { marketplace }) as ProductionObservation;
    const install = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
      { marketplace }) as InstallObservation;
    expect(status.report.hosts.codex.marketplace.configured).toBe(true);
    expect(install.report.ok).toBe(true);
    expect(install.report.hosts.codex.status).toBe("planned");
    expect(install.nativeCalls.some((call) => call.startsWith("codex-attempt:"))).toBe(false);
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
