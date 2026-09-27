import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexManagedPreferences, readCodexPluginMetadataInventory } from "../src/plugin-delivery";

const roots: string[] = [];
function fixture(): { root: string; home: string; repo: string } {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "semctx-codex-metadata-")));
  roots.push(root);
  const home = join(root, "profile");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(join(repo, ".git"));
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
    expect(readCodexPluginMetadataInventory(repo, home, undefined, home)).toEqual({ marketplaces: [], plugins: [] });
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
