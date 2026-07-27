import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  targetArtifactPath,
} from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { createSemctxServer } from "../src/server";

const roots: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

let server: McpServer | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("target proposal MCP transport", () => {
  it("creates the same bounded proposal artifact through the focused tool", async () => {
    const root = preparedRepository();
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-target-proposal-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name === "semctx_control_target_propose")).toBe(true);
    if (!tools.some((tool) => tool.name === "semctx_control_target_propose")) return;

    const result = await client.callTool({
      name: "semctx_control_target_propose",
      arguments: {
        repositoryRoot: root,
        command: proposalCommand(),
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const output = JSON.parse(textContent(result));
    expect(output).toMatchObject({
      kind: "target_architecture_proposal",
      certifying: false,
      executionAuthority: "none",
      artifact: {
        targetId: "target.checkout",
        normativeStatus: "proposed",
        authorshipOrigin: "agent",
      },
    });
    expect(JSON.parse(readFileSync(
      targetArtifactPath(root, "target.checkout", 1),
      "utf8",
    ))).toEqual(output.artifact);
  });
});

function proposalCommand(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    targetId: "target.checkout",
    revision: 1,
    statement: "Split checkout from catalog",
    elements: [
      {
        id: "repo:sym:checkout",
        level: 1,
        category: "code_entity",
        fingerprint: "code",
      },
      {
        id: "semantic:goal.checkout",
        level: 6,
        category: "goal",
        fingerprint: "goal",
      },
    ],
    relations: [
      {
        from: "semantic:goal.checkout",
        to: "repo:sym:checkout",
        relation: "realizes",
        fingerprint: "edge",
      },
    ],
    preservedInvariantIds: ["invariant.checkout.atomic"],
  };
}

function preparedRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-mcp-target-proposal-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-07-27T09:00:00.000Z");
  return root;
}

function textContent(result: unknown): string {
  if (
    typeof result !== "object"
    || result === null
    || !("content" in result)
    || !Array.isArray(result.content)
  ) return "";
  const first = result.content[0];
  return typeof first === "object"
    && first !== null
    && "type" in first
    && first.type === "text"
    && "text" in first
    && typeof first.text === "string"
    ? first.text
    : "";
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
