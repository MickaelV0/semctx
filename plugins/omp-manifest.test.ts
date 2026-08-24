import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}
function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

describe("Oh My Pi plugin manifests", () => {
  test("catalog pins the Claude plugin tree to the stable git ref with matching version", () => {
    const catalog = json<{
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; url: string; path: string; ref: string };
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
      source: {
        source: "git-subdir",
        url: "https://github.com/hoklims/semctx.git",
        path: "plugins/claude-code",
        ref: "stable",
      },
      version: claude.version,
    });
  });

  // The marketplace name ("semctx-stable") is a catalog label, not a Git pin: `omp plugin
  // marketplace add hoklims/semctx` can fetch the catalog file itself from whatever ref the
  // host resolves by default. Only the plugin `source.ref` field below binds the installed code
  // to `stable`; an install that trusted the name alone would silently track `main`.
  test("the marketplace name alone is not a git pin — only source.ref binds the install", () => {
    const catalog = json<{
      plugins: Array<{ source: { ref: string } }>;
    }>(".omp-plugin/marketplace.json");
    const ref = catalog.plugins[0]?.source.ref;
    expect(ref).toBe("stable");
    expect(ref).not.toBe("main");
  });

  test("OMP manifest replaces .mcp.json with a Codex-like launch and no Claude placeholders", () => {
    const manifest = json<{ mcpServers: string }>(
      "plugins/claude-code/.omp-plugin/plugin.json",
    );
    expect(manifest.mcpServers).toBe("./mcp-omp.json");
    const mcp = json<{
      mcpServers: { semctx: { command: string; args: string[]; cwd: string } };
    }>("plugins/claude-code/mcp-omp.json");
    expect(mcp.mcpServers.semctx).toEqual({
      command: "bun",
      args: ["./dist/semctx-mcp.js"],
      cwd: ".",
    });
    expect(read("plugins/claude-code/mcp-omp.json")).not.toMatch(/CLAUDE_/);
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/dist/semctx-mcp.js"))).toBe(true);
  });
});
