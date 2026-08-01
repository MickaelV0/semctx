import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { isInitialized } from "@semantic-context/repository-store";
import { createSemctxServer } from "../src/server";
import { setupTool } from "../src/setup-tools";

describe("semctx_setup MCP tool", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function freshRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-"));
    cpSync(SAMPLE_REPO, dir, {
      recursive: true,
      filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
    });
    return dir;
  }

  test("preflight refuses writes without confirm:true", () => {
    root = freshRepo();
    const report = setupTool(root, {});
    expect(report.kind).toBe("setup_preflight");
    if (report.kind !== "setup_preflight") return;
    expect(report.initialized).toBe(false);
    expect(report.confirmRequired).toBe(true);
    expect(report.next.arguments.confirm).toBe(true);
    expect(isInitialized(root)).toBe(false);
  });

  test("confirm:true bootstraps via shared setup path (no global CLI)", () => {
    root = freshRepo();
    const report = setupTool(root, { confirm: true });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(true);
    expect(report.nodes).toBeGreaterThan(0);
    expect(isInitialized(root)).toBe(true);
  });

  test("registers idempotent writer with validated structured output", async () => {
    root = freshRepo();
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "semctx_setup");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.description).toContain("PLUGIN-NATIVE SETUP");
    expect(tool?.inputSchema.required).toContain("repositoryRoot");

    const preflight = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root },
    });
    expect(preflight.isError).not.toBe(true);
    expect((preflight.structuredContent as { kind?: string }).kind).toBe("setup_preflight");

    const applied = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true },
    });
    expect(applied.isError).not.toBe(true);
    const body = applied.structuredContent as { kind?: string; setupReady?: boolean; nodes?: number };
    expect(body.kind).toBe("setup");
    expect(body.setupReady).toBe(true);
    expect((body.nodes ?? 0)).toBeGreaterThan(0);
  });
});
