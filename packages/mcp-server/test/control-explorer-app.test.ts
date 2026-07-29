import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { ControlExplorerOutputSchema, controlExplorerTool } from "../src/control-explorer";
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
    const semanticDirectory = join(fixtureRoot, ".semctx", "semantic");
    mkdirSync(semanticDirectory, { recursive: true });
    writeFileSync(
      join(semanticDirectory, "explorer-omissions.sem"),
      [
        "goal goal.explorer.omission-accounting",
        "  statement: Explorer omission accounting has a non-vacuous authored refinement.",
        "  status: declared",
        "",
        "relation relation.explorer.missing-observed-endpoint decomposes_to source semantic goal.explorer.omission-accounting",
        `target observed_hunk sha256:${"a".repeat(64)}`,
        "epistemicStatus human_declared",
        "provenance author",
        `evidenceRef document_span docs/booking-rules.md:1 sha256:${"b".repeat(64)}`,
        "end",
        "",
      ].join("\n"),
    );
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

    type OutputSchemaNode = {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    const outputSchema = explorer.outputSchema as OutputSchemaNode;
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
    expect(outputSchema.additionalProperties).toBe(false);

    const exactNestedShapes: Record<string, string[]> = {
      repository: ["name"],
      freshness: [
        "schemaVersion",
        "kind",
        "basis",
        "verdict",
        "canRunHighRiskControl",
        "reasons",
        "seal",
      ],
      coverage: ["status", "levels", "unsupported", "unmapped", "reasons"],
      graph: [
        "schemaVersion",
        "kind",
        "terminalStatus",
        "reasonCodes",
        "nodes",
        "structuralEdges",
        "refinementRelations",
        "levelCoverage",
        "totals",
        "omissions",
      ],
      impact: ["status"],
      authority: [
        "schemaVersion",
        "kind",
        "executionAuthority",
        "requiredAltitude",
        "regime",
        "obligations",
        "rationale",
        "allowsAutonomousWrite",
        "freshness",
        "reasons",
      ],
      bounds: ["maxNodes", "maxEdges", "returnedNodes", "returnedEdges"],
    };
    for (const [field, nestedFields] of Object.entries(exactNestedShapes)) {
      const nested = outputSchema.properties?.[field] as OutputSchemaNode | undefined;
      expect(nested?.type).toBe("object");
      expect(Object.keys(nested?.properties ?? {})).toEqual(nestedFields);
      expect(nested?.required).toEqual(nestedFields);
      expect(nested?.additionalProperties).toBe(false);
    }

    const graphSchema = outputSchema.properties?.["graph"] as OutputSchemaNode;
    const omissionsSchema = graphSchema.properties?.["omissions"] as OutputSchemaNode;
    const omissionFields = [
      "nodesByNodeLimit",
      "structuralEdgesByNodeLimit",
      "structuralEdgesByEdgeLimit",
      "refinementRelationsByMissingEndpoint",
      "refinementRelationsByNodeLimit",
      "refinementRelationsByEdgeLimit",
    ];
    expect(omissionsSchema.type).toBe("object");
    expect(Object.keys(omissionsSchema.properties ?? {})).toEqual(omissionFields);
    expect(omissionsSchema.required).toEqual(omissionFields);
    expect(omissionsSchema.additionalProperties).toBe(false);
  });

  test("rejects undeclared fields inside the Explorer core payload", () => {
    const snapshot = controlExplorerTool(fixtureRoot, {
      maxNodes: 2,
      maxEdges: 3,
    });
    const invalid = {
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        unexpected: true,
      },
    };

    expect(ControlExplorerOutputSchema.safeParse(invalid).success).toBe(false);
  });

  test("bounds every exposed graph identifier to the selected node set", () => {
    const snapshot = controlExplorerTool(fixtureRoot, {
      maxNodes: 2,
      maxEdges: 20,
    });
    const selectedNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
    const selectedSemanticSourceIds = new Set(
      snapshot.graph.nodes
        .filter((node) => node.plane === "semantic")
        .map((node) => node.sourceId),
    );
    const selectedObservedIds = new Set(
      snapshot.graph.nodes
        .filter((node) => node.plane === "observed")
        .flatMap((node) => [node.id, node.sourceId]),
    );

    expect(selectedNodeIds.size).toBeLessThanOrEqual(2);
    expect(
      new Set(
        snapshot.graph.levelCoverage.flatMap((level) => level.coordinateIds),
      ).size,
    ).toBeLessThanOrEqual(2);
    for (const level of snapshot.graph.levelCoverage) {
      expect(
        level.coordinateIds.every((coordinateId) =>
          selectedNodeIds.has(coordinateId)
        ),
      ).toBe(true);
    }
    for (const edge of snapshot.graph.structuralEdges) {
      expect(selectedNodeIds.has(edge.from)).toBe(true);
      expect(selectedNodeIds.has(edge.to)).toBe(true);
    }
    for (const relation of snapshot.graph.refinementRelations) {
      for (const endpoint of [relation.source, relation.target]) {
        expect(
          endpoint.plane === "B"
            ? selectedSemanticSourceIds.has(endpoint.nodeId)
            : selectedObservedIds.has(endpoint.coordinateDigest),
        ).toBe(true);
      }
    }
  });

  test("accounts separately for missing endpoints, node bounds, and edge bounds", () => {
    const full = controlExplorerTool(fixtureRoot, {
      maxNodes: 1_000,
      maxEdges: 2_000,
    });
    expect(
      full.graph.omissions.refinementRelationsByMissingEndpoint,
    ).toBe(1);
    expect(full.truncated).toBe(true);
    expect(full.graph.totals.nodes).toBe(
      full.bounds.returnedNodes + full.graph.omissions.nodesByNodeLimit,
    );
    expect(full.graph.totals.edges).toBe(
      full.bounds.returnedEdges
      + Object.entries(full.graph.omissions)
        .filter(([key]) => key !== "nodesByNodeLimit")
        .reduce((total, [, count]) => total + count, 0),
    );

    const nodeBound = controlExplorerTool(fixtureRoot, {
      maxNodes: 1,
      maxEdges: 2_000,
    });
    expect(nodeBound.graph.omissions.nodesByNodeLimit).toBeGreaterThan(0);
    expect(
      nodeBound.graph.omissions.structuralEdgesByNodeLimit
      + nodeBound.graph.omissions.refinementRelationsByNodeLimit,
    ).toBeGreaterThan(0);
    expect(nodeBound.bounds.returnedNodes).toBeLessThanOrEqual(1);

    const edgeBound = controlExplorerTool(fixtureRoot, {
      maxNodes: 1_000,
      maxEdges: 1,
    });
    expect(
      edgeBound.graph.omissions.structuralEdgesByEdgeLimit
      + edgeBound.graph.omissions.refinementRelationsByEdgeLimit,
    ).toBeGreaterThan(0);
    expect(edgeBound.bounds.returnedEdges).toBeLessThanOrEqual(1);

    expect(Object.values(full.graph.omissions).every(Number.isInteger)).toBe(true);
    expect(JSON.stringify(full.graph.omissions)).not.toContain("goal.explorer");
    expect(JSON.stringify(full.graph.omissions)).not.toContain(`sha256:${"a".repeat(64)}`);
  });

  test("rejects tampered bounds, counts, totals, and truncation claims", () => {
    const snapshot = controlExplorerTool(fixtureRoot, {
      maxNodes: 1_000,
      maxEdges: 2_000,
    });
    const invalidSnapshots = [
      {
        ...snapshot,
        bounds: { ...snapshot.bounds, maxNodes: 1 },
      },
      {
        ...snapshot,
        bounds: { ...snapshot.bounds, maxEdges: 1 },
      },
      {
        ...snapshot,
        bounds: {
          ...snapshot.bounds,
          returnedNodes: snapshot.bounds.returnedNodes + 1,
        },
      },
      {
        ...snapshot,
        bounds: {
          ...snapshot.bounds,
          returnedEdges: snapshot.bounds.returnedEdges + 1,
        },
      },
      {
        ...snapshot,
        graph: {
          ...snapshot.graph,
          omissions: {
            ...snapshot.graph.omissions,
            refinementRelationsByMissingEndpoint:
              snapshot.graph.omissions.refinementRelationsByMissingEndpoint + 1,
          },
        },
      },
      {
        ...snapshot,
        graph: {
          ...snapshot.graph,
          totals: {
            ...snapshot.graph.totals,
            nodes: snapshot.graph.totals.nodes + 1,
          },
        },
      },
      {
        ...snapshot,
        graph: {
          ...snapshot.graph,
          totals: {
            ...snapshot.graph.totals,
            edges: snapshot.graph.totals.edges + 1,
          },
        },
      },
      {
        ...snapshot,
        truncated: !snapshot.truncated,
      },
    ];

    for (const invalid of invalidSnapshots) {
      expect(ControlExplorerOutputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test("rejects omitted endpoint and level-coverage identifier leakage", () => {
    const full = controlExplorerTool(fixtureRoot, {
      maxNodes: 1_000,
      maxEdges: 2_000,
    });
    const bounded = controlExplorerTool(fixtureRoot, {
      maxNodes: 1,
      maxEdges: 20,
    });
    const selectedNodeIds = new Set(bounded.graph.nodes.map((node) => node.id));
    const selectedQualifiedNode = bounded.graph.nodes.find((node) =>
      node.id.startsWith("repo:") || node.id.startsWith("semantic:")
    );
    const omittedQualifiedNode = full.graph.nodes.find((node) =>
      !selectedNodeIds.has(node.id)
      && (node.id.startsWith("repo:") || node.id.startsWith("semantic:"))
    );
    expect(selectedQualifiedNode).toBeDefined();
    expect(omittedQualifiedNode).toBeDefined();
    if (
      selectedQualifiedNode === undefined
      || omittedQualifiedNode === undefined
    ) return;

    const endpointLeak = {
      ...bounded,
      graph: {
        ...bounded.graph,
        structuralEdges: [{
          from: selectedQualifiedNode.id,
          to: omittedQualifiedNode.id,
          relation: "adversarial_omitted_endpoint",
          evidenceRefs: [],
        }],
        refinementRelations: [],
      },
      bounds: {
        ...bounded.bounds,
        returnedEdges: 1,
      },
    };
    expect(ControlExplorerOutputSchema.safeParse(endpointLeak).success).toBe(false);

    const coverageLevel = bounded.graph.levelCoverage[0];
    expect(coverageLevel).toBeDefined();
    if (coverageLevel === undefined) return;
    const coverageLeak = {
      ...bounded,
      graph: {
        ...bounded.graph,
        levelCoverage: bounded.graph.levelCoverage.map((level) =>
          level.level === coverageLevel.level
            ? {
                ...level,
                coordinateIds: [
                  ...level.coordinateIds,
                  omittedQualifiedNode.id,
                ].sort(),
              }
            : level
        ),
      },
    };
    expect(ControlExplorerOutputSchema.safeParse(coverageLeak).success).toBe(false);
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
    expect(html).toContain("nodes by node limit");
    expect(html).toContain("structural edges by edge limit");
    expect(html).toContain("refinements with missing endpoints");
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
