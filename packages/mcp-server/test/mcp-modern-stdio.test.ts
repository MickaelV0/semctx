import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const MODERN_STDIO_TIMEOUT_MS = 60_000;

function stdioTransport(repositoryRoot: string): StdioClientTransport {
  const entrypoint = resolve(import.meta.dir, "../src/index.ts");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment["SEMCTX_ROOT"] = repositoryRoot;

  return new StdioClientTransport({
    command: "bun",
    args: [entrypoint],
    cwd: repositoryRoot,
    env: environment,
    stderr: "pipe",
  });
}

describe("MCP dual-era stdio negotiation", () => {
  test(
    "negotiates 2026-07-28 and publishes private catalogue cache hints",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-modern-stdio-test", version: "0.1.0" },
        {
          versionNegotiation: {
            mode: { pin: "2026-07-28" },
            probe: { timeoutMs: 10_000 },
          },
        },
      );

      try {
        await client.connect(transport);
        const discovery = client.getDiscoverResult() as
          | { ttlMs?: number; cacheScope?: string }
          | undefined;
        const result = await client.listTools();
        const cacheable = result as typeof result & {
          ttlMs?: number;
          cacheScope?: string;
        };
        const toolResult = await client.callTool({
          name: "semctx_semantic_check",
          arguments: { repositoryRoot },
        });
        const nonCacheableToolResult = toolResult as typeof toolResult & {
          ttlMs?: number;
          cacheScope?: string;
        };

        expect(discovery?.ttlMs).toBe(300_000);
        expect(discovery?.cacheScope).toBe("private");
        expect(result.tools).toHaveLength(31);
        expect(cacheable.ttlMs).toBe(300_000);
        expect(cacheable.cacheScope).toBe("private");
        expect(nonCacheableToolResult.ttlMs).toBeUndefined();
        expect(nonCacheableToolResult.cacheScope).toBeUndefined();
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );

  test(
    "continues to serve the 2025-era stdio handshake",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-legacy-stdio-test", version: "0.1.0" },
        { versionNegotiation: { mode: "legacy" } },
      );

      try {
        await client.connect(transport);
        const result = await client.listTools();

        expect(result.tools).toHaveLength(31);
        expect(result.tools.some((tool) => tool.name === "semctx_control_explorer")).toBe(true);
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );
});
