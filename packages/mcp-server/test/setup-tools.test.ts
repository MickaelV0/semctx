import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { isInitialized, saveConfig } from "@semantic-context/repository-store";
import { createSemctxServer } from "../src/server";
import { setupTool } from "../src/setup-tools";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

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
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("preflight after init reports initialized without re-writing", () => {
    root = freshRepo();
    const first = setupTool(root, { confirm: true });
    expect(first.kind).toBe("setup");
    if (first.kind !== "setup") return;
    expect(first.verdict).toBe("READY");

    const preflight = setupTool(root, {});
    expect(preflight.kind).toBe("setup_preflight");
    if (preflight.kind !== "setup_preflight") return;
    expect(preflight.initialized).toBe(true);
    expect(preflight.message).toMatch(/already has \.semctx/);
    expect(preflight.next.arguments.confirm).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(preflight).success).toBe(true);
  });

  test("confirm:true bootstraps via shared setup path (no global CLI)", () => {
    root = freshRepo();
    const report = setupTool(root, { confirm: true });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(true);
    expect(report.verdict).toBe("READY");
    expect(report.nodes).toBeGreaterThan(0);
    expect(isInitialized(root)).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("polyglot on existing v1 config returns setup_refused with guidance", () => {
    root = freshRepo();
    saveConfig(root, createDefaultConfig(root));
    const report = setupTool(root, { confirm: true, polyglot: true });
    expect(report.kind).toBe("setup_refused");
    if (report.kind !== "setup_refused") return;
    expect(report.reasonCode).toBe("CONFIG_INVALID");
    expect(report.verdict).toBe("REFUSED");
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.reason).toMatch(/migrate/i);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("not-ready analysis surfaces verdict NOT_READY with setup kind", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-nr-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "value.py"), "def value():\n    return 1\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fixture");
    const base = createGlobSelectionConfig(root);
    saveConfig(root, {
      ...base,
      languages: { ...base.languages, python: "off" },
    });

    const report = setupTool(root, { confirm: true });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("NOT_READY");
    // Soft MCP wire: isError stays false so the body is retained — agents must check verdict.
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("schema rejects malformed setup payloads", () => {
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({ kind: "setup" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      schemaVersion: 1,
      kind: "setup_refused",
      confirmRequired: false,
    }).success).toBe(false);
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
    expect(tool?.description).toMatch(/verdict/i);
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
    const body = applied.structuredContent as {
      kind?: string;
      setupReady?: boolean;
      nodes?: number;
      verdict?: string;
    };
    expect(body.kind).toBe("setup");
    expect(body.setupReady).toBe(true);
    expect(body.verdict).toBe("READY");
    expect((body.nodes ?? 0)).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(body).success).toBe(true);
  });
});
