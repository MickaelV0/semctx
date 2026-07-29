import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("MCP 2026 SDK boundary", () => {
  test("uses the split v2 SDK without leaking it into the rest of the monorepo", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "packages/mcp-server/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(manifest.devDependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(manifest.dependencies?.["zod"]).toBe("^3.23.8");
    expect(manifest.dependencies?.["zod-v4"]).toBe("npm:zod@4.2.0");
  });

  test("serves stdio through the dual-era factory entrypoint", () => {
    const source = readFileSync(
      resolve(root, "packages/mcp-server/src/index.ts"),
      "utf8",
    );

    expect(source).toContain(
      'import { serveStdio } from "@modelcontextprotocol/server/stdio";',
    );
    expect(source).toContain("serveStdio(() => createSemctxServer(root)");
    expect(source).not.toContain("new StdioServerTransport()");
  });

  test("keeps legacy SDK imports out of production and test sources", () => {
    for (const relative of [
      "packages/mcp-server/src",
      "packages/mcp-server/test",
    ]) {
      const legacyPackage = ["@modelcontextprotocol", "sdk"].join("/");
      const legacyImport = `from\\s+["']${legacyPackage}`;
      const command = Bun.spawnSync(
        ["rg", "-n", legacyImport, relative],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(command.exitCode).toBe(1);
      expect(command.stdout.toString()).toBe("");
    }
  });
});
