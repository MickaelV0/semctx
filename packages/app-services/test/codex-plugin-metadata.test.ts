import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { readCodexManagedPreferences, readCodexPluginMetadataInventory } from "../src/plugin-delivery";

const roots: string[] = [];
function writeGitRoot(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}
function fixture(): { root: string; home: string; repo: string } {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "semctx-codex-metadata-")));
  roots.push(root);
  const home = join(root, "profile");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeGitRoot(repo);
  return { root, home, repo };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cache(home: string, version: string): void {
  const root = join(home, "plugins", "cache", "semctx-stable", "semctx-control", version, ".codex-plugin");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "semctx-control", version }));
}
function snapshot(home: string): void {
  const root = join(home, ".tmp", "marketplaces", "semctx-stable");
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  mkdirSync(join(root, "plugins", "semctx-control"), { recursive: true });
  writeFileSync(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "semctx-stable",
    plugins: [{ name: "semctx-control", source: { source: "local", path: "./plugins/semctx-control" } }],
  }));
}

describe("Codex declarative plugin inventory", () => {
  for (const mutation of ["appearance", "removal", "same-bytes inode replacement", "metadata byte drift"] as const) {
    test(`Codex sidecar snapshot observations reject ${mutation}`, () => {
      const { home, repo } = fixture();
      snapshot(home);
      writeFileSync(join(home, "config.toml"),
        "[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\nref = 'stable'\nsparse_paths = []\n");
      const file = join(home, ".tmp", "marketplaces", "semctx-stable", ".codex-marketplace-install.json");
      const native = JSON.stringify({ source_type: "git", source: "hoklims/semctx", ref_name: "stable",
        sparse_paths: [], revision: "1".repeat(40) });
      if (mutation !== "appearance") writeFileSync(file, native);
      const inventory = readCodexPluginMetadataInventory(repo, home, () => {
        if (mutation === "removal") rmSync(file);
        else if (mutation === "same-bytes inode replacement") {
          renameSync(file, `${file}.previous`);
          writeFileSync(file, native);
        } else writeFileSync(file, mutation === "appearance" ? native
          : native.replace(/}$/, ',"note":"changed metadata bytes"}'));
      }, home, { systemFiles: [], managedPreferences: () => "absent" });
      expect(inventory).toBeNull();
    });
  }

  test("a fresh profile is provably empty and never creates profile files", () => {
    const { home, repo } = fixture();
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toEqual({ marketplaces: [], plugins: [] });
    expect(readdirSync(home)).toEqual([]);
  });

  test("trusted project configuration overrides user enablement and selects the highest cached version", () => {
    const { home, repo } = fixture();
    const escapedRepo = repo.replace(/'/g, "''");
    writeFileSync(join(home, "config.toml"),
      `[features]\nplugins = true\n[projects.'${escapedRepo}']\ntrust_level = 'trusted'\n`
        + `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\nref = 'stable'\n`
        + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"),
      `[plugins.'semctx-control@semctx-stable']\nenabled = false\n`);
    cache(home, "0.3.5");
    cache(home, "0.3.6");
    snapshot(home);
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const inventory = readCodexPluginMetadataInventory(repo, home, undefined, home);
    expect(inventory?.marketplaces).toEqual([expect.objectContaining({
      name: "semctx-stable",
      marketplaceSource: { sourceType: "git", source: "hoklims/semctx" },
      ref: "stable",
    })]);
    expect(inventory?.plugins).toEqual([expect.objectContaining({
      pluginId: "semctx-control@semctx-stable",
      installed: true,
      enabled: false,
      version: "0.3.6",
    })]);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);
  });

  test("an untrusted project's configuration cannot claim an active plugin", () => {
    const { home, repo } = fixture();
    writeFileSync(join(home, "config.toml"), "[features]\nplugins = true\n");
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
        + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    cache(home, "0.3.6");
    const inventory = readCodexPluginMetadataInventory(repo, home, undefined, home);
    expect(inventory?.marketplaces).toEqual([]);
    expect(inventory?.plugins).toEqual([expect.objectContaining({
      pluginId: "semctx-control@semctx-stable", installed: true, registered: false, version: "0.3.6",
    })]);
    expect(Object.hasOwn(inventory!.plugins[0]!, "enabled")).toBe(false);
  });

  test("malformed configuration and cache are unknown, and visible drift is rejected", () => {
    const { home, repo } = fixture();
    const config = join(home, "config.toml");
    writeFileSync(config, "[plugins.'semctx-control@semctx-stable'\n");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(config,
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
        + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    cache(home, "0.3.6");
    snapshot(home);
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      writeFileSync(config, readFileSync(config, "utf8").replace("enabled = true", "enabled = false"));
    }, home)).toBeNull();
    writeFileSync(join(home, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.6", ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "semctx-control", version: "9.9.9" }));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
  });

  test("unregistered Semctx caches remain physical evidence and cache ancestors are confined", () => {
    const { root, home, repo } = fixture();
    cache(home, "local");
    const cachePath = join(home, "plugins", "cache", "semctx-stable", "semctx-control", "local");
    writeFileSync(join(cachePath, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
    const inventory = readCodexPluginMetadataInventory(repo, home, undefined, home);
    expect(inventory?.plugins).toEqual([expect.objectContaining({
      pluginId: "semctx-control@semctx-stable", installed: true, registered: false,
      cacheDirectory: "local", cachePath, version: "0.3.7",
    })]);
    expect(Object.hasOwn(inventory!.plugins[0]!, "enabled")).toBe(false);
    const plugins = join(home, "plugins");
    const moved = join(root, "retired-plugins");
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      renameSync(plugins, moved);
      symlinkSync(moved, plugins, process.platform === "win32" ? "junction" : "dir");
    }, home)).toBeNull();
  });

  test("cache manifest identity is required and wrong or malformed names are unknown", () => {
    const { home, repo } = fixture();
    snapshot(home);
    writeFileSync(join(home, "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
      + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    cache(home, "0.3.7");
    const manifest = join(home, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.7", ".codex-plugin", "plugin.json");
    for (const name of [undefined, null, 123, "foreign-control"]) {
      writeFileSync(manifest, JSON.stringify({ name, version: "0.3.7" }));
      expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    }
    writeFileSync(manifest, JSON.stringify({ name: "semctx-control", version: "0.3.7" }));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)?.plugins[0]?.["version"]).toBe("0.3.7");
  });

  test("every configured marketplace must have a valid manifest, and a relative local source cannot impersonate Git", () => {
    const { home, repo } = fixture();
    const config = join(home, "config.toml");
    snapshot(home);
    writeFileSync(config,
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
        + `[marketplaces.foreign]\nsource_type = 'git'\nsource = 'someone/else'\n`);
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    const foreign = join(home, ".tmp", "marketplaces", "foreign", ".agents", "plugins");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "marketplace.json"), "{broken");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(config,
      `[marketplaces.semctx-stable]\nsource_type = 'local'\nsource = 'hoklims/semctx'\n`);
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
  });

  test("plugin-cache JSON rejects duplicate decoded keys and unpaired escaped strings", () => {
    const { home, repo } = fixture();
    const boundaries = { systemFiles: [], managedPreferences: () => "absent" as const };
    const inspect = () => readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries);
    const cacheRoot = join(home, "plugins", "cache", "semctx-stable", "semctx-control");
    const manifestRoot = join(cacheRoot, "0.3.7", ".codex-plugin");
    mkdirSync(manifestRoot, { recursive: true });
    const manifest = join(manifestRoot, "plugin.json");
    const valid = '{"name":"semctx-control","version":"0.3.7"}';
    for (const invalid of [
      '{"name":"foreign","name":"semctx-control","version":"0.3.7"}',
      String.raw`{"name":"foreign","\u006eame":"semctx-control","version":"0.3.7"}`,
      '{"name":"semctx-control","version":"0.3.6","version":"0.3.7"}',
      String.raw`{"name":"semctx-control","version":"0.3.7","nested":{"text":"\udc00"}}`,
      '{"name":"semctx-control","version":"0.3.7","nested":{"field":false,"field":true}}',
    ]) {
      writeFileSync(manifest, invalid);
      expect(inspect()).toBeNull();
    }
    writeFileSync(manifest, valid);
    expect(inspect()?.plugins[0]?.["version"]).toBe("0.3.7");
  });

  test("remote-install JSON rejects duplicate decoded keys and unpaired escaped strings", () => {
    const { home, repo } = fixture();
    cache(home, "0.3.7");
    const boundaries = { systemFiles: [], managedPreferences: () => "absent" as const };
    const inspect = () => readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries);
    const cacheRoot = join(home, "plugins", "cache", "semctx-stable", "semctx-control");
    const marker = join(cacheRoot, ".codex-remote-plugin-install.json");
    for (const invalid of [
      '{"schema_version":0,"schema_version":1,"remote_plugin_id":"known"}',
      String.raw`{"schema_version":1,"remote_plugin_id":"old","remote_plugin_\u0069d":"known"}`,
      String.raw`{"schema_version":1,"remote_plugin_id":"known","nested":{"text":"\ud800"}}`,
    ]) {
      writeFileSync(marker, invalid);
      expect(inspect()).toBeNull();
    }
    writeFileSync(marker, '{"schema_version":1,"remote_plugin_id":"known"}');
    expect(inspect()?.plugins[0]?.["version"]).toBe("0.3.7");
  });

  test("supported alternate manifests and a local cache retain their native identity", () => {
    const { home, repo } = fixture();
    snapshot(home);
    const manifestRoot = join(home, ".tmp", "marketplaces", "semctx-stable", ".agents", "plugins");
    renameSync(join(manifestRoot, "marketplace.json"), join(manifestRoot, "api_marketplace.json"));
    writeFileSync(join(home, "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
        + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    cache(home, "0.3.6");
    cache(home, "local");
    writeFileSync(join(home, "plugins", "cache", "semctx-stable", "semctx-control", "local", ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "semctx-control", version: "0.3.4" }));
    const inventory = readCodexPluginMetadataInventory(repo, home, undefined, home);
    expect(inventory?.plugins).toEqual([expect.objectContaining({
      installed: true,
      version: "0.3.4",
      cacheDirectory: "local",
      cachePath: join(home, "plugins", "cache", "semctx-stable", "semctx-control", "local"),
    })]);
  });

  test("linked roots and raw metadata or directory identity drift never become an empty safe profile", () => {
    const { root, home, repo } = fixture();
    const alias = join(root, "alias");
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    expect(readCodexPluginMetadataInventory(repo, alias, undefined, home)).toBeNull();
    const config = join(home, "config.toml");
    writeFileSync(config, "[features]\nplugins = true\n");
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      writeFileSync(config, "[features]\nplugins = true\n# changed\n");
    }, home)).toBeNull();
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      renameSync(home, join(root, "retired-profile"));
      mkdirSync(home);
      writeFileSync(join(home, "config.toml"), "[features]\nplugins = true\n# changed\n");
    }, home)).toBeNull();
  });

  test("unresolved system, managed, profile and ancestor authority blocks metadata-only decisions", () => {
    const { root, home, repo } = fixture();
    const system = join(root, "system-config.toml");
    writeFileSync(system, "[plugins.'sample@debug']\nenabled = false\n");
    const boundaries = { systemFiles: [system], managedPreferences: () => "absent" as const };
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries)).toBeNull();
    writeFileSync(system, "");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries))
      .toEqual({ marketplaces: [], plugins: [] });
    writeFileSync(system, "features = false\n");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries)).toBeNull();
    writeFileSync(system, "");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home,
      { ...boundaries, managedPreferences: () => "unknown" })).toBeNull();
    writeFileSync(join(home, "config.toml"), "profile = 'selected'\n");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home, boundaries)).toBeNull();
    writeFileSync(join(home, "config.toml"), `[projects.'${repo}']\ntrust_level = 'trusted'\n`);
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), "[plugins.'sample@debug']\nenabled = false\n");
    const nested = join(repo, "nested");
    mkdirSync(nested);
    expect(readCodexPluginMetadataInventory(nested, home, undefined, home, boundaries)).toBeNull();
  });

  test("a directory-specific trust refusal wins before trusted parent fallback and custom discovery is unknown", () => {
    const { home, repo } = fixture();
    const child = join(repo, "child");
    mkdirSync(join(child, ".codex"), { recursive: true });
    writeFileSync(join(child, ".codex", "config.toml"), "[marketplaces.hostile]\nsource_type = 'local'\nsource = 'not-absolute'\n");
    writeFileSync(join(home, "config.toml"),
      `[projects.'${repo}']\ntrust_level = 'trusted'\n[projects.'${child}']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home))
      .toEqual({ marketplaces: [], plugins: [] });
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), "[plugins.'broken'\n");
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    writeFileSync(join(home, "config.toml"), "project_root_markers = ['custom-marker']\n");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
  });

  test("absent and noncanonical child trust declarations preserve trusted-parent inheritance", () => {
    const { home, repo } = fixture();
    const child = join(repo, "child");
    mkdirSync(join(child, ".codex"), { recursive: true });
    writeFileSync(join(child, ".codex", "config.toml"), "[plugins.'broken'\n");
    const parentTrust = `[projects.'${repo}']\ntrust_level = 'trusted'\n`;
    writeFileSync(join(home, "config.toml"), `${parentTrust}[projects.'${child}']\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    writeFileSync(join(home, "config.toml"),
      `${parentTrust}[projects.'${child}${sep}..${sep}child']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    writeFileSync(join(home, "config.toml"),
      `${parentTrust}[projects.'${child}']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home))
      .toEqual({ marketplaces: [], plugins: [] });
  });

  test.skipIf(process.platform !== "win32")("Windows trust lookup selects normalized exact keys then sorted raw keys using ASCII case", () => {
    const { home, repo } = fixture();
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), "[plugins.'broken'\n");
    writeFileSync(join(home, "config.toml"),
      `[projects.'${repo.toUpperCase()}']\ntrust_level = 'trusted'\n`
      + `[projects.'${repo}']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(join(home, "config.toml"),
      `[projects.'${repo.toUpperCase()}']\ntrust_level = 'trusted'\n`
      + `[projects.'${repo.toLowerCase()}']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home))
      .toEqual({ marketplaces: [], plugins: [] });

    const child = join(repo, "École");
    mkdirSync(join(child, ".codex"), { recursive: true });
    writeFileSync(join(child, ".codex", "config.toml"), "[plugins.'broken'\n");
    rmSync(join(repo, ".codex"), { recursive: true, force: true });
    writeFileSync(join(home, "config.toml"),
      `[projects.'${repo}']\ntrust_level = 'trusted'\n`
      + `[projects.'${child.replace("École", "école")}']\ntrust_level = 'untrusted'\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
  });

  test("empty or malformed Git markers cannot hide a valid ancestor repository", () => {
    const { root, home, repo } = fixture();
    const child = join(repo, "child");
    mkdirSync(join(child, ".git"), { recursive: true });
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), "[plugins.'broken'\n");
    writeFileSync(join(home, "config.toml"), `[projects.'${repo}']\ntrust_level = 'trusted'\n`);
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    writeFileSync(join(child, ".git", "HEAD"), "not a Git head\n");
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    writeFileSync(join(child, ".git", "HEAD"), Buffer.from([0xff]));
    expect(readCodexPluginMetadataInventory(child, home, undefined, home)).toBeNull();
    rmSync(join(repo, ".codex"), { recursive: true, force: true });
    for (const detached of ["a".repeat(40), "b".repeat(64)]) {
      writeFileSync(join(child, ".git", "HEAD"), `${detached}\n`);
      expect(readCodexPluginMetadataInventory(child, home, undefined, home))
        .toEqual({ marketplaces: [], plugins: [] });
    }
    const linked = join(root, "linked-project");
    mkdirSync(linked);
    symlinkSync(join(repo, ".git"), join(linked, ".git"), process.platform === "win32" ? "junction" : "dir");
    expect(readCodexPluginMetadataInventory(linked, home, undefined, home)).toBeNull();
  });

  test("raw linked repository traversal and absent cache or repository identity swaps are rejected", () => {
    const { root, home, repo } = fixture();
    const alias = join(repo, "alias");
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    expect(readCodexPluginMetadataInventory(`${alias}${sep}..`, home, undefined, home)).toBeNull();
    snapshot(home);
    writeFileSync(join(home, "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`
        + `[plugins.'semctx-control@semctx-stable']\nenabled = true\n`);
    const cacheRoot = join(home, "plugins", "cache");
    mkdirSync(join(cacheRoot, "semctx-stable"), { recursive: true });
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      renameSync(cacheRoot, join(root, "retired-cache"));
      mkdirSync(join(cacheRoot, "semctx-stable"), { recursive: true });
    }, home)).toBeNull();
    expect(readCodexPluginMetadataInventory(repo, home, () => {
      renameSync(repo, join(root, "retired-repo"));
      writeGitRoot(repo);
    }, home)).toBeNull();
  });

  test("home marketplace discovery follows HOME, USERPROFILE, then confined OS fallback", () => {
    const { root, home, repo } = fixture();
    const osHome = join(root, "os-home");
    const environmentHome = join(root, "environment-home");
    const userProfile = join(root, "user-profile");
    for (const directory of [osHome, environmentHome, userProfile]) mkdirSync(directory);
    const malformed = (directory: string) => {
      mkdirSync(join(directory, ".agents", "plugins"), { recursive: true });
      writeFileSync(join(directory, ".agents", "plugins", "marketplace.json"), "{broken");
    };
    const boundaries = {
      systemFiles: [],
      managedPreferences: () => "absent" as const,
      resolveOsHome: () => osHome,
    };
    const originalHome = process.env["HOME"];
    const originalUserProfile = process.env["USERPROFILE"];
    try {
      delete process.env["HOME"];
      process.env["USERPROFILE"] = userProfile;
      malformed(userProfile);
      expect(readCodexPluginMetadataInventory(repo, home, undefined, undefined, boundaries)).toBeNull();
      rmSync(join(userProfile, ".agents"), { recursive: true, force: true });
      process.env["HOME"] = environmentHome;
      malformed(environmentHome);
      expect(readCodexPluginMetadataInventory(repo, home, undefined, undefined, boundaries)).toBeNull();
      rmSync(join(environmentHome, ".agents"), { recursive: true, force: true });
      delete process.env["HOME"];
      delete process.env["USERPROFILE"];
      malformed(osHome);
      expect(readCodexPluginMetadataInventory(repo, home, undefined, undefined, boundaries)).toBeNull();
      rmSync(join(osHome, ".agents"), { recursive: true, force: true });
      expect(readCodexPluginMetadataInventory(repo, home, undefined, undefined, boundaries))
        .toEqual({ marketplaces: [], plugins: [] });
      expect(readCodexPluginMetadataInventory(repo, home, undefined, undefined,
        { ...boundaries, resolveOsHome: () => null })).toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = originalUserProfile;
    }
  });

  test("Codex TOML metadata requires UTF-8 without a BOM and preserves valid Unicode", () => {
    const { home, repo } = fixture();
    const config = join(home, "config.toml");
    writeFileSync(config, "model = 'français'\n");
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home))
      .toEqual({ marketplaces: [], plugins: [] });
    writeFileSync(config, Buffer.concat([Buffer.from("model = '"), Buffer.from([0xff]), Buffer.from("'\n")]));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(config, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("model = 'valid'\n")]));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
  });

  test("Codex JSON metadata requires UTF-8 without a BOM and preserves valid Unicode", () => {
    const { home, repo } = fixture();
    snapshot(home);
    writeFileSync(join(home, "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`);
    const manifest = join(home, ".tmp", "marketplaces", "semctx-stable", ".agents", "plugins", "marketplace.json");
    const valid = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    writeFileSync(manifest, JSON.stringify({ ...valid, interface: { displayName: "Contexte sémantique" } }));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)?.marketplaces).toHaveLength(1);
    writeFileSync(manifest, Buffer.concat([Buffer.from('{"name":"semctx-stable","plugins":[] ,"x":"'),
      Buffer.from([0xff]), Buffer.from('"}') ]));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(manifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(valid))]));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
  });

  test("typed marketplace policy, interface and category fields match the pinned native schema", () => {
    const { home, repo } = fixture();
    snapshot(home);
    writeFileSync(join(home, "config.toml"),
      `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`);
    const manifestPath = join(home, ".tmp", "marketplaces", "semctx-stable", ".agents", "plugins", "marketplace.json");
    const valid = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const plugin = (valid["plugins"] as Record<string, unknown>[])[0]!;
    for (const policy of [null, { installation: 123 }, { installation: "UNKNOWN" },
      { authentication: false }, { products: ["NOT_A_PRODUCT"] }]) {
      writeFileSync(manifestPath, JSON.stringify({ ...valid, plugins: [{ ...plugin, policy }] }));
      expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    }
    writeFileSync(manifestPath, JSON.stringify({ ...valid, interface: { displayName: 123 } }));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    writeFileSync(manifestPath, JSON.stringify({ ...valid, plugins: [{ ...plugin, category: [] }] }));
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    for (const products of [[], ["CHATGPT"], ["chatgpt", "atlas"]]) {
      writeFileSync(manifestPath, JSON.stringify({ ...valid, plugins: [{ ...plugin,
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL", products } }] }));
      expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toBeNull();
    }
    for (const policy of [undefined, { products: null },
      { installation: "AVAILABLE", authentication: "ON_INSTALL", products: ["CODEX"] }]) {
      writeFileSync(manifestPath, JSON.stringify({ ...valid, plugins: [{ ...plugin,
        ...(policy === undefined ? {} : { policy }) }] }));
      expect(readCodexPluginMetadataInventory(repo, home, undefined, home)?.marketplaces).toHaveLength(1);
    }
  });

  test.skipIf(process.platform !== "darwin")("native CFPreferences distinguishes absent and present keys in an owned test domain", () => {
    const domain = `com.hoklims.semctx.test.${randomUUID()}`;
    expect(readCodexManagedPreferences(domain)).toBe("absent");
    const change = (present: boolean) => Bun.spawnSync([
      "/usr/bin/osascript", "-l", "JavaScript", "-e",
      `ObjC.import('Foundation');\n`
        + `ObjC.bindFunction('CFPreferencesSetAppValue', ['void', ['id', 'id', 'id']]);\n`
        + `ObjC.bindFunction('CFPreferencesAppSynchronize', ['bool', ['id']]);\n`
        + `var domain = $(${JSON.stringify(domain)});\n`
        + `$.CFPreferencesSetAppValue($('config_toml_base64'), ${present ? "$('owned-test-value')" : "$()"}, domain);\n`
        + `$.CFPreferencesAppSynchronize(domain);`,
    ], { stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 1024 });
    try {
      expect(change(true).exitCode).toBe(0);
      expect(readCodexManagedPreferences(domain)).toBe("present");
    } finally {
      expect(change(false).exitCode).toBe(0);
    }
    expect(readCodexManagedPreferences(domain)).toBe("absent");
  });
});
