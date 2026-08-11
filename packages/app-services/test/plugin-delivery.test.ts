import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_DELIVERY_MAX_BUNDLE_BYTES,
  PLUGIN_DELIVERY_MAX_MANIFEST_BYTES,
  PLUGIN_DELIVERY_RELEASE_URL,
  PLUGIN_RUNTIME_BUNDLES,
  pluginDeliveryStatus,
  type InstalledPayloadProbe,
  type MarketplaceSnapshotProbe,
  type PluginDeliveryDependencies,
  type PluginDeliveryHost,
  type PluginDeliveryQueryOutcome,
  type PluginDeliveryReportV1,
  type PublicReleaseBundleWitnesses,
  type PublicReleaseProbe,
} from "../src/plugin-delivery";

/**
 * The measured 2026-08-10 state this contract exists for: `main` carries one commit more than the
 * public `stable` release while both declare the same SemVer. Nothing below may collapse those.
 */
const MAIN_COMMIT = "1acf1f14a5fb76a66e9686ba284081c29dd838d8";
const STABLE_COMMIT = "0173f8938facc1f1e91b25cba2275f838a1eba3a";
const RELEASE_VERSION = "0.1.17";

// Absolute on every platform, and never touched on disk: the fake dependencies answer all probes.
const CODEX_HOME = join(tmpdir(), "semctx-fake-codex-delivery");
const CODEX_MARKETPLACE_ROOT = join(CODEX_HOME, ".tmp", "marketplaces", "semctx-stable");
const CODEX_CACHE_ROOT = join(CODEX_HOME, "plugins", "cache", "semctx-stable", "semctx-control");
const CODEX_CACHE_PATH = join(CODEX_CACHE_ROOT, RELEASE_VERSION);
const CLAUDE_HOME = join(tmpdir(), "semctx-fake-claude-delivery");
const CLAUDE_MARKETPLACE_ROOT = join(CLAUDE_HOME, "plugins", "marketplaces", "semctx-stable");
const CLAUDE_CACHE_ROOT = join(CLAUDE_HOME, "plugins", "cache", "semctx-stable", "semctx");
const CLAUDE_CACHE_PATH = join(CLAUDE_CACHE_ROOT, RELEASE_VERSION);

const SEMCTX_SOURCE = "https://github.com/hoklims/semctx.git";
/** Stands in for a user's own project: the diagnostic inspects it, it never authorises anything. */
const CONSUMER_ROOT = join(tmpdir(), "semctx-consumer-project");

/** Every command the diagnostic is allowed to run. Anything else is a mutation of user state. */
const READ_ONLY_QUERIES = [
  "codex --version",
  "codex plugin marketplace list --json",
  "codex plugin list --json",
  "claude --version",
  "claude plugin marketplace list --json",
  "claude plugin list --json",
];

/** Verbs that change installed plugin state; none may ever appear in a recorded command. */
const MUTATING_VERBS = [
  "add",
  "install",
  "update",
  "upgrade",
  "remove",
  "uninstall",
  "enable",
  "disable",
  "promote",
  "publish",
  "push",
  "fetch",
];

interface FakeOptions {
  codexDetected?: boolean;
  claudeDetected?: boolean;
  codexMarketplaces?: unknown;
  codexPlugins?: unknown;
  claudeMarketplaces?: unknown;
  claudePlugins?: unknown;
  /** Marketplace snapshot, keyed by absolute marketplace root. */
  snapshots?: Record<string, Partial<MarketplaceSnapshotProbe> | null>;
  /** Installed cache payload, keyed by absolute cache path. */
  installed?: Record<string, Partial<InstalledPayloadProbe> | null>;
  hostHomes?: Partial<Record<PluginDeliveryHost, string | null>>;
  publicRelease?: Partial<PublicReleaseProbe> & Record<string, unknown>;
  scope?: Parameters<typeof pluginDeliveryStatus>[0]["scope"];
  /** Per-command outcome overrides, keyed by the joined argv. */
  queryOutcomes?: Record<string, Partial<{ code: number; out: string; err: string; timedOut: boolean; truncated: boolean }>>;
  repositoryChannel?: ReturnType<PluginDeliveryDependencies["readRepositoryChannel"]>;
  sessions?: Partial<Record<PluginDeliveryHost, ReturnType<PluginDeliveryDependencies["observeSessionVersion"]>>>;
  failQuery?: string;
}

/**
 * The subcommand of a Git argv, past the top-level options. `-c key=value` pairs are skipped as a
 * pair: their value does not start with `-`, so a naive scan would read the configuration as the
 * verb and mistake a hardened `fetch` for something else entirely.
 */
function gitVerb(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-c") {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return "";
}

/** Digests standing in for the split runtime; equal on both sides means proven-identical bytes. */
function digests(overrides: Record<string, string | null> = {}): Record<string, string | null> {
  const bundles: Record<string, string | null> = {};
  for (const name of PLUGIN_RUNTIME_BUNDLES) bundles[name] = `${name}-digest`;
  return { ...bundles, ...overrides };
}

/**
 * Release-side witnesses. A coherent release ships the same split runtime to both host plugins, so
 * the default carries one record per host with identical contents; a test that wants a divergent
 * release states it explicitly.
 */
function witnesses(overrides: Record<string, string | null> = {}): PublicReleaseBundleWitnesses {
  return { codex: digests(overrides), claude: digests(overrides) };
}

function snapshotProbe(overrides: Partial<MarketplaceSnapshotProbe> = {}): MarketplaceSnapshotProbe {
  return {
    commit: STABLE_COMMIT,
    ref: "stable",
    source: SEMCTX_SOURCE,
    version: RELEASE_VERSION,
    bundles: digests(),
    ...overrides,
  };
}

function installedProbe(overrides: Partial<InstalledPayloadProbe> = {}): InstalledPayloadProbe {
  return { version: RELEASE_VERSION, bundles: digests(), ...overrides };
}

function codexMarketplaces(overrides: Record<string, unknown> = {}): unknown {
  return {
    marketplaces: [
      {
        name: "semctx-stable",
        root: CODEX_MARKETPLACE_ROOT,
        marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        ...overrides,
      },
    ],
  };
}

function codexPlugins(overrides: Record<string, unknown> = {}): unknown {
  return {
    installed: [
      {
        pluginId: "semctx-control@semctx-stable",
        name: "semctx-control",
        marketplaceName: "semctx-stable",
        version: RELEASE_VERSION,
        installed: true,
        enabled: true,
        source: { source: "local", path: `${CODEX_MARKETPLACE_ROOT}/plugins/semctx-control` },
        marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        ...overrides,
      },
    ],
  };
}

function claudeMarketplaces(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      name: "semctx-stable",
      source: "github",
      repo: "hoklims/semctx",
      ref: "stable",
      installLocation: CLAUDE_MARKETPLACE_ROOT,
      ...overrides,
    },
  ];
}

function claudePlugins(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      id: "semctx@semctx-stable",
      version: RELEASE_VERSION,
      scope: "user",
      enabled: true,
      installPath: CLAUDE_CACHE_PATH,
      ...overrides,
    },
  ];
}

function fakeDependencies(
  options: FakeOptions = {},
): PluginDeliveryDependencies & { queries: string[][] } {
  const queries: string[][] = [];
  const ok = (out: string): { code: number; out: string; err: string } => ({ code: 0, out, err: "" });

  return {
    queries,
    runQuery(command, _cwd) {
      const argv = [...command];
      queries.push(argv);
      const joined = argv.join(" ");
      const override = options.queryOutcomes?.[joined];
      if (override !== undefined) {
        return { code: 1, out: "", err: "", ...override };
      }
      if (joined === options.failQuery) {
        return { code: 1, out: "", err: "injected query failure" };
      }
      if (joined === "codex --version") {
        return options.codexDetected === false
          ? { code: 1, out: "", err: "codex not found" }
          : ok("codex-cli 0.144.6\n");
      }
      if (joined === "claude --version") {
        return options.claudeDetected === false
          ? { code: 1, out: "", err: "claude not found" }
          : ok("2.1.220\n");
      }
      if (joined === "codex plugin marketplace list --json") {
        return ok(JSON.stringify(options.codexMarketplaces ?? codexMarketplaces()));
      }
      if (joined === "codex plugin list --json") {
        return ok(JSON.stringify(options.codexPlugins ?? codexPlugins()));
      }
      if (joined === "claude plugin marketplace list --json") {
        return ok(JSON.stringify(options.claudeMarketplaces ?? claudeMarketplaces()));
      }
      if (joined === "claude plugin list --json") {
        return ok(JSON.stringify(options.claudePlugins ?? claudePlugins()));
      }
      throw new Error(`unexpected query: ${joined}`);
    },
    readMarketplaceSnapshot(_host, root) {
      const defaults: Record<string, Partial<MarketplaceSnapshotProbe>> = {
        [CODEX_MARKETPLACE_ROOT]: {},
        [CLAUDE_MARKETPLACE_ROOT]: {},
      };
      const found = (options.snapshots ?? defaults)[root];
      return found === undefined || found === null ? null : snapshotProbe(found);
    },
    readInstalledPayload(_host, path) {
      const defaults: Record<string, Partial<InstalledPayloadProbe>> = {
        [CODEX_CACHE_PATH]: {},
        [CLAUDE_CACHE_PATH]: {},
      };
      const found = (options.installed ?? defaults)[path];
      return found === undefined || found === null ? null : installedProbe(found);
    },
    resolveHostHome(host) {
      const configured = options.hostHomes?.[host];
      if (configured !== undefined) return configured;
      return host === "codex" ? CODEX_HOME : CLAUDE_HOME;
    },
    readRepositoryChannel(_root) {
      return options.repositoryChannel ?? { commit: MAIN_COMMIT, originIsSemctx: true };
    },
    resolvePublicRelease(_root) {
      return {
        authority: "attested-release",
        status: "resolved",
        version: RELEASE_VERSION,
        commit: STABLE_COMMIT,
        source: "attested-public-release",
        reasons: [],
        bundles: witnesses(),
        ...(options.publicRelease ?? {}),
      } as PublicReleaseProbe;
    },
    observeSessionVersion(host) {
      return options.sessions?.[host] ?? {
        status: "observed",
        version: RELEASE_VERSION,
        reason: null,
      };
    },
  };
}

function statusOf(options: FakeOptions = {}): PluginDeliveryReportV1 {
  return pluginDeliveryStatus(
    {
      repositoryRoot: "/work/project",
      version: RELEASE_VERSION,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    },
    fakeDependencies(options),
  );
}

describe("plugin delivery — five distinct layers", () => {
  test("emits a versioned, deterministic contract envelope", () => {
    const report = statusOf();

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("plugin_delivery_status");
    // Determinism: two evaluations of identical evidence are byte-identical.
    expect(JSON.stringify(statusOf())).toBe(JSON.stringify(report));
  });

  test("reports a fully converged state as UP_TO_DATE", () => {
    const report = statusOf();

    expect(report.verdict).toBe("UP_TO_DATE");
    expect(report.hosts.codex.verdict).toBe("UP_TO_DATE");
    expect(report.hosts.claude.verdict).toBe("UP_TO_DATE");
    expect(report.hosts.codex.updateAvailable).toBe(false);
    expect(report.hosts.claude.updateAvailable).toBe(false);
  });

  test("reports the configured source and ref, the snapshot commit, and the installed cache separately per host", () => {
    const report = statusOf();

    expect(report.hosts.codex.marketplace).toMatchObject({
      name: "semctx-stable",
      configured: true,
      source: SEMCTX_SOURCE,
      ref: "stable",
      matchesSemctx: true,
    });
    expect(report.hosts.codex.snapshot).toMatchObject({ commit: STABLE_COMMIT, version: RELEASE_VERSION });
    expect(report.hosts.codex.installed).toMatchObject({
      version: RELEASE_VERSION,
      path: CODEX_CACHE_PATH,
      enabled: true,
    });

    expect(report.hosts.claude.marketplace).toMatchObject({
      name: "semctx-stable",
      configured: true,
      ref: "stable",
      matchesSemctx: true,
    });
    expect(report.hosts.claude.snapshot).toMatchObject({ commit: STABLE_COMMIT });
    expect(report.hosts.claude.installed).toMatchObject({
      version: RELEASE_VERSION,
      path: CLAUDE_CACHE_PATH,
    });
  });

  test("keeps the marketplace snapshot distinct from the executed cache", () => {
    const report = statusOf();

    // The snapshot path is never reported as the installed cache path.
    expect(report.hosts.codex.installed.path).not.toBe(CODEX_MARKETPLACE_ROOT);
    expect(report.hosts.claude.installed.path).not.toBe(CLAUDE_MARKETPLACE_ROOT);
  });
});

describe("plugin delivery — main is informative and never confers freshness", () => {
  test("main ahead of stable at the same SemVer stays UP_TO_DATE and is flagged as ahead", () => {
    const report = statusOf();

    // The measured case: different commits, identical version.
    expect(report.repository.commit).toBe(MAIN_COMMIT);
    expect(report.publicRelease.commit).toBe(STABLE_COMMIT);
    // Identical SemVer on both channels, at different commits — the case a version check misses.
    expect(report.repository.version).toBe(RELEASE_VERSION);
    expect(report.publicRelease.version).toBe(RELEASE_VERSION);
    expect(report.repository.commit).not.toBe(STABLE_COMMIT);

    // Reported as "not the released commit" — ancestry is not proven, so it is never claimed.
    expect(report.repository.matchesPublicRelease).toBe(false);
    // Being ahead on main must not degrade, nor improve, the delivery verdict.
    expect(report.verdict).toBe("UP_TO_DATE");
  });

  test("the repository channel structurally declares that it conveys no delivery freshness", () => {
    const report = statusOf();

    expect(report.repository.conveysDelivery).toBe(false);
  });

  test("a repository ahead of the release never makes an outdated cache look current", () => {
    const report = statusOf({
      installed: { [CODEX_CACHE_PATH]: { version: "0.1.16" }, [CLAUDE_CACHE_PATH]: { version: "0.1.16" } },
    });

    expect(report.repository.matchesPublicRelease).toBe(false);
    expect(report.verdict).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_NOT_PUBLIC_RELEASE");
  });
});

describe("plugin delivery — layer transitions", () => {
  test("stable ahead of the marketplace snapshot yields UPDATE_AVAILABLE", () => {
    const report = statusOf({
      publicRelease: {
        status: "resolved",
        version: "0.1.18",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "attested-public-release",
        reasons: [],
        bundles: witnesses({ "semctx.js": "next-release-bytes" }),
      },
    });

    expect(report.verdict).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.codex.updateAvailable).toBe(true);
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_BEHIND_PUBLIC_RELEASE");
    expect(report.hosts.claude.reasons).toContain("SNAPSHOT_BEHIND_PUBLIC_RELEASE");
  });

  test("marketplace snapshot ahead of the installed cache yields UPDATE_AVAILABLE", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: {
          commit: STABLE_COMMIT,
          ref: "stable",
          source: SEMCTX_SOURCE,
          version: RELEASE_VERSION,
        },
        [CLAUDE_MARKETPLACE_ROOT]: {
          commit: STABLE_COMMIT,
          ref: "stable",
          source: SEMCTX_SOURCE,
          version: RELEASE_VERSION,
        },
      },
      codexPlugins: codexPlugins({ version: "0.1.16" }),
      claudePlugins: claudePlugins({
        version: "0.1.16",
        installPath: join(CLAUDE_CACHE_ROOT, "0.1.16"),
      }),
      installed: {
        [join(CODEX_CACHE_ROOT, "0.1.16")]: { version: "0.1.16", bundles: digests({ "semctx.js": "old" }) },
        [join(CLAUDE_CACHE_ROOT, "0.1.16")]: { version: "0.1.16", bundles: digests({ "semctx.js": "old" }) },
      },
    });

    expect(report.verdict).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_BEHIND_SNAPSHOT");
    expect(report.hosts.claude.reasons).toContain("INSTALLED_CACHE_BEHIND_SNAPSHOT");
  });

  test("installed cache ahead of the active session is never reported as converged", () => {
    const report = statusOf({
      sessions: {
        codex: { status: "observed", version: "0.1.16", reason: null },
        claude: { status: "observed", version: "0.1.16", reason: null },
      },
    });

    expect(report.hosts.codex.session).toMatchObject({ status: "observed", version: "0.1.16" });
    expect(report.hosts.codex.reasons).toContain("SESSION_BEHIND_INSTALLED_CACHE");
    expect(report.hosts.codex.verdict).not.toBe("UP_TO_DATE");
    expect(report.hosts.claude.verdict).not.toBe("UP_TO_DATE");
    expect(report.verdict).not.toBe("UP_TO_DATE");
  });
});

describe("plugin delivery — the cache is proven by content, not by version string", () => {
  test("a stale cache that kept its version-keyed directory is never UP_TO_DATE", () => {
    // The #92 shape: `plugin add` could not replace a locked entry, so the directory name and the
    // manifest still say 0.1.17 while the bytes are the previous release.
    const report = statusOf({
      installed: {
        [CODEX_CACHE_PATH]: { version: RELEASE_VERSION, bundles: digests({ "semctx.js": "stale-bytes" }) },
        [CLAUDE_CACHE_PATH]: { version: RELEASE_VERSION, bundles: digests({ "semctx.js": "stale-bytes" }) },
      },
    });

    expect(report.hosts.codex.installed.version).toBe(RELEASE_VERSION);
    expect(report.hosts.codex.installed.contentMatchesSnapshot).toBe(false);
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_CONTENT_DIVERGED");
    expect(report.hosts.codex.delivery).toBe("UPDATE_AVAILABLE");
    expect(report.delivery).not.toBe("UP_TO_DATE");
    expect(report.verdict).not.toBe("UP_TO_DATE");
  });

  test("an undigestible bundle leaves the cache unproven rather than converged", () => {
    const report = statusOf({
      installed: {
        [CODEX_CACHE_PATH]: { version: RELEASE_VERSION, bundles: digests({ "semctx-shared.js": null }) },
        [CLAUDE_CACHE_PATH]: { version: RELEASE_VERSION },
      },
    });

    expect(report.hosts.codex.installed.contentMatchesSnapshot).toBeNull();
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_CONTENT_UNPROVEN");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
    expect(report.hosts.codex.updateAvailable).toBeNull();
  });

  test("a converged state proves every runtime bundle equal to the snapshot", () => {
    const report = statusOf();

    expect(report.hosts.codex.installed.contentMatchesSnapshot).toBe(true);
    expect(report.hosts.claude.installed.contentMatchesSnapshot).toBe(true);
    expect(report.delivery).toBe("UP_TO_DATE");
  });

  test("snapshot and cache bytes cannot jointly impersonate the public release", () => {
    const forgedBundles = digests({ "semctx.js": "jointly-forged-bytes" });
    const publicRelease = {
      status: "resolved" as const,
      version: RELEASE_VERSION,
      commit: STABLE_COMMIT,
      source: "attested-public-release",
      reasons: [],
      bundles: witnesses({ "semctx.js": "released-bytes" }),
    };
    const report = statusOf({
      publicRelease,
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { bundles: forgedBundles },
        [CLAUDE_MARKETPLACE_ROOT]: { bundles: forgedBundles },
      },
      installed: {
        [CODEX_CACHE_PATH]: { bundles: forgedBundles },
        [CLAUDE_CACHE_PATH]: { bundles: forgedBundles },
      },
    });

    expect(report.hosts.codex.installed.contentMatchesPublicRelease).toBe(false);
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_CONTENT_DIVERGED");
    expect(report.hosts.codex.delivery).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.claude.delivery).toBe("UPDATE_AVAILABLE");
    expect(report.delivery).toBe("UPDATE_AVAILABLE");
  });
});

describe("plugin delivery — host-supplied paths are confined", () => {
  test("a UNC marketplace root is rejected before any filesystem read", () => {
    const report = statusOf({
      codexMarketplaces: codexMarketplaces({ root: "\\\\10.0.0.5\\pwn\\.tmp\\marketplaces\\semctx-stable" }),
    });

    // Touching a UNC path would be SMB egress, a multi-second stall, and an NTLM attempt.
    expect(report.hosts.codex.snapshot.path).toBeNull();
    expect(report.hosts.codex.reasons).toContain("HOST_PATH_REJECTED");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("a UNC Claude install path is rejected", () => {
    const report = statusOf({
      claudePlugins: claudePlugins({ installPath: "\\\\10.0.0.5\\pwn\\payload" }),
    });

    expect(report.hosts.claude.installed.path).toBeNull();
    expect(report.hosts.claude.reasons).toContain("HOST_PATH_REJECTED");
    expect(report.hosts.claude.verdict).toBe("UNKNOWN");
  });

  test("a look-alike marketplace root outside the host home is rejected", () => {
    const elsewhere = join(tmpdir(), "semctx-not-codex-home", ".tmp", "marketplaces", "semctx-stable");
    const report = statusOf({ codexMarketplaces: codexMarketplaces({ root: elsewhere }) });

    // The tail matches the expected layout, but the tree is not the resolved Codex home.
    expect(report.hosts.codex.snapshot.path).toBeNull();
    expect(report.hosts.codex.reasons).toContain("HOST_PATH_REJECTED");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("an unresolvable host home leaves every host path unusable", () => {
    const report = statusOf({ hostHomes: { codex: null } });

    expect(report.hosts.codex.snapshot.path).toBeNull();
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("a marketplace junction escaping the host home is rejected before any read", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-plugin-delivery-junction-"));
    const home = join(root, "home");
    const external = join(root, "external");
    const marketplaceParent = join(home, ".tmp", "marketplaces");
    const marketplaceRoot = join(marketplaceParent, "semctx-stable");
    mkdirSync(marketplaceParent, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, marketplaceRoot, process.platform === "win32" ? "junction" : "dir");

    try {
      let snapshotReads = 0;
      const dependencies = fakeDependencies({
        claudeDetected: false,
        hostHomes: { codex: home },
        codexMarketplaces: codexMarketplaces({ root: marketplaceRoot }),
      });
      dependencies.readMarketplaceSnapshot = () => {
        snapshotReads += 1;
        return snapshotProbe();
      };

      const report = pluginDeliveryStatus(
        { repositoryRoot: "/work/project", version: RELEASE_VERSION, hosts: ["codex"] },
        dependencies,
      );

      expect(snapshotReads).toBe(0);
      expect(report.hosts.codex.snapshot.path).toBeNull();
      expect(report.hosts.codex.reasons).toContain("HOST_PATH_REJECTED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested plugin junction cannot move manifest and bundle reads outside the snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-plugin-delivery-nested-junction-"));
    const home = join(root, "home");
    const marketplaceRoot = join(home, ".tmp", "marketplaces", "semctx-stable");
    const pluginsRoot = join(marketplaceRoot, "plugins");
    const externalPlugin = join(root, "external-plugin");
    mkdirSync(pluginsRoot, { recursive: true });
    mkdirSync(join(externalPlugin, ".codex-plugin"), { recursive: true });
    mkdirSync(join(externalPlugin, "dist"), { recursive: true });
    writeFileSync(join(marketplaceRoot, ".codex-marketplace-install.json"), JSON.stringify({
      revision: STABLE_COMMIT,
      ref_name: "stable",
      source: SEMCTX_SOURCE,
    }));
    writeFileSync(join(externalPlugin, ".codex-plugin", "plugin.json"), JSON.stringify({ version: RELEASE_VERSION }));
    for (const name of PLUGIN_RUNTIME_BUNDLES) writeFileSync(join(externalPlugin, "dist", name), `outside-${name}`);
    symlinkSync(externalPlugin, join(pluginsRoot, "semctx-control"), process.platform === "win32" ? "junction" : "dir");

    try {
      const allDependencies = fakeDependencies({
        claudeDetected: false,
        hostHomes: { codex: home },
        codexMarketplaces: codexMarketplaces({ root: marketplaceRoot }),
      });
      const dependencies: Partial<PluginDeliveryDependencies> = { ...allDependencies };
      delete dependencies.readMarketplaceSnapshot;
      const report = pluginDeliveryStatus(
        { repositoryRoot: "/work/project", version: RELEASE_VERSION, hosts: ["codex"] },
        dependencies,
      );

      expect(report.hosts.codex.snapshot.version).toBeNull();
      expect(report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plugin delivery — untrusted host output never reaches the report verbatim", () => {
  test("credentials embedded in a marketplace source are stripped", () => {
    const report = statusOf({
      codexMarketplaces: codexMarketplaces({
        marketplaceSource: {
          sourceType: "git",
          source: "https://x-access-token:ghp_SECRET123@github.com/hoklims/semctx.git",
        },
      }),
    });

    expect(JSON.stringify(report)).not.toContain("ghp_SECRET123");
    // Stripping the token must not break source recognition.
    expect(report.hosts.codex.marketplace.matchesSemctx).toBe(true);
  });

  test("terminal control sequences are stripped so a host cannot repaint a verdict", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { ref: "stable[2K\r  ok  Codex  UP_TO_DATE" },
        [CLAUDE_MARKETPLACE_ROOT]: {},
      },
    });

    expect(report.hosts.codex.marketplace.ref ?? "").not.toContain("");
    expect(report.hosts.codex.marketplace.ref ?? "").not.toContain("\r");
  });
});

describe("plugin delivery — the session version is never inferred", () => {
  test("an unobservable session version is reported as unknown, not as the cache version", () => {
    const report = statusOf({
      sessions: {
        codex: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
        claude: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
      },
    });

    expect(report.hosts.codex.session.status).toBe("unknown");
    expect(report.hosts.codex.session.version).toBeNull();
    expect(report.hosts.claude.session.status).toBe("unknown");
    expect(report.hosts.claude.session.version).toBeNull();
    // Explicitly not the installed cache version.
    expect(report.hosts.codex.session.version).not.toBe(RELEASE_VERSION);
  });

  test("an unobservable session version forbids UP_TO_DATE and names the activation action", () => {
    const report = statusOf({
      sessions: {
        codex: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
        claude: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
      },
    });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("SESSION_VERSION_UNOBSERVABLE");
    expect(report.verdict).toBe("UNKNOWN");

    expect(report.hosts.codex.activation ?? "").toContain("new Codex task");
    expect(report.hosts.claude.activation ?? "").toContain("/reload-plugins");
  });

  test("delivery and activation stay separate dimensions, and neither upgrades the other", () => {
    const report = statusOf({
      sessions: {
        codex: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
        claude: { status: "unknown", version: null, reason: "host exposes no loaded-plugin version" },
      },
    });

    // The cache is provably the public release, so delivery converged...
    expect(report.delivery).toBe("UP_TO_DATE");
    expect(report.hosts.codex.delivery).toBe("UP_TO_DATE");
    expect(report.hosts.codex.updateAvailable).toBe(false);
    // ...but an unproven session gap must never let the overall verdict claim convergence.
    expect(report.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    // Nothing to re-install: only activation is outstanding.
    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.codex.activation ?? "").toContain("new Codex task");
  });

  test("an outdated cache degrades delivery, not only the overall verdict", () => {
    const report = statusOf({
      installed: { [CODEX_CACHE_PATH]: { version: "0.1.16" }, [CLAUDE_CACHE_PATH]: { version: "0.1.16" } },
    });

    expect(report.delivery).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.codex.delivery).toBe("UPDATE_AVAILABLE");
    expect(report.hosts.codex.updateAvailable).toBe(true);
  });

  test("a global CLI claim is never exposed as the loaded plugin version", () => {
    const report = statusOf();
    const serialized = JSON.stringify(report);

    // The host `--version` banner must not leak into any plugin-version field.
    expect(serialized).not.toContain("codex-cli 0.144.6");
    expect(serialized).not.toContain("2.1.220");
  });
});

describe("plugin delivery — partial evidence never yields UP_TO_DATE", () => {
  test("an unattested local stable mirror remains informational, never authoritative", () => {
    const report = statusOf({
      publicRelease: {
        status: "resolved",
        version: RELEASE_VERSION,
        commit: STABLE_COMMIT,
        source: "git-remote-tracking-ref",
        reasons: ["PUBLIC_RELEASE_FROM_LOCAL_MIRROR"],
        bundles: witnesses(),
      },
    });

    expect(report.publicRelease.status).toBe("unknown");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.hosts.codex.updateAvailable).toBeNull();
    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.claude.convergence).toEqual([]);
  });

  test("an unresolvable public release yields UNKNOWN, not UP_TO_DATE", () => {
    const report = statusOf({
      publicRelease: {
        status: "unknown",
        version: null,
        commit: null,
        source: null,
        reasons: ["PUBLIC_RELEASE_REF_ABSENT"],
        bundles: null,
      },
    });

    expect(report.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.updateAvailable).toBeNull();
    expect(report.reasons).toContain("PUBLIC_RELEASE_UNRESOLVED");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_REF_ABSENT");
  });

  test("an offline public-release resolution failure is explicit and never optimistic", () => {
    const report = statusOf({
      publicRelease: {
        status: "unknown",
        version: null,
        commit: null,
        source: null,
        reasons: ["PUBLIC_RELEASE_OFFLINE"],
        bundles: null,
      },
    });

    expect(report.verdict).toBe("UNKNOWN");
    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_OFFLINE");
  });

  test("a public release claiming resolution without a version or commit is demoted, not trusted", () => {
    for (const partial of [
      { version: RELEASE_VERSION, commit: null },
      { version: null, commit: STABLE_COMMIT },
    ]) {
      const report = statusOf({
        publicRelease: {
          status: "resolved",
          version: partial.version,
          commit: partial.commit,
          source: "attested-public-release",
          reasons: [],
          bundles: witnesses(),
        },
      });

      // Without both halves the cache comparisons would simply be skipped; that must never read
      // as convergence.
      expect(report.publicRelease.status).toBe("unknown");
      expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_INCOMPLETE");
      expect(report.verdict).toBe("UNKNOWN");
      expect(report.delivery).toBe("UNKNOWN");
      expect(report.hosts.codex.updateAvailable).toBeNull();
    }
  });

  test("a failed host query yields UNKNOWN for that host", () => {
    const report = statusOf({ failQuery: "codex plugin list --json" });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    expect(report.verdict).toBe("UNKNOWN");
  });

  test("malformed host JSON yields UNKNOWN instead of throwing", () => {
    const report = statusOf({ codexPlugins: "not-an-object" });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("HOST_OUTPUT_MALFORMED");
  });

  test("incomplete host JSON entries are dropped instead of crashing", () => {
    const report = statusOf({ codexPlugins: { installed: [null, 42, { pluginId: 7 }] } });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("PLUGIN_NOT_INSTALLED");
  });

  test("an unreadable installed cache yields UNKNOWN", () => {
    const report = statusOf({ installed: {} });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
  });

  test("an unknown snapshot commit forbids UP_TO_DATE", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { commit: null, ref: "stable", source: SEMCTX_SOURCE, version: RELEASE_VERSION },
        [CLAUDE_MARKETPLACE_ROOT]: { commit: null, ref: "stable", source: SEMCTX_SOURCE, version: RELEASE_VERSION },
      },
    });

    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_COMMIT_UNKNOWN");
    expect(report.verdict).toBe("UNKNOWN");
  });

  test("an undetected requested host keeps the aggregate verdict unknown", () => {
    // Scopes now exist, so the host is named rather than implied; the invariant is unchanged —
    // a host that was asked about stays part of the answer even when it is absent.
    const report = statusOf({ scope: "all", claudeDetected: false });

    expect(report.hosts.claude.detected).toBe(false);
    expect(report.hosts.claude.verdict).toBe("UNKNOWN");
    expect(report.hosts.claude.reasons).toContain("HOST_NOT_DETECTED");
    expect(report.hosts.codex.verdict).toBe("UP_TO_DATE");
    expect(report.verdict).toBe("UNKNOWN");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.reasons).toContain("HOST_NOT_DETECTED");
    expect(report.next.some((step) => step.includes("not available on PATH"))).toBe(true);
  });

  test("an unknown marketplace ref is unprovable rather than silently accepted", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { ref: null },
        [CLAUDE_MARKETPLACE_ROOT]: {},
      },
    });

    expect(report.hosts.codex.marketplace.ref).toBeNull();
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_REF_UNKNOWN");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("an unknown snapshot version is unprovable rather than silently accepted", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { version: null },
        [CLAUDE_MARKETPLACE_ROOT]: {},
      },
    });

    expect(report.hosts.codex.snapshot.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_VERSION_UNKNOWN");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("a plugin installed but disabled is never UP_TO_DATE", () => {
    const report = statusOf({ codexPlugins: codexPlugins({ enabled: false }) });

    expect(report.hosts.codex.verdict).not.toBe("UP_TO_DATE");
    expect(report.hosts.codex.reasons).toContain("PLUGIN_DISABLED");
  });

  test("a marketplace pointing at another source is never treated as semctx", () => {
    const report = statusOf({
      codexMarketplaces: codexMarketplaces({
        marketplaceSource: { sourceType: "git", source: "https://github.com/someone/else.git" },
      }),
    });

    expect(report.hosts.codex.marketplace.matchesSemctx).toBe(false);
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_SOURCE_MISMATCH");
  });

  test("a marketplace configured against a ref other than stable is named", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { commit: STABLE_COMMIT, ref: "main", source: SEMCTX_SOURCE, version: RELEASE_VERSION },
        [CLAUDE_MARKETPLACE_ROOT]: { commit: STABLE_COMMIT, ref: "stable", source: SEMCTX_SOURCE, version: RELEASE_VERSION },
      },
    });

    expect(report.hosts.codex.marketplace.ref).toBe("main");
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_REF_UNEXPECTED");
    expect(report.hosts.codex.verdict).not.toBe("UP_TO_DATE");
  });

  test("an unconfigured marketplace is reported as missing, not as a mismatch", () => {
    const report = statusOf({ codexMarketplaces: { marketplaces: [] } });

    expect(report.hosts.codex.marketplace.configured).toBe(false);
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_NOT_CONFIGURED");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });
});

describe("plugin delivery — convergence guidance", () => {
  test("emits the exact supported Codex convergence path", () => {
    const report = statusOf({
      publicRelease: {
        status: "resolved",
        version: "0.1.18",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "attested-public-release",
        reasons: [],
        bundles: witnesses({ "semctx.js": "next-release-bytes" }),
      },
    });

    expect(report.hosts.codex.convergence).toEqual([
      ["codex", "plugin", "marketplace", "upgrade", "semctx-stable", "--json"],
      ["codex", "plugin", "add", "semctx-control@semctx-stable", "--json"],
    ]);
    expect(report.hosts.codex.activation ?? "").toContain("new Codex task");
  });

  test("emits the exact supported Claude convergence path", () => {
    const report = statusOf({
      publicRelease: {
        status: "resolved",
        version: "0.1.18",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "attested-public-release",
        reasons: [],
        bundles: witnesses({ "semctx.js": "next-release-bytes" }),
      },
    });

    expect(report.hosts.claude.convergence).toEqual([
      ["claude", "plugin", "marketplace", "update", "semctx-stable"],
      ["claude", "plugin", "update", "semctx@semctx-stable", "--scope", "user"],
    ]);
    expect(report.hosts.claude.activation ?? "").toContain("/reload-plugins");
  });

  test("a converged host proposes no convergence command", () => {
    const report = statusOf();

    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.claude.convergence).toEqual([]);
  });
});

describe("plugin delivery — the diagnostic is strictly read-only", () => {
  test("runs only read-only host queries and never a mutating command", () => {
    const dependencies = fakeDependencies();
    pluginDeliveryStatus({ repositoryRoot: "/work/project", version: RELEASE_VERSION }, dependencies);

    const executed = dependencies.queries.map((command) => command.join(" "));
    for (const command of executed) {
      expect(READ_ONLY_QUERIES).toContain(command);
    }
    for (const command of dependencies.queries) {
      for (const verb of MUTATING_VERBS) {
        expect(command).not.toContain(verb);
      }
    }
  });

  test("every command reaching the process seam is read-only, including the Git reads", () => {
    // Only `runQuery` is injected, so the default resolvers run for real — their Git reads are
    // routed through the same seam and are therefore observable here rather than invisible.
    const queries: string[][] = [];
    pluginDeliveryStatus(
      { repositoryRoot: join(tmpdir(), "semctx-plugin-delivery-readonly"), version: RELEASE_VERSION },
      {
        runQuery(command) {
          queries.push([...command]);
          return { code: 1, out: "", err: "not available" };
        },
      },
    );

    expect(queries.length).toBeGreaterThan(0);
    for (const command of queries) {
      for (const verb of MUTATING_VERBS) {
        expect(command).not.toContain(verb);
      }
      if (command[0] === "git") {
        // The only Git verbs allowed on this path are pure reads; `fetch`, `pull`, `push` must
        // never appear.
        expect(["rev-parse", "config", "cat-file"]).toContain(gitVerb(command));
      }
    }
  });

  test("never runs a convergence command it recommends", () => {
    const dependencies = fakeDependencies({
      publicRelease: {
        status: "resolved",
        version: "0.1.18",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "attested-public-release",
        reasons: [],
        bundles: witnesses({ "semctx.js": "next-release-bytes" }),
      },
    });
    const report = pluginDeliveryStatus(
      { repositoryRoot: "/work/project", version: RELEASE_VERSION },
      dependencies,
    );

    const executed = dependencies.queries.map((command) => command.join(" "));
    const recommended = [
      ...report.hosts.codex.convergence,
      ...report.hosts.claude.convergence,
    ].map((command) => command.join(" "));

    expect(recommended.length).toBeGreaterThan(0);
    for (const command of recommended) {
      expect(executed).not.toContain(command);
    }
  });
});

describe("plugin delivery — the public release carries a typed authority", () => {
  test("only an attested release licenses UP_TO_DATE", () => {
    const report = statusOf();

    expect(report.publicRelease.authority).toBe("attested-release");
    expect(report.publicRelease.status).toBe("resolved");
    expect(report.delivery).toBe("UP_TO_DATE");
  });

  test("a local mirror is informative and never licenses UP_TO_DATE", () => {
    const report = statusOf({
      publicRelease: { authority: "local-mirror", source: "git-remote-tracking-ref" },
    });

    // The mirror still reports what it knows...
    expect(report.publicRelease.version).toBe(RELEASE_VERSION);
    expect(report.publicRelease.commit).toBe(STABLE_COMMIT);
    // ...but it cannot prove no newer public release exists.
    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_UNATTESTED");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.verdict).toBe("UNKNOWN");
  });

  test("an absent authority yields UNKNOWN with no release facts trusted", () => {
    const report = statusOf({
      publicRelease: {
        authority: "absent",
        version: null,
        commit: null,
        bundles: null,
        reasons: ["PUBLIC_RELEASE_OFFLINE"],
      },
    });

    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_OFFLINE");
    expect(report.delivery).toBe("UNKNOWN");
  });

  test("an unrecognised authority fails closed instead of being trusted", () => {
    const report = statusOf({
      publicRelease: { authority: "totally-legit" as never },
    });

    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_AUTHORITY_UNKNOWN");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.hosts.codex.updateAvailable).toBeNull();
  });

  test("the cache is compared against the attested release witness, not only the snapshot", () => {
    // Snapshot and cache agree with each other but both differ from the attested release: a
    // jointly altered pair must never impersonate the public channel.
    const forged = digests({ "semctx.js": "forged" });
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { bundles: forged },
        [CLAUDE_MARKETPLACE_ROOT]: { bundles: forged },
      },
      installed: {
        [CODEX_CACHE_PATH]: { bundles: forged },
        [CLAUDE_CACHE_PATH]: { bundles: forged },
      },
    });

    expect(report.hosts.codex.installed.contentMatchesSnapshot).toBe(true);
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_CONTENT_DIVERGED");
    expect(report.delivery).not.toBe("UP_TO_DATE");
  });

  test("a release whose two host payloads disagree licenses nothing", () => {
    // Both plugins ship the same split runtime. If the release itself carries different bytes for
    // Codex and Claude it is not one artifact, and applying either set to both hosts would invent
    // the cross-host equality the witnesses exist to prove.
    const report = statusOf({
      publicRelease: {
        bundles: { codex: digests(), claude: digests({ "semctx.js": "other-host-bytes" }) },
      },
    });

    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED");
    expect(report.publicRelease.status).toBe("unknown");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.hosts.codex.updateAvailable).toBeNull();
    expect(report.hosts.claude.updateAvailable).toBeNull();
    // Nothing is proposed on an unusable release: uncertainty never emits an install command.
    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.claude.convergence).toEqual([]);
  });

  test("a release missing one host's witnesses is incomplete rather than half-trusted", () => {
    const report = statusOf({
      publicRelease: { bundles: { codex: digests(), claude: digests({ "semctx-mcp.js": null }) } },
    });

    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_INCOMPLETE");
    expect(report.publicRelease.status).toBe("unknown");
    expect(report.delivery).toBe("UNKNOWN");
  });
});

describe("plugin delivery — every probe is bounded", () => {
  test("a timed-out host query is a stable UNKNOWN reason", () => {
    const report = statusOf({
      queryOutcomes: { "codex plugin list --json": { code: 1, timedOut: true } },
    });

    expect(report.hosts.codex.reasons).toContain("HOST_QUERY_TIMEOUT");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
    expect(report.delivery).toBe("UNKNOWN");
  });

  test("an oversized host response is a stable UNKNOWN reason", () => {
    const report = statusOf({
      queryOutcomes: { "codex plugin list --json": { code: 0, truncated: true, out: "{}" } },
    });

    expect(report.hosts.codex.reasons).toContain("HOST_OUTPUT_TOO_LARGE");
    expect(report.hosts.codex.verdict).toBe("UNKNOWN");
  });

  test("a bounded failure never proposes an update or an activation command", () => {
    const report = statusOf({
      queryOutcomes: { "codex plugin list --json": { code: 1, timedOut: true } },
    });

    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.codex.activation).toBeNull();
  });
});

describe("plugin delivery — scope selection", () => {
  test("auto omits a host that is not installed", () => {
    const report = statusOf({ scope: "auto", claudeDetected: false });

    expect(report.hosts.claude.requested).toBe(false);
    expect(report.delivery).toBe("UP_TO_DATE");
    expect(report.reasons).not.toContain("HOST_NOT_DETECTED");
  });

  test("an explicitly requested but absent host keeps the aggregate UNKNOWN", () => {
    const report = statusOf({ scope: "all", claudeDetected: false });

    expect(report.hosts.claude.requested).toBe(true);
    expect(report.hosts.claude.detected).toBe(false);
    expect(report.hosts.claude.reasons).toContain("HOST_NOT_DETECTED");
    expect(report.delivery).toBe("UNKNOWN");
    expect(report.verdict).toBe("UNKNOWN");
  });

  test("a single-host scope evaluates only that host", () => {
    const report = statusOf({ scope: "codex" });

    expect(report.hosts.codex.requested).toBe(true);
    expect(report.hosts.claude.requested).toBe(false);
    expect(report.delivery).toBe("UP_TO_DATE");
  });

  test("a single-host scope on an absent host is UNKNOWN, never omitted", () => {
    const report = statusOf({ scope: "claude", claudeDetected: false });

    expect(report.hosts.claude.requested).toBe(true);
    expect(report.delivery).toBe("UNKNOWN");
  });
});

describe("plugin delivery — sensitive fragments never reach an output", () => {
  test("bidi overrides are stripped so a host cannot reverse rendered text", () => {
    const report = statusOf({
      snapshots: {
        [CODEX_MARKETPLACE_ROOT]: { ref: "stable\u202estable\u202c" },
        [CLAUDE_MARKETPLACE_ROOT]: {},
      },
    });

    const serialized = JSON.stringify(report);
    for (const bidi of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2069"]) {
      expect(serialized).not.toContain(bidi);
    }
  });

  test("secret query parameters are redacted from a marketplace source", () => {
    const report = statusOf({
      codexMarketplaces: codexMarketplaces({
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/hoklims/semctx.git?access_token=ghs_LEAKED42",
        },
      }),
    });

    expect(JSON.stringify(report)).not.toContain("ghs_LEAKED42");
  });
});

/**
 * The attestation resolver, exercised for real.
 *
 * Only the process seam is doubled. Which authority is asked, which object store is targeted,
 * which per-host paths are read, how they are cross-checked and what a failure degrades to are all
 * the production resolver's own decisions here — and every argv, cwd and environment it produces is
 * recorded, so those decisions are asserted rather than assumed.
 *
 * This deliberately cannot prove the public channel end to end: making a local machine able to
 * stand in for the canonical authority through production code is precisely the defect being
 * removed. What the public transport really answers is covered by an out-of-suite smoke.
 */
const ATTESTED_REF = "refs/semctx-attestation/stable";

interface RecordedQuery {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | null>> | undefined;
  hermeticGit: boolean;
}

interface ReleaseScript {
  version?: string;
  /** Version declared by an individual host plugin's manifest, when it should differ. */
  pluginVersions?: Partial<Record<PluginDeliveryHost, string>>;
  /** Bundle contents per host plugin, when the two should differ. */
  bundleContent?: Partial<Record<PluginDeliveryHost, Record<string, string>>>;
  origin?: string | null;
  partialClone?: string;
  mirrorCommit?: string | null;
  /** Host inventories, when a case exercises the host layers as well as the release. */
  inventories?: Partial<Record<PluginDeliveryHost, { marketplaces: unknown; plugins: unknown }>>;
  /** Outcome overrides, keyed by a substring of the joined argv. */
  outcomes?: Record<string, Partial<PluginDeliveryQueryOutcome>>;
}

/** The bytes a release carries for a given bundle; the on-disk fixtures are written to match. */
function releasedBundle(bundle: string): string {
  return `released ${bundle}`;
}

function releaseRunner(script: ReleaseScript = {}): {
  runQuery: PluginDeliveryDependencies["runQuery"];
  recorded: RecordedQuery[];
} {
  const version = script.version ?? RELEASE_VERSION;
  const recorded: RecordedQuery[] = [];
  const emit = (text: string): PluginDeliveryQueryOutcome => ({
    code: 0,
    out: text,
    err: "",
    bytes: new TextEncoder().encode(text),
  });
  const releaseFile = (path: string): string | null => {
    if (path === "apps/cli/package.json") return JSON.stringify({ name: "semctx", version });
    for (const host of ["codex", "claude"] as const) {
      const directory = host === "codex" ? "semctx-control" : "claude-code";
      const manifest = host === "codex" ? ".codex-plugin" : ".claude-plugin";
      if (path === `plugins/${directory}/${manifest}/plugin.json`) {
        return JSON.stringify({ version: script.pluginVersions?.[host] ?? version });
      }
      const bundle = PLUGIN_RUNTIME_BUNDLES.find((name) => path === `plugins/${directory}/dist/${name}`);
      if (bundle !== undefined) return script.bundleContent?.[host]?.[bundle] ?? releasedBundle(bundle);
    }
    return null;
  };

  return {
    recorded,
    runQuery(command, cwd, limits) {
      const argv = [...command];
      recorded.push({ argv, cwd, env: limits?.env, hermeticGit: limits?.hermeticGit === true });
      const joined = argv.join(" ");
      for (const [needle, outcome] of Object.entries(script.outcomes ?? {})) {
        if (joined.includes(needle)) return { code: 1, out: "", err: "", ...outcome };
      }
      const inventory = argv[0] === "codex" || argv[0] === "claude"
        ? script.inventories?.[argv[0]]
        : undefined;
      if (inventory !== undefined) {
        const rest = argv.slice(1).join(" ");
        if (rest === "--version") return emit(`${argv[0]} 0.0.0-test\n`);
        if (rest === "plugin marketplace list --json") return emit(JSON.stringify(inventory.marketplaces));
        if (rest === "plugin list --json") return emit(JSON.stringify(inventory.plugins));
        return { code: 1, out: "", err: "unsupported host query" };
      }
      // No host CLI unless a case supplies one: most subjects here are the release, not the hosts.
      if (argv[0] !== "git") return { code: 1, out: "", err: "host not installed" };

      const verb = gitVerb(argv);
      if (verb === "config") {
        if (joined.includes("remote.origin.url")) {
          return script.origin === null
            ? { code: 1, out: "", err: "no origin" }
            : emit(`${script.origin ?? SEMCTX_SOURCE}\n`);
        }
        if (joined.includes("extensions.partialclone")) {
          return script.partialClone === undefined
            ? { code: 1, out: "", err: "" }
            : emit(`${script.partialClone}\n`);
        }
        return { code: 1, out: "", err: "" };
      }
      if (verb === "init") {
        // A runner that reports a successful `git init` while creating nothing would be lying,
        // and the production code is right to refuse an unmeasurable store.
        const store = argv[argv.length - 1] ?? "";
        mkdirSync(store, { recursive: true });
        return { code: 0, out: "", err: "" };
      }
      if (verb === "fetch") return { code: 0, out: "", err: "" };
      if (verb === "rev-parse") {
        if (joined.includes(ATTESTED_REF)) return emit(`${STABLE_COMMIT}\n`);
        if (joined.includes("refs/remotes/origin/stable")) {
          return script.mirrorCommit === null
            ? { code: 1, out: "", err: "no such ref" }
            : emit(`${script.mirrorCommit ?? STABLE_COMMIT}\n`);
        }
        return emit(`${MAIN_COMMIT}\n`);
      }
      if (verb === "cat-file") {
        const specifier = argv[argv.length - 1] ?? "";
        const content = releaseFile(specifier.slice(specifier.indexOf(":") + 1));
        return content === null ? { code: 1, out: "", err: "missing object" } : emit(content);
      }
      return { code: 1, out: "", err: `unexpected: ${joined}` };
    },
  };
}

/** Resolve a release with the real resolver; hosts are out of scope for these cases. */
function releaseOf(
  script: ReleaseScript = {},
  attest = true,
): { report: PluginDeliveryReportV1; recorded: RecordedQuery[] } {
  const { runQuery, recorded } = releaseRunner(script);
  const report = pluginDeliveryStatus(
    { repositoryRoot: CONSUMER_ROOT, version: RELEASE_VERSION, hosts: [], attest },
    { runQuery },
  );
  return { report, recorded };
}

function gitCalls(recorded: readonly RecordedQuery[]): string[] {
  return recorded.filter((query) => query.argv[0] === "git").map((query) => query.argv.join(" "));
}

describe("plugin delivery — the attestation authority is canonical, not the inspected project", () => {
  test("asks the canonical public repository and never the inspected project's remote", () => {
    const { report, recorded } = releaseOf();

    expect(report.publicRelease.authority).toBe("attested-release");
    expect(report.publicRelease.commit).toBe(STABLE_COMMIT);
    expect(report.publicRelease.version).toBe(RELEASE_VERSION);
    expect(report.publicRelease.source).toBe("canonical-public-release");

    const fetches = gitCalls(recorded).filter((command) => command.includes(" fetch "));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain(PLUGIN_DELIVERY_RELEASE_URL);
    // `origin` is a name the inspected project controls; the authority must not be reached by it.
    expect(fetches[0]).not.toContain(" origin ");
  });

  test("removes its scratch store when an internal query seam throws unexpectedly", () => {
    const base = mkdtempSync(join(tmpdir(), "semctx-attestation-throw-"));
    try {
      const source = pathToFileURL(join(import.meta.dir, "..", "src", "plugin-delivery.ts")).href;
      const program = `
        const { pluginDeliveryStatus } = await import(${JSON.stringify(source)});
        const report = pluginDeliveryStatus(
          ${JSON.stringify({ repositoryRoot: CONSUMER_ROOT, version: RELEASE_VERSION, hosts: [], attest: true })},
          {
            readRepositoryChannel: () => ({ commit: ${JSON.stringify(MAIN_COMMIT)}, originIsSemctx: false }),
            resolveHostHome: () => null,
            runQuery(command) {
              if (command.includes("init")) throw new Error("injected attestation failure");
              return { code: 1, out: "", err: "not reached" };
            },
          },
        );
        process.stdout.write(JSON.stringify(report.publicRelease.reasons));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", program], {
        env: { ...process.env, TEMP: base, TMP: base },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toContain("PUBLIC_RELEASE_ATTESTATION_UNAVAILABLE");
      expect(readdirSync(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reads the release from its own store, never from the inspected project's objects", () => {
    const { recorded } = releaseOf();

    const reads = recorded.filter((query) => query.argv.includes("cat-file"));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const store = read.argv.find((argument) => argument.startsWith("--git-dir="));
      expect(store).toBeDefined();
      // The store is a scratch directory of its own; the inspected project is never the object
      // source, and a forged or replaced object there cannot reach the witnesses.
      expect(store).not.toContain(CONSUMER_ROOT);
      expect(read.cwd).not.toBe(CONSUMER_ROOT);
      expect(read.argv).toContain("--no-replace-objects");
    }
  });

  test("attests from a project whose origin is not semctx", () => {
    // The regression: an attestation gated on the consumer's `origin` cannot answer for a user
    // running `semctx plugin-status --attest` inside their own project.
    const { report } = releaseOf({ origin: "https://github.com/someone/their-app.git" });

    expect(report.publicRelease.authority).toBe("attested-release");
    expect(report.publicRelease.status).toBe("resolved");
    expect(report.publicRelease.reasons).not.toContain("PUBLIC_RELEASE_ORIGIN_NOT_SEMCTX");
  });

  test("attests from a directory that is not a Git repository at all", () => {
    const { report } = releaseOf({ origin: null, mirrorCommit: null });

    expect(report.publicRelease.authority).toBe("attested-release");
    expect(report.publicRelease.status).toBe("resolved");
  });

  test("severs the ambient Git configuration that could redirect the authority", () => {
    const { recorded } = releaseOf();

    const fetch = recorded.find((query) => query.argv.includes("fetch"));
    // The whole inherited Git namespace is dropped rather than patched name by name: enumerating
    // the dangerous ones missed `GIT_CONFIG_PARAMETERS`, which re-injects configuration wholesale.
    expect(fetch?.hermeticGit).toBe(true);
    const environment = fetch?.env ?? {};
    // What is then reintroduced is an allowlist, and it pins configuration at paths that do not
    // exist and transport at verified https.
    expect(environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(environment["GIT_CONFIG_GLOBAL"]).toContain("absent-global-config");
    expect(environment["GIT_CONFIG_SYSTEM"]).toContain("absent-system-config");
    expect(environment["GIT_ALLOW_PROTOCOL"]).toBe("https");
    // Nothing in the allowlist re-enables tracing, object redirection or replacement.
    for (const reintroduced of Object.keys(environment)) {
      expect(reintroduced.startsWith("GIT_TRACE")).toBe(false);
    }
    expect(environment["GIT_OBJECT_DIRECTORY"]).toBeUndefined();
    expect(environment["GIT_ALTERNATE_OBJECT_DIRECTORIES"]).toBeUndefined();
    expect(environment["GIT_SSL_NO_VERIFY"]).toBeUndefined();
  });

  test("every local read is hermetic too, so no inherited variable can redirect it", () => {
    const { recorded } = releaseOf({}, false);

    for (const query of recorded.filter((entry) => entry.argv[0] === "git")) {
      expect(query.hermeticGit).toBe(true);
      // The local lane must still read the repository it was pointed at, so it sets no GIT_DIR.
      expect(query.env?.["GIT_DIR"]).toBeUndefined();
      expect(query.env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
    }
  });

  test("reads each host's witnesses from that host's own plugin in the release", () => {
    const { recorded } = releaseOf();
    const read = gitCalls(recorded).join("\n");

    for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
      expect(read).toContain(`plugins/semctx-control/dist/${bundle}`);
      expect(read).toContain(`plugins/claude-code/dist/${bundle}`);
    }
  });

  test("a release whose two host plugins carry different bytes is refused", () => {
    const { report } = releaseOf({
      bundleContent: { claude: { "semctx.js": "a different build for the other host" } },
    });

    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED");
  });

  test("a release bundle past the per-bundle ceiling is refused before it can become a witness", () => {
    const oversized = "x".repeat(PLUGIN_DELIVERY_MAX_BUNDLE_BYTES + 1);
    const { report } = releaseOf({
      bundleContent: {
        codex: { "semctx.js": oversized },
        claude: { "semctx.js": oversized },
      },
    });

    expect(report.publicRelease.status).toBe("unknown");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_INCOMPLETE");
  });

  test("a host plugin declaring another version is refused rather than averaged", () => {
    const { report } = releaseOf({ pluginVersions: { claude: "0.1.16" } });

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_VERSION_DIVERGED");
    expect(report.publicRelease.version).toBeNull();
  });

  test("an unreachable authority degrades to absent, never to the local mirror", () => {
    const { report } = releaseOf({ outcomes: { " fetch ": { code: 128 } } });

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_ATTESTATION_UNAVAILABLE");
    expect(report.publicRelease.commit).toBeNull();
    expect(report.publicRelease.source).not.toBe("git-remote-tracking-ref");
  });

  test("a timed-out attestation is its own stable reason", () => {
    const { report } = releaseOf({ outcomes: { " fetch ": { code: 1, timedOut: true } } });

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_ATTESTATION_TIMEOUT");
  });

  test("an unusable scratch store is refused instead of falling back to local objects", () => {
    const { report, recorded } = releaseOf({ outcomes: { " init ": { code: 1 } } });

    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_ATTESTATION_STORE_UNAVAILABLE");
    // No object read is attempted once the isolated store could not be created.
    expect(gitCalls(recorded).some((command) => command.includes("cat-file"))).toBe(false);
  });

  test("a malformed attested commit is refused rather than pasted into a path", () => {
    const { report } = releaseOf({
      outcomes: { [`rev-parse ${ATTESTED_REF}`]: { code: 0, out: "not-a-commit\n" } },
    });

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_ATTESTATION_MALFORMED");
  });
});

describe("plugin delivery — the default path leaves the machine alone", () => {
  test("performs no network call and reaches no remote authority", () => {
    const { report, recorded } = releaseOf({}, false);

    const commands = gitCalls(recorded);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toContain("fetch");
      expect(command).not.toContain("ls-remote");
      expect(command).not.toContain(PLUGIN_DELIVERY_RELEASE_URL);
    }
    expect(report.publicRelease.authority).toBe("local-mirror");
    expect(report.publicRelease.status).toBe("unknown");
  });

  test("reads the mirror with replacement objects and lazy fetching disabled", () => {
    const { recorded } = releaseOf({}, false);

    for (const query of recorded.filter((entry) => entry.argv[0] === "git")) {
      // Replacement is refused by `--no-replace-objects` on the command itself, and any inherited
      // `GIT_REPLACE_REF_BASE` is gone with the rest of the namespace.
      expect(query.hermeticGit).toBe(true);
      expect(query.env?.["GIT_NO_LAZY_FETCH"]).toBe("1");
    }
    const reads = recorded.filter((query) => query.argv.includes("cat-file")
      || query.argv.includes("rev-parse"));
    for (const read of reads) expect(read.argv).toContain("--no-replace-objects");
  });

  test("refuses a partial clone rather than letting a local read become a fetch", () => {
    const { report, recorded } = releaseOf({ partialClone: "origin" }, false);

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_LOCAL_STORE_PARTIAL");
    // The commit is never read, so no missing object can trigger a promisor round trip.
    expect(gitCalls(recorded).some((command) => command.includes("cat-file"))).toBe(false);
  });

  test("stays informational in a project that is not a semctx clone", () => {
    const { report } = releaseOf({ origin: "https://github.com/someone/their-app.git" }, false);

    expect(report.publicRelease.authority).toBe("absent");
    expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_ORIGIN_NOT_SEMCTX");
  });
});

describe("plugin delivery — activation is an independent dimension", () => {
  const unobservable = {
    codex: { status: "unknown" as const, version: null, reason: "no loaded-plugin version" },
    claude: { status: "unknown" as const, version: null, reason: "no loaded-plugin version" },
  };

  test("an unknown delivery authority does not suppress the activation action", () => {
    // The mirror cannot license delivery, but how a running session picks up what is already on
    // disk is a different question, and the answer to it does not become unknown.
    const report = statusOf({
      publicRelease: { authority: "local-mirror", source: "git-remote-tracking-ref" },
      sessions: unobservable,
    });

    expect(report.delivery).toBe("UNKNOWN");
    expect(report.hosts.codex.activation ?? "").toContain("new Codex task");
    expect(report.hosts.claude.activation ?? "").toContain("/reload-plugins");
  });

  test("an unknown delivery authority still proposes no install or update command", () => {
    const report = statusOf({
      publicRelease: { authority: "local-mirror", source: "git-remote-tracking-ref" },
      sessions: unobservable,
    });

    expect(report.hosts.codex.convergence).toEqual([]);
    expect(report.hosts.claude.convergence).toEqual([]);
    expect(report.next.some((step) => step.includes("plugin add"))).toBe(false);
    expect(report.next.some((step) => step.includes("plugin update"))).toBe(false);
  });

  test("a host that never reached the session layer proposes nothing at all", () => {
    const report = statusOf({ queryOutcomes: { "codex plugin list --json": { code: 1, timedOut: true } } });

    expect(report.hosts.codex.activation).toBeNull();
    expect(report.hosts.codex.convergence).toEqual([]);
  });
});

describe("plugin delivery — local artifacts are bounded before they are read", () => {
  test("an oversized manifest and an oversized bundle are refused on their metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "semctx-plugin-delivery-oversized-"));
    const codexMarketplaceRoot = join(home, ".tmp", "marketplaces", "semctx-stable");
    const claudeMarketplaceRoot = join(home, "plugins", "marketplaces", "semctx-stable");
    const codexCache = join(home, "plugins", "cache", "semctx-stable", "semctx-control", RELEASE_VERSION);
    const claudeCache = join(home, "plugins", "cache", "semctx-stable", "semctx", RELEASE_VERSION);
    // Host-reported paths are only accepted when they exist inside the host home, so the tree has
    // to be real; the ceilings are what is under test, not the confinement.
    mkdirSync(codexMarketplaceRoot, { recursive: true });
    mkdirSync(claudeMarketplaceRoot, { recursive: true });
    mkdirSync(join(codexCache, ".codex-plugin"), { recursive: true });
    mkdirSync(join(codexCache, "dist"), { recursive: true });
    mkdirSync(join(claudeCache, ".claude-plugin"), { recursive: true });

    writeFileSync(join(codexCache, ".codex-plugin", "plugin.json"), JSON.stringify({ version: RELEASE_VERSION }));
    for (const name of PLUGIN_RUNTIME_BUNDLES) writeFileSync(join(codexCache, "dist", name), `bundle ${name}`);
    // One bundle past the ceiling: its digest stays unproven rather than being allocated.
    writeFileSync(
      join(codexCache, "dist", "semctx-shared.js"),
      Buffer.alloc(PLUGIN_DELIVERY_MAX_BUNDLE_BYTES + 1024, 0x61),
    );
    // A "manifest" far past the ceiling: refused before it is parsed, so the payload is unreadable.
    writeFileSync(
      join(claudeCache, ".claude-plugin", "plugin.json"),
      Buffer.alloc(PLUGIN_DELIVERY_MAX_MANIFEST_BYTES + 1024, 0x20),
    );

    try {
      const dependencies = fakeDependencies({
        hostHomes: { codex: home, claude: home },
        codexMarketplaces: codexMarketplaces({ root: codexMarketplaceRoot }),
        claudeMarketplaces: claudeMarketplaces({ installLocation: claudeMarketplaceRoot }),
        claudePlugins: claudePlugins({ installPath: claudeCache }),
        snapshots: { [codexMarketplaceRoot]: {}, [claudeMarketplaceRoot]: {} },
      });
      const partial: Partial<PluginDeliveryDependencies> = { ...dependencies };
      // The real payload reader runs: the ceilings under test are the ones it applies.
      delete partial.readInstalledPayload;
      const report = pluginDeliveryStatus(
        { repositoryRoot: "/work/project", version: RELEASE_VERSION, hosts: ["codex", "claude"] },
        partial,
      );

      expect(report.hosts.codex.installed.contentMatchesSnapshot).toBeNull();
      expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_CONTENT_UNPROVEN");
      expect(report.hosts.claude.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
      expect(report.delivery).toBe("UNKNOWN");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a bundle enlarged after its metadata was read is never hashed past the ceiling", async () => {
    // The window this closes: the confinement walk describes the entry, and the read happens after.
    // If the size decision came from the earlier `stat` while the bytes came from a fresh path
    // resolution, a file swapped in between the two would be hashed whole, past the ceiling.
    //
    // The assertion holds on every schedule — the artifact is either read as the small file or left
    // unproven — so the green is stable; against a stat-then-read implementation it failed on 5 of
    // 5 measured runs, so the window is genuinely exercised rather than merely described.
    const home = mkdtempSync(join(tmpdir(), "semctx-plugin-delivery-swap-"));
    const cache = join(home, "plugins", "cache", "semctx-stable", "semctx-control", RELEASE_VERSION);
    const marketplace = join(home, ".tmp", "marketplaces", "semctx-stable");
    mkdirSync(marketplace, { recursive: true });
    mkdirSync(join(cache, ".codex-plugin"), { recursive: true });
    mkdirSync(join(cache, "dist"), { recursive: true });
    writeFileSync(join(cache, ".codex-plugin", "plugin.json"), JSON.stringify({ version: RELEASE_VERSION }));
    for (const name of PLUGIN_RUNTIME_BUNDLES) writeFileSync(join(cache, "dist", name), `bundle ${name}`);

    const swapped = join(cache, "dist", "semctx.js");
    const small = "bundle semctx.js";
    const smallDigest = createHash("sha256").update(small).digest("hex");
    const realDigests: Record<string, string | null> = {};
    for (const name of PLUGIN_RUNTIME_BUNDLES) {
      realDigests[name] = createHash("sha256").update(`bundle ${name}`).digest("hex");
    }

    // The read is fully synchronous, so an in-process swapper could never run during it: the
    // interleaving only exists against a genuinely concurrent writer. Extending by length rather
    // than by writing bytes keeps both states cheap, so the file flips fast enough for the window
    // between the metadata read and the content read to actually be exercised.
    const stop = join(home, "stop");
    const swapper = Bun.spawn([
      process.execPath,
      "-e",
      `const fs = require("node:fs");
`
      + `const target = ${JSON.stringify(swapped)};
`
      + `const stop = ${JSON.stringify(stop)};
`
      + `while (!fs.existsSync(stop)) {
`
      + `  try { fs.writeFileSync(target, ${JSON.stringify(small)}); } catch {}
`
      + `  try { fs.truncateSync(target, ${PLUGIN_DELIVERY_MAX_BUNDLE_BYTES + 4096}); } catch {}
`
      + `}
`,
    ], { stdout: "ignore", stderr: "ignore" });

    try {
      const observed = new Set<string | null>();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const dependencies = fakeDependencies({
          hostHomes: { codex: home, claude: home },
          codexMarketplaces: codexMarketplaces({ root: marketplace }),
          claudeDetected: false,
          // Real digests of the small files, so a match proves which bytes were actually hashed.
          snapshots: { [marketplace]: { bundles: realDigests } },
        });
        const partial: Partial<PluginDeliveryDependencies> = { ...dependencies };
        delete partial.readInstalledPayload;
        const report = pluginDeliveryStatus(
          { repositoryRoot: "/work/project", version: RELEASE_VERSION, hosts: ["codex"] },
          partial,
        );
        observed.add(report.hosts.codex.installed.contentMatchesSnapshot === null ? null : "compared");
        // The snapshot carries the small files' real digests, so `true` means the small file was
        // read and `null` means the artifact stayed unproven — both honest. `false` would mean a
        // digest was produced for content that is not the small file: the oversized swap, hashed
        // whole or as a prefix, which is the outcome that must never appear.
        expect(report.hosts.codex.installed.contentMatchesSnapshot).not.toBe(false);
      }
      expect(observed.size).toBeGreaterThan(0);
      expect(smallDigest).toHaveLength(64);
    } finally {
      writeFileSync(stop, "");
      await swapper.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The three delivery states over real artifacts.
 *
 * Everything below the release is genuine: real marketplace snapshots and real cache entries on
 * disk, read by the production probes, digested by the production digester, confined by the
 * production path checks, and composed by the production verdict logic. Only the process seam is
 * doubled — including the attestation's, because a local stand-in for the public authority is
 * exactly what the design now refuses to accept.
 */
describe("plugin delivery — the three delivery states over real artifacts", () => {
  const MARKETPLACE = "semctx-stable";

  function writePlugin(root: string, manifest: string, version: string, bundle: (name: string) => string): void {
    mkdirSync(join(root, manifest), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, manifest, "plugin.json"), JSON.stringify({ version }));
    for (const name of PLUGIN_RUNTIME_BUNDLES) writeFileSync(join(root, "dist", name), bundle(name));
  }

  /** A host home laid out exactly as its installer leaves it, holding the released payload. */
  function materialise(home: string, bundle: (name: string) => string = releasedBundle): {
    codexMarketplace: string;
    claudeMarketplace: string;
    codexCache: string;
    claudeCache: string;
  } {
    const codexMarketplace = join(home, ".tmp", "marketplaces", MARKETPLACE);
    const claudeMarketplace = join(home, "plugins", "marketplaces", MARKETPLACE);
    const codexCache = join(home, "plugins", "cache", MARKETPLACE, "semctx-control", RELEASE_VERSION);
    const claudeCache = join(home, "plugins", "cache", MARKETPLACE, "semctx", RELEASE_VERSION);

    for (const marketplace of [codexMarketplace, claudeMarketplace]) {
      mkdirSync(marketplace, { recursive: true });
      writeFileSync(
        join(marketplace, ".codex-marketplace-install.json"),
        JSON.stringify({ source_type: "git", source: SEMCTX_SOURCE, ref_name: "stable", revision: STABLE_COMMIT }),
      );
      writePlugin(join(marketplace, "plugins", "semctx-control"), ".codex-plugin", RELEASE_VERSION, releasedBundle);
      writePlugin(join(marketplace, "plugins", "claude-code"), ".claude-plugin", RELEASE_VERSION, releasedBundle);
    }
    writePlugin(codexCache, ".codex-plugin", RELEASE_VERSION, bundle);
    writePlugin(claudeCache, ".claude-plugin", RELEASE_VERSION, bundle);
    return { codexMarketplace, claudeMarketplace, codexCache, claudeCache };
  }

  function inventoriesFor(paths: ReturnType<typeof materialise>): ReleaseScript["inventories"] {
    return {
      codex: {
        marketplaces: {
          marketplaces: [{
            name: MARKETPLACE,
            root: paths.codexMarketplace,
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          }],
        },
        plugins: {
          installed: [{
            pluginId: "semctx-control@semctx-stable",
            version: RELEASE_VERSION,
            installed: true,
            enabled: true,
          }],
        },
      },
      claude: {
        marketplaces: [{
          name: MARKETPLACE,
          source: "github",
          repo: "hoklims/semctx",
          ref: "stable",
          installLocation: paths.claudeMarketplace,
        }],
        plugins: [{
          id: "semctx@semctx-stable",
          version: RELEASE_VERSION,
          scope: "user",
          enabled: true,
          installPath: paths.claudeCache,
        }],
      },
    };
  }

  function statusOverRealArtifacts(
    home: string,
    paths: ReturnType<typeof materialise>,
    attest: boolean,
  ): PluginDeliveryReportV1 {
    const { runQuery } = releaseRunner({ inventories: inventoriesFor(paths) });
    return pluginDeliveryStatus(
      { repositoryRoot: CONSUMER_ROOT, version: RELEASE_VERSION, scope: "all", attest },
      // Only the process seam and the host home are supplied; snapshot reads, payload reads,
      // digests and path confinement are the production implementations.
      { runQuery, resolveHostHome: () => home },
    );
  }

  function withHome(
    bundle: (name: string) => string,
    body: (home: string, paths: ReturnType<typeof materialise>) => void,
  ): void {
    const home = mkdtempSync(join(tmpdir(), "semctx-delivery-states-"));
    try {
      body(home, materialise(home, bundle));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("state 0: an attested release matching both real caches converges", () => {
    withHome(releasedBundle, (home, paths) => {
      const report = statusOverRealArtifacts(home, paths, true);

      expect(report.publicRelease.authority).toBe("attested-release");
      expect(report.publicRelease.commit).toBe(STABLE_COMMIT);
      expect(report.hosts.codex.installed.contentMatchesPublicRelease).toBe(true);
      expect(report.hosts.claude.installed.contentMatchesPublicRelease).toBe(true);
      expect(report.hosts.codex.delivery).toBe("UP_TO_DATE");
      expect(report.hosts.claude.delivery).toBe("UP_TO_DATE");
      expect(report.delivery).toBe("UP_TO_DATE");
      // Delivery converged; activation never can, because no host exposes a loaded version.
      expect(report.verdict).toBe("UNKNOWN");
      expect(report.hosts.codex.convergence).toEqual([]);
      expect(report.hosts.codex.activation ?? "").toContain("new Codex task");
    });
  });

  test("state 2: a real cache whose bytes differ from the attested release needs an update", () => {
    withHome((name) => (name === "semctx.js" ? "stale bytes" : releasedBundle(name)), (home, paths) => {
      const report = statusOverRealArtifacts(home, paths, true);

      // Same version-keyed directory and the same manifest version — only the bytes differ.
      expect(report.hosts.codex.installed.version).toBe(RELEASE_VERSION);
      expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_CONTENT_DIVERGED");
      expect(report.hosts.claude.reasons).toContain("INSTALLED_CACHE_CONTENT_DIVERGED");
      expect(report.delivery).toBe("UPDATE_AVAILABLE");
      expect(report.hosts.codex.convergence).not.toEqual([]);
    });
  });

  test("state 3: without attestation the same artifacts stay unknown", () => {
    withHome(releasedBundle, (home, paths) => {
      const report = statusOverRealArtifacts(home, paths, false);

      expect(report.publicRelease.authority).toBe("local-mirror");
      expect(report.publicRelease.reasons).toContain("PUBLIC_RELEASE_UNATTESTED");
      expect(report.delivery).toBe("UNKNOWN");
      // An honest gap, not a false green — and nothing to install on an unproven authority.
      expect(report.hosts.codex.convergence).toEqual([]);
      expect(report.hosts.claude.convergence).toEqual([]);
    });
  });

  test("each host is proven against its own release payload", () => {
    withHome(releasedBundle, (home, paths) => {
      const { runQuery, recorded } = releaseRunner({ inventories: inventoriesFor(paths) });
      pluginDeliveryStatus(
        { repositoryRoot: CONSUMER_ROOT, version: RELEASE_VERSION, scope: "all", attest: true },
        { runQuery, resolveHostHome: () => home },
      );

      const read = gitCalls(recorded).join("\n");
      for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
        expect(read).toContain(`plugins/semctx-control/dist/${bundle}`);
        expect(read).toContain(`plugins/claude-code/dist/${bundle}`);
      }
    });
  });
});
