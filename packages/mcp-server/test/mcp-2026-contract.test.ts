import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createSemctxServer } from "../src/server";
import { ToolRegistrar } from "../src/tool-contract";

type RequestTrace = {
  traceparent?: string;
  tracestate?: string;
};

type SemctxServerFactory = (
  root?: string,
  options?: {
    onRequestContext?: (trace: RequestTrace) => void;
  },
) => McpServer;

const serverFactory = createSemctxServer as SemctxServerFactory;
const clients: Client[] = [];
const servers: McpServer[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function connect(root?: string, options?: Parameters<SemctxServerFactory>[1]) {
  const server = serverFactory(root, options);
  const client = new Client({ name: "semctx-2026-contract-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-${label}-`));
  mkdirSync(join(root, ".semctx", "semantic"), { recursive: true });
  temporaryRoots.push(root);
  return resolve(root);
}

describe("MCP 2026 public tool contract", () => {
  test("publishes a non-empty output schema for every listed tool", async () => {
    const client = await connect(process.cwd());
    const { tools } = await client.listTools();

    const missingOutputSchemas = tools
      .filter((tool) => {
        const schema = tool.outputSchema as Record<string, unknown> | undefined;
        return schema === undefined || Object.keys(schema).length === 0;
      })
      .map((tool) => tool.name);

    expect(missingOutputSchemas).toEqual([]);
  });

  test("publishes descriptive output fields instead of an unconstrained object", async () => {
    const client = await connect(process.cwd());
    const { tools } = await client.listTools();

    const genericOutputSchemas = tools
      .filter((tool) => {
        const schema = tool.outputSchema as {
          properties?: Record<string, unknown>;
          anyOf?: Array<{ properties?: Record<string, unknown> }>;
          oneOf?: Array<{ properties?: Record<string, unknown> }>;
        } | undefined;
        const variants = [
          schema,
          ...(schema?.anyOf ?? []),
          ...(schema?.oneOf ?? []),
        ];
        return !variants.some(
          (variant) =>
            variant?.properties !== undefined
            && Object.keys(variant.properties).length > 0,
        );
      })
      .map((tool) => tool.name);

    expect(genericOutputSchemas).toEqual([]);
  });

  test("publishes all four boolean annotation hints for every listed tool", async () => {
    const client = await connect(process.cwd());
    const { tools } = await client.listTools();

    const incompleteAnnotations = tools
      .filter((tool) => {
        const annotations = tool.annotations as Record<string, unknown> | undefined;
        return (
          annotations === undefined
          || typeof annotations.readOnlyHint !== "boolean"
          || typeof annotations.destructiveHint !== "boolean"
          || typeof annotations.idempotentHint !== "boolean"
          || typeof annotations.openWorldHint !== "boolean"
          || Object.keys(annotations).length !== 4
        );
      })
      .map((tool) => tool.name);

    expect(incompleteAnnotations).toEqual([]);
  });

  test("keeps every non-explorer tool visible only to the model", async () => {
    const client = await connect(process.cwd());
    const { tools } = await client.listTools();

    const invalidVisibility = tools
      .filter((tool) => tool.name !== "semctx_control_explorer")
      .filter((tool) => {
        const metadata = tool._meta as { ui?: { visibility?: unknown } } | undefined;
        return JSON.stringify(metadata?.ui?.visibility) !== JSON.stringify(["model"]);
      })
      .map((tool) => tool.name);

    expect(invalidVisibility).toEqual([]);
  });

  test("returns structured content equal to the JSON text for a read-only call", async () => {
    const root = temporaryRoot("structured-output");
    const client = await connect(root);

    const result = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: root },
    });
    const text = result.content.find((item) => item.type === "text");

    expect(result.structuredContent).toStrictEqual(
      JSON.parse(text?.type === "text" ? text.text : "null"),
    );
  });

  test("fails closed when a handler returns output outside its public schema", async () => {
    const server = new McpServer(
      { name: "invalid-output-contract-test", version: "0.1.0" },
    );
    const tools = new ToolRegistrar(server);
    tools.registerTool(
      "semctx_control_status",
      {
        description: "Deliberately invalid output used to lock the validation boundary.",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ unexpected: true }) }],
      }),
    );
    const client = new Client({
      name: "invalid-output-contract-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    servers.push(server);
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "semctx_control_status",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "does not match its public schema",
    );
  });
});

describe("MCP 2026 repository-root confinement", () => {
  test("rejects a request for a root other than the server-bound root", async () => {
    const boundRoot = temporaryRoot("bound");
    const otherRoot = temporaryRoot("other");
    const client = await connect(boundRoot);

    const result = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: otherRoot },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("repository root");
  });

  test("pins an unbound server to the first request root and rejects a second root", async () => {
    const firstRoot = temporaryRoot("first");
    const secondRoot = temporaryRoot("second");
    const client = await connect();

    const first = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: firstRoot },
    });
    const second = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: secondRoot },
    });

    expect(first.isError).not.toBe(true);
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toContain("repository root");
  });

  test("accepts an alias to the bound root but rejects a symlink or junction escape", async () => {
    const boundRoot = temporaryRoot("alias-bound");
    const otherRoot = temporaryRoot("alias-other");
    const aliasContainer = temporaryRoot("aliases");
    const boundAlias = join(aliasContainer, "bound-alias");
    const escapeAlias = join(aliasContainer, "escape-alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(boundRoot, boundAlias, linkType);
    symlinkSync(otherRoot, escapeAlias, linkType);
    const client = await connect(boundRoot);

    const sameRepository = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: boundAlias },
    });
    const escapedRepository = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: escapeAlias },
    });

    expect(sameRepository.isError).not.toBe(true);
    expect(escapedRepository.isError).toBe(true);
    expect(JSON.stringify(escapedRepository.content)).toContain("repository root");
  });
});

describe("MCP 2026 request tracing boundary", () => {
  test("makes traceparent and tracestate observable to the injected request hook", async () => {
    const root = temporaryRoot("trace");
    const observed: RequestTrace[] = [];
    const client = await connect(root, {
      onRequestContext: (trace) => observed.push(trace),
    });

    await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: root },
      _meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
        baggage: "secret=must-not-cross-the-hook",
      },
    });

    expect(observed).toEqual([
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      },
    ]);
  });

  test("drops invalid or duplicate W3C tracestate members before observation", async () => {
    const root = temporaryRoot("trace-invalid-state");
    const observed: RequestTrace[] = [];
    const client = await connect(root, {
      onRequestContext: (trace) => observed.push(trace),
    });

    await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: root },
      _meta: {
        tracestate: "1bad=value,1bad=duplicate",
      },
    });

    expect(observed).toEqual([{}]);
  });

  test("never returns trace context or baggage in tool results", async () => {
    const root = temporaryRoot("trace-result");
    const client = await connect(root);
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const tracestate = "vendor=value";
    const baggage = "secret=must-not-be-returned";

    const result = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: root },
      _meta: { traceparent, tracestate, baggage },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(traceparent);
    expect(serialized).not.toContain(tracestate);
    expect(serialized).not.toContain(baggage);
  });
});
