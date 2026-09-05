import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCatalogRefPolicy } from "../scripts/build-plugin-runtime";

const repoRoot = resolve(import.meta.dir, "..");
function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}
function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

describe("Oh My Pi plugin manifests", () => {
  // Host-neutral on purpose: upstream ships `hoklims/semctx.git` at the `stable` tag, a fork
  // dogfooding the same tree ships its own URL pinned by `source.sha`. Both must satisfy the
  // same invariants, so this test never encodes one host's URL or ref.
  test("catalog delivers the Claude plugin tree by git-subdir, version-locked to the plugin", () => {
    const catalog = json<{
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; url: string; path: string; ref?: string; sha?: string };
        version: string;
      }>;
    }>(".omp-plugin/marketplace.json");
    const claude = json<{ version: string }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    expect(catalog.name).toBe("semctx-stable");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]).toMatchObject({
      name: "semctx",
      source: { source: "git-subdir", path: "plugins/claude-code" },
      version: claude.version,
    });
    // The subdir is the plugin root under `agent-plugins`, so it must be the tree that
    // carries the standard manifests.
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/plugin.json"))).toBe(true);
    expect(catalog.plugins[0]?.source.url).toMatch(/\/semctx\.git$/);
  });

  // The marketplace name ("semctx-stable") is a catalog label, not a Git pin: `omp plugin
  // marketplace add <owner>/semctx` fetches the catalog file itself from whatever ref the host
  // resolves by default. Only `source.ref`/`source.sha` bind the installed code. They are NOT
  // interchangeable: without `sha` the clone is shallow and `ref` is passed to
  // `git clone --branch`, which cannot resolve a raw commit id.
  test("the marketplace name alone is not a git pin — only source.ref/sha bind the install", () => {
    const catalog = json<{
      plugins: Array<{ source: { ref?: string; sha?: string } }>;
    }>(".omp-plugin/marketplace.json");
    const source = catalog.plugins[0]?.source;
    expect(source).toBeDefined();
    // Same rule `plugin:check` enforces: an immutable tag, or a branch pinned by `sha`.
    expect(() => assertCatalogRefPolicy(source ?? {}, "catalog")).not.toThrow();
  });

  test("Agent-Plugins mcp.json is a closed stdio launch with no cwd and no Claude placeholders", () => {
    const plugin = json<{
      $schema: string;
      name: string;
      version: string;
    }>("plugins/claude-code/plugin.json");
    const claude = json<{ version: string }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    expect(plugin.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    expect(plugin.name).toBe("semctx");
    expect(plugin.version).toBe(claude.version);
    const mcp = json<{
      $schema: string;
      mcpServers: {
        semctx: { type: string; command: string; args: string[]; cwd?: string };
      };
    }>("plugins/claude-code/mcp.json");
    expect(mcp).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        semctx: {
          type: "stdio",
          command: "bun",
          args: ["./dist/semctx-mcp.js"],
        },
      },
    });
    expect(mcp.mcpServers.semctx.cwd).toBeUndefined();
    expect(read("plugins/claude-code/mcp.json")).not.toMatch(/CLAUDE_/);
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/dist/semctx-mcp.js"))).toBe(true);
  });
});
