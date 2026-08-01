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
import { isSetupAgentSuccess, isSetupDomainFailure, setupTool } from "../src/setup-tools";
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
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "fixture");
    return dir;
  }

  test("preflight refuses writes without confirm:true", () => {
    root = freshRepo();
    const report = setupTool(root, {});
    expect(report.kind).toBe("setup_preflight");
    if (report.kind !== "setup_preflight") return;
    expect(report.initialized).toBe(false);
    expect(report.confirmRequired).toBe(true);
    expect(isSetupDomainFailure(report)).toBe(false);
    expect(isSetupAgentSuccess(report)).toBe(false);
    expect(isInitialized(root)).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("preflight after init reports initialized without re-writing", () => {
    root = freshRepo();
    const first = setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" });
    expect(first.kind).toBe("setup");
    if (first.kind !== "setup") return;
    expect(first.verdict).toBe("SETUP_READY");

    const preflight = setupTool(root, {});
    expect(preflight.kind).toBe("setup_preflight");
    if (preflight.kind !== "setup_preflight") return;
    expect(preflight.initialized).toBe(true);
    expect(preflight.message).toMatch(/already has \.semctx/);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(preflight).success).toBe(true);
  });

  test("confirm:true bootstraps via shared setup path (no global CLI)", () => {
    root = freshRepo();
    const report = setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(true);
    expect(report.verdict).toBe("SETUP_READY");
    expect(isSetupAgentSuccess(report)).toBe(true);
    expect(report.nodes).toBeGreaterThan(0);
    expect(isInitialized(root)).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("polyglot on existing v1 config returns setup_refused with guidance", () => {
    root = freshRepo();
    saveConfig(root, createDefaultConfig(root));
    const report = setupTool(root, { confirm: true, polyglot: true, now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup_refused");
    if (report.kind !== "setup_refused") return;
    expect(report.reasonCode).toBe("CONFIG_INVALID");
    expect(report.verdict).toBe("SETUP_REFUSED");
    expect(isSetupDomainFailure(report)).toBe(true);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("not-ready analysis surfaces verdict SETUP_NOT_READY", () => {
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

    const report = setupTool(root, { confirm: true, now: "2026-08-01T12:00:00.000Z" });
    expect(report.kind).toBe("setup");
    if (report.kind !== "setup") return;
    expect(report.setupReady).toBe(false);
    expect(report.verdict).toBe("SETUP_NOT_READY");
    expect(isSetupDomainFailure(report)).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(report).success).toBe(true);
  });

  test("schema rejects malformed setup payloads", () => {
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({ kind: "setup" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      schemaVersion: 1,
      kind: "setup_refused",
      confirmRequired: false,
    }).success).toBe(false);
    // Wrong namespace: Plane C READY must not validate as setup verdict
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse({
      schemaVersion: 1,
      kind: "setup",
      repositoryRoot: "/tmp/x",
      configWritten: true,
      configPath: "/tmp/x/.semctx",
      alreadyInitialized: false,
      polyglot: false,
      sourceFiles: 0,
      selectedFiles: 0,
      selection: {
        configVersion: 1,
        mode: "legacy-v1",
        selectedByLanguage: {},
        excluded: 0,
        disabled: 0,
        unsupported: 0,
        failed: 0,
      },
      nodes: 0,
      edges: 0,
      claims: 0,
      freshnessSeal: null,
      indexHealth: {
        binding: {},
        freshness: {},
        coverage: {},
        workspaceDiagnostics: [],
        reasonSummary: [],
      },
      semanticFilesCreated: 0,
      gitignore: "create",
      check: { ok: true, nodes: 0, changes: 0, errors: 0 },
      setupReady: true,
      analysisReady: true,
      verdict: "READY",
    }).success).toBe(false);
  });

  test("MCP wire: READY success, refused and NOT_READY set isError with body", async () => {
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
    expect(tool?.description).toContain("SETUP_READY");
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
    const ready = applied.structuredContent as { kind?: string; verdict?: string; nodes?: number };
    expect(ready.kind).toBe("setup");
    expect(ready.verdict).toBe("SETUP_READY");
    expect((ready.nodes ?? 0)).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(ready).success).toBe(true);

    // Default fresh setup writes v1; polyglot against that workspace must refuse on the wire.
    const refused = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true, polyglot: true },
    });
    expect((refused.structuredContent as { kind?: string }).kind).toBe("setup_refused");
    expect(refused.isError).toBe(true);
    const refusedBody = refused.structuredContent as { verdict?: string; nextSteps?: string[] };
    expect(refusedBody.verdict).toBe("SETUP_REFUSED");
    expect((refusedBody.nextSteps ?? []).length).toBeGreaterThan(0);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(refused.structuredContent).success).toBe(true);
  });

  test("MCP wire: SETUP_NOT_READY is isError true with structured body", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-mcp-setup-wire-nr-"));
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

    server = createSemctxServer(root);
    client = new Client({ name: "semctx-setup-nr-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "semctx_setup",
      arguments: { repositoryRoot: root, confirm: true },
    });
    expect(result.isError).toBe(true);
    const body = result.structuredContent as { kind?: string; verdict?: string; setupReady?: boolean };
    expect(body.kind).toBe("setup");
    expect(body.verdict).toBe("SETUP_NOT_READY");
    expect(body.setupReady).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(body).success).toBe(true);
  });
});
