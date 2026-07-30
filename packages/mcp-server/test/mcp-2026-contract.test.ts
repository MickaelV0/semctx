import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { SemctxError } from "@semantic-context/core";
import { z } from "zod-v4";
import { createSemctxServer } from "../src/server";
import {
  ToolRegistrar,
  type ToolFailureDiagnostic,
} from "../src/tool-contract";

type RequestTrace = {
  traceparent?: string;
  tracestate?: string;
};

type SemctxServerFactory = (
  root?: string,
  options?: {
    onRequestContext?: (trace: RequestTrace) => unknown;
    onInternalDiagnostic?: (event: ToolFailureDiagnostic) => unknown;
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

  test("preserves Zod parsing behind the pass-through SDK schema", async () => {
    const server = new McpServer(
      { name: "input-parsing-contract-test", version: "0.1.0" },
    );
    let calls = 0;
    const tools = new ToolRegistrar(server);
    tools.registerTool(
      "semctx_control_status",
      {
        description: "Input parsing contract.",
        inputSchema: {
          value: z.string().trim().default("fallback"),
        },
        outputSchema: z.object({ value: z.string() }),
      },
      ({ value }) => {
        calls += 1;
        return {
          content: [{ type: "text", text: JSON.stringify({ value }) }],
        };
      },
    );
    const client = new Client({
      name: "input-parsing-contract-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    servers.push(server);
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const defaulted = await client.callTool({
      name: "semctx_control_status",
      arguments: {},
    });
    const transformed = await client.callTool({
      name: "semctx_control_status",
      arguments: { value: "  parsed  ", ignored: true },
    });
    const invalid = await client.callTool({
      name: "semctx_control_status",
      arguments: { value: 7 },
    });
    const overBudget = await client.callTool({
      name: "semctx_control_status",
      arguments: { ["k".repeat(1_025)]: true },
    });

    expect(defaulted.structuredContent).toEqual({ value: "fallback" });
    expect(transformed.structuredContent).toEqual({ value: "parsed" });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(
      invalid.content.find((item) => item.type === "text")?.text ?? "{}",
    )).toEqual({
      code: "INVALID_ARGUMENTS",
      error: "Tool arguments are invalid",
    });
    expect(JSON.parse(
      overBudget.content.find((item) => item.type === "text")?.text ?? "{}",
    )).toEqual({
      code: "INVALID_ARGUMENTS",
      error: "Tool arguments are invalid",
    });
    expect(calls).toBe(2);
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
    const text = result.content.find((item) => item.type === "text");
    const payload = JSON.parse(
      text?.type === "text" ? text.text : "{}",
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(payload).toEqual({
      code: "INVALID_OUTPUT",
      error: "Tool output did not match its public contract",
    });
  });

  test("does not expose output-validation diagnostics", async () => {
    const server = new McpServer(
      { name: "bounded-output-validation-contract-test", version: "0.1.0" },
    );
    const observed: ToolFailureDiagnostic[] = [];
    const tools = new ToolRegistrar(server, {
      onInternalDiagnostic: (event) => observed.push(event),
    });
    tools.registerTool(
      "semctx_control_status",
      {
        description: "Deliberately invalid output with an oversized schema diagnostic.",
        inputSchema: {},
        outputSchema: z.object({
          expected: z.string().refine(
            () => false,
            `secret-output-diagnostic-${"\u0000".repeat(10_000)}`,
          ),
        }),
      },
      () => ({
        content: [{
          type: "text",
          text: JSON.stringify({ expected: "value" }),
        }],
      }),
    );
    const client = new Client({
      name: "bounded-output-validation-contract-client",
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
    const text = result.content.find((item) => item.type === "text");
    const serialized = text?.type === "text" ? text.text : "";
    const payload = JSON.parse(serialized) as {
      code?: unknown;
      error?: unknown;
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(serialized.length).toBeLessThanOrEqual(4_096);
    expect(payload).toEqual({
      code: "INVALID_OUTPUT",
      error: "Tool output did not match its public contract",
    });
    expect(serialized).not.toContain("secret-output-diagnostic");
    expect(JSON.stringify(
      (observed[0]?.cause as Error | undefined)?.cause,
    )).toContain("secret-output-diagnostic");
  });

  test("keeps raw handler diagnostics on the internal observer only", async () => {
    const server = new McpServer(
      { name: "handler-error-contract-test", version: "0.1.0" },
    );
    const observed: ToolFailureDiagnostic[] = [];
    const tools = new ToolRegistrar(server, {
      onInternalDiagnostic: (event) => observed.push(event),
    });
    tools.registerTool(
      "semctx_control_status",
      {
        description: "Deliberately throwing handler used to lock the shared error boundary.",
        inputSchema: {},
      },
      () => {
        throw new Error(
          "secret-handler-failure C:\\private\\token.txt /private/token.txt",
        );
      },
    );
    const client = new Client({
      name: "handler-error-contract-client",
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
    expect(JSON.parse(
      result.content.find((item) => item.type === "text")?.text ?? "{}",
    )).toEqual({
      code: "INTERNAL_ERROR",
      error: "The tool could not complete the request",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.phase).toBe("handler");
    expect((observed[0]?.cause as Error).message).toContain(
      "secret-handler-failure",
    );
  });

  test("normalizes hostile thrown values without escaping the boundary", async () => {
    const server = new McpServer(
      { name: "hostile-handler-error-contract-test", version: "0.1.0" },
    );
    const tools = new ToolRegistrar(server);
    tools.registerTool(
      "semctx_control_status",
      {
        description: "Hostile thrown values used to lock the shared error boundary.",
        inputSchema: {
          variant: z.enum([
            "primitive",
            "non_string_message",
            "proxy_prototype_trap",
            "throwing_message_getter",
            "throwing_to_string",
          ]),
        },
      },
      ({ variant }) => {
        if (variant === "primitive") {
          throw "primitive failure";
        }
        if (variant === "non_string_message") {
          const malformed = new Error("ignored");
          Object.defineProperty(malformed, "message", { value: 7 });
          throw malformed;
        }
        if (variant === "proxy_prototype_trap") {
          throw new Proxy({}, {
            getPrototypeOf(): never {
              throw new Error(
                "SECRET_PROXY_TRAP C:\\private\\token /private/token",
              );
            },
          });
        }
        if (variant === "throwing_message_getter") {
          const malformed = new Error("ignored");
          Object.defineProperty(malformed, "message", {
            get(): never {
              throw new Error("hidden message getter failure");
            },
          });
          throw malformed;
        }
        throw {
          toString(): string {
            throw new Error("hidden conversion failure");
          },
        };
      },
    );
    const client = new Client({
      name: "hostile-handler-error-contract-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    servers.push(server);
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    for (const variant of [
      "primitive",
      "non_string_message",
      "proxy_prototype_trap",
      "throwing_message_getter",
      "throwing_to_string",
    ] as const) {
      const result = await client.callTool({
        name: "semctx_control_status",
        arguments: { variant },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse(
        result.content.find((item) => item.type === "text")?.text ?? "{}",
      )).toEqual({
        code: "INTERNAL_ERROR",
        error: "The tool could not complete the request",
      });
    }
  });

  test("rejects handler-authored error results even when diagnostics fail", async () => {
    const server = new McpServer(
      { name: "forged-handler-error-contract-test", version: "0.1.0" },
    );
    const tools = new ToolRegistrar(server, {
      onInternalDiagnostic: async () => {
        throw new Error("diagnostic observer failure");
      },
    });
    tools.registerTool(
      "semctx_control_status",
      {
        description: "A forged handler error must not become public text.",
        inputSchema: {},
      },
      () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "secret forged error C:\\private\\token.txt",
          }),
        }],
        isError: true,
      }) as never,
    );
    const client = new Client({
      name: "forged-handler-error-contract-client",
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
    const serialized =
      result.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(serialized)).toEqual({
      code: "INTERNAL_ERROR",
      error: "The tool could not complete the request",
    });
    expect(serialized).not.toContain("secret forged error");
  });

  test("maps SemctxError codes without exposing their diagnostic messages", async () => {
    const server = new McpServer(
      { name: "semctx-error-contract-test", version: "0.1.0" },
    );
    const observed: ToolFailureDiagnostic[] = [];
    const tools = new ToolRegistrar(server, {
      onInternalDiagnostic: (event) => observed.push(event),
    });
    tools.registerTool(
      "semctx_control_status",
      {
        description: "SemctxError sanitization contract.",
        inputSchema: {},
      },
      () => {
        throw new SemctxError(
          "STORE_ERROR",
          "secret store path C:\\private\\semctx.db",
        );
      },
    );
    const client = new Client({
      name: "semctx-error-contract-client",
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
    const serialized =
      result.content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      code: "STORE_ERROR",
      error: "Repository state is unavailable",
    });
    expect(serialized).not.toContain("C:\\private");
    expect(observed).toHaveLength(1);
    expect((observed[0]?.cause as SemctxError).message).toContain(
      "secret store path",
    );
  });

  test("normalizes oversized invalid input before a handler can run", async () => {
    const root = temporaryRoot("invalid-input");
    const observed: ToolFailureDiagnostic[] = [];
    const client = await connect(root, {
      onInternalDiagnostic: (event) => observed.push(event),
    });

    const result = await client.callTool({
      name: "semctx_control_impact",
      arguments: {
        repositoryRoot: root,
        sourceIds: Array.from({ length: 1_000 }, () => ({ invalid: true })),
      },
    });
    const serialized =
      result.content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(serialized.length).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(serialized)).toEqual({
      code: "INVALID_ARGUMENTS",
      error: "Tool arguments are invalid",
    });
    expect(observed).toHaveLength(1);
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

  test("does not expose an invalid repository path", async () => {
    const boundRoot = temporaryRoot("path-leak-bound");
    const secretMarker = "token-should-not-cross-mcp";
    const missingRoot = join(boundRoot, secretMarker, "missing");
    const observed: ToolFailureDiagnostic[] = [];
    const client = await connect(boundRoot, {
      onInternalDiagnostic: (event) => observed.push(event),
    });

    const result = await client.callTool({
      name: "semctx_control_status",
      arguments: { repositoryRoot: missingRoot },
    });
    const serialized =
      result.content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      code: "REPOSITORY_ROOT_UNAVAILABLE",
      error: "repository root does not exist or is not accessible",
    });
    expect(serialized).not.toContain(secretMarker);
    expect(JSON.stringify(
      (observed[0]?.cause as Error | undefined)?.cause,
    )).toContain(secretMarker);
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
  test("keeps request observers advisory when they fail", async () => {
    const root = temporaryRoot("trace-observer-failure");
    const diagnostics: ToolFailureDiagnostic[] = [];
    const client = await connect(root, {
      onRequestContext: async () => {
        throw new Error("secret trace observer failure");
      },
      onInternalDiagnostic: (event) => diagnostics.push(event),
    });

    const result = await client.callTool({
      name: "semctx_semantic_check",
      arguments: { repositoryRoot: root },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(result.isError).not.toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.phase).toBe("request_context");
    expect((diagnostics[0]?.cause as Error).message).toContain(
      "secret trace observer failure",
    );
    expect(JSON.stringify(result.content)).not.toContain(
      "secret trace observer failure",
    );
  });

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
