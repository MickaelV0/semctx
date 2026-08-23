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
  test("catalog points at the Claude plugin tree with matching version", () => {
    const catalog = json<{
      name: string;
      plugins: Array<{ name: string; source: string; version: string }>;
    }>(".omp-plugin/marketplace.json");
    const claude = json<{ version: string }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    expect(catalog.name).toBe("semctx-stable");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]).toMatchObject({
      name: "semctx",
      source: "./plugins/claude-code",
      version: claude.version,
    });
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
