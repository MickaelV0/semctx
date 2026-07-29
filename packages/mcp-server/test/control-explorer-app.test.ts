import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { createSemctxServer } from "../src/server";

const APP_TOOL = "semctx_control_explorer";
const APP_URI = "ui://semctx/control-explorer-v1.html";
const APP_MIME = "text/html;profile=mcp-app";

interface UiMetadata {
  ui?: {
    resourceUri?: string;
    visibility?: string[];
    csp?: {
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
      baseUriDomains?: string[];
    };
    permissions?: unknown;
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("read-only Control Explorer MCP App", () => {
  let fixtureRoot: string;
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "semctx-control-explorer-app-"));
    cpSync(SAMPLE_REPO, fixtureRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(".semctx") && !source.includes("node_modules"),
    });
    git(fixtureRoot, "init");
    initWorkspace(fixtureRoot);
    git(fixtureRoot, "add", ".");
    git(
      fixtureRoot,
      "-c",
      "user.name=Semctx Test",
      "-c",
      "user.email=semctx@example.test",
      "commit",
      "-m",
      "fixture",
    );
    indexRepository(fixtureRoot, "2026-07-29T00:00:00.000Z");

    server = createSemctxServer(fixtureRoot);
    client = new Client({
      name: "semctx-control-explorer-app-test",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (fixtureRoot !== undefined) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("advertises the explorer with a complete output schema and read-only app metadata", async () => {
    const { tools } = await client.listTools();
    const explorer = tools.find((tool) => tool.name === APP_TOOL);
    if (explorer === undefined) {
      expect(tools.map((tool) => tool.name)).toContain(APP_TOOL);
      return;
    }

    expect(explorer.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect((explorer._meta as UiMetadata | undefined)?.ui).toEqual({
      resourceUri: APP_URI,
      visibility: ["model", "app"],
    });

    const inputSchema = explorer.inputSchema as {
      properties?: Record<string, {
        type?: string;
        minimum?: number;
        maximum?: number;
      }>;
      required?: string[];
    };
    expect(inputSchema.required).toContain("repositoryRoot");
    expect(inputSchema.properties?.["maxNodes"]).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(inputSchema.properties?.["maxNodes"]?.maximum).toBeGreaterThan(1);
    expect(inputSchema.properties?.["maxEdges"]).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(inputSchema.properties?.["maxEdges"]?.maximum).toBeGreaterThan(1);

    const outputSchema = explorer.outputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(outputSchema.type).toBe("object");
    for (const field of [
      "schemaVersion",
      "kind",
      "repository",
      "executionAuthority",
      "freshness",
      "coverage",
      "graph",
      "impact",
      "authority",
      "bounds",
      "truncated",
    ]) {
      expect(outputSchema.properties?.[field]).toBeDefined();
      expect(outputSchema.required).toContain(field);
    }
  });

  test("limits every non-explorer tool to model visibility", async () => {
    const { tools } = await client.listTools();
    const explorer = tools.find((tool) => tool.name === APP_TOOL);
    if (explorer === undefined) {
      expect(tools.map((tool) => tool.name)).toContain(APP_TOOL);
      return;
    }

    for (const tool of tools) {
      if (tool.name === APP_TOOL) continue;
      expect(
        (tool._meta as UiMetadata | undefined)?.ui?.visibility,
      ).toEqual(["model"]);
    }
  });

  test("exposes the app resource with a deny-all CSP and no permissions", async () => {
    const { resources } = await client.listResources();
    const resource = resources.find((candidate) => candidate.uri === APP_URI);
    if (resource === undefined) {
      expect(resources.map((candidate) => candidate.uri)).toContain(APP_URI);
      return;
    }

    expect(resource.mimeType).toBe(APP_MIME);
    expect((resource._meta as UiMetadata | undefined)?.ui).toEqual({
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
    });

    const read = await client.readResource({ uri: APP_URI });
    const content = read.contents.find((candidate) => candidate.uri === APP_URI);
    expect(content).toBeDefined();
    expect(content?.mimeType).toBe(APP_MIME);
    expect((content?._meta as UiMetadata | undefined)?.ui).toEqual({
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
    });
  });

  test("serves self-contained HTML without network, mutation, or code-injection capabilities", async () => {
    const { resources } = await client.listResources();
    if (!resources.some((candidate) => candidate.uri === APP_URI)) {
      expect(resources.map((candidate) => candidate.uri)).toContain(APP_URI);
      return;
    }

    const read = await client.readResource({ uri: APP_URI });
    const content = read.contents.find((candidate) => candidate.uri === APP_URI);
    const html =
      content !== undefined && "text" in content ? content.text : undefined;
    expect(typeof html).toBe("string");
    if (typeof html !== "string") return;

    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\b/);
    expect(html).not.toMatch(
      /\b(?:tools\/call|ui\/message|ui\/open-link|ui\/update-model-context)\b/,
    );
    expect(html).not.toMatch(/\binnerHTML\b|\beval\s*\(/);
    expect(html).not.toMatch(
      /<(?:script|img|link)\b[^>]*(?:src|href)\s*=|<iframe\b|@import\b|url\s*\(/i,
    );
  });

  test("implements the MCP App result handshake with accessible semantic landmarks", async () => {
    const { resources } = await client.listResources();
    if (!resources.some((candidate) => candidate.uri === APP_URI)) {
      expect(resources.map((candidate) => candidate.uri)).toContain(APP_URI);
      return;
    }

    const read = await client.readResource({ uri: APP_URI });
    const content = read.contents.find((candidate) => candidate.uri === APP_URI);
    const html =
      content !== undefined && "text" in content ? content.text : undefined;
    expect(typeof html).toBe("string");
    if (typeof html !== "string") return;

    expect(html).toContain("ui/initialize");
    expect(html).toContain("ui/notifications/initialized");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain("event.source !== window.parent");
    expect(html).toMatch(/<header\b/i);
    expect(html).toMatch(/<main\b/i);
    expect(html).toMatch(/<section\b/i);
    expect(html).toMatch(/<h1\b/i);
    expect(html).toMatch(/\baria-live\s*=/i);
  });

  test("returns one bounded non-authorizing snapshot as structured content and text", async () => {
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === APP_TOOL)) {
      expect(tools.map((tool) => tool.name)).toContain(APP_TOOL);
      return;
    }

    const response = await client.callTool({
      name: APP_TOOL,
      arguments: {
        repositoryRoot: fixtureRoot,
        maxNodes: 2,
        maxEdges: 3,
      },
    });
    expect(response.isError).not.toBe(true);

    const snapshot = response.structuredContent as
      | {
          schemaVersion?: unknown;
          kind?: unknown;
          repository?: { name?: unknown };
          executionAuthority?: unknown;
          freshness?: unknown;
          coverage?: unknown;
          graph?: unknown;
          impact?: unknown;
          authority?: unknown;
          bounds?: {
            maxNodes?: unknown;
            maxEdges?: unknown;
            returnedNodes?: unknown;
            returnedEdges?: unknown;
          };
          truncated?: unknown;
        }
      | undefined;
    expect(snapshot).toBeDefined();
    expect(snapshot?.schemaVersion).toBe(1);
    expect(snapshot?.kind).toBe("control_explorer");
    expect(snapshot?.repository).toEqual({ name: basename(fixtureRoot) });
    expect(snapshot?.executionAuthority).toBe("none");
    expect(snapshot?.freshness).toBeObject();
    expect(snapshot?.coverage).toBeObject();
    expect(snapshot?.graph).toBeObject();
    expect(snapshot?.impact).toEqual({ status: "not_requested" });
    expect(snapshot?.authority).toBeObject();
    expect(snapshot?.bounds).toMatchObject({
      maxNodes: 2,
      maxEdges: 3,
    });
    expect(snapshot?.bounds?.returnedNodes).toBeLessThanOrEqual(2);
    expect(snapshot?.bounds?.returnedEdges).toBeLessThanOrEqual(3);
    expect(typeof snapshot?.truncated).toBe("boolean");
    expect(JSON.stringify(snapshot)).not.toContain(fixtureRoot);

    const text = response.content.find((block) => block.type === "text");
    expect(text?.type).toBe("text");
    expect(
      JSON.parse(text?.type === "text" ? text.text : "null"),
    ).toEqual(snapshot);
  });
});
