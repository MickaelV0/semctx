import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { indexRepository } from "@semantic-context/app-services";
import { captureControlHandoffV2 } from "@semantic-context/app-services/control-handoff";
import { explainControlHandoffV2 } from "@semantic-context/app-services/control-continuation";
import { buildPlanningBundle } from "@semantic-context/app-services/reconciliation";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO, must } from "@semantic-context/test-fixtures";
import { controlHandoffExplainTool } from "../src/control-continuation-tools";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSemctxServer } from "../src/server";

const roots: string[] = [];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semctx_control_handoff_explain MCP tool", () => {
  it.each(["memory", "packaged"] as const)("registers the %s transport and rejects undeclared inputs and relative roots", async (mode) => {
    const fixture = preparedRepository();
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const request = { schemaVersion: 1, capsuleHash: must(captured.capsule).capsuleHash };
    const server = mode === "memory" ? createSemctxServer(fixture.root) : undefined;
    const client = new Client({ name: "continuation-transport-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      if (server) {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
      } else {
        await client.connect(new StdioClientTransport({
          command: "bun",
          args: [resolve(import.meta.dir, "../../../plugins/semctx-control/dist/semctx-mcp.js")],
          cwd: tmpdir(),
          stderr: "pipe",
        }));
      }
      const result = await client.callTool({
        name: "semctx_control_handoff_explain", arguments: { repositoryRoot: fixture.root, request },
      });
      expect(result.isError).not.toBe(true);
      const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
      const explained = JSON.parse(text) as ReturnType<typeof explainControlHandoffV2>;
      expect(explained.status).toBe("EXPLAINED");
      expect(explained).toEqual(explainControlHandoffV2(
        fixture.root, { schemaVersion: 1, capsuleHash: request.capsuleHash }, must(explained.report).captureTime,
      ));
      for (const args of [
        { repositoryRoot: fixture.root, request, extra: true },
        { repositoryRoot: fixture.root, request: { ...request, extra: true } },
        { repositoryRoot: ".", request },
      ]) {
        const rejected = await client.callTool({ name: "semctx_control_handoff_explain", arguments: args });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected.content)).toContain("INVALID_ARGUMENTS");
      }
    } finally {
      await client.close();
      await server?.close();
    }
  });

  it("projects the same deterministic facts as the CLI/application-service transport", () => {
    const fixture = preparedRepository();
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);

    const viaTool = controlHandoffExplainTool(fixture.root, {
      schemaVersion: 1,
      capsuleHash: capsule.capsuleHash,
    });
    expect(viaTool.status, JSON.stringify(viaTool)).toBe("EXPLAINED");
    const captureTime = must(viaTool.report).captureTime;
    const viaService = explainControlHandoffV2(
      fixture.root,
      { schemaVersion: 1, capsuleHash: capsule.capsuleHash },
      captureTime,
    );
    expect(viaTool).toEqual(viaService);
  });

  it("refuses an unknown capsule with a typed reason and no report", () => {
    const fixture = preparedRepository();
    const result = controlHandoffExplainTool(fixture.root, {
      schemaVersion: 1,
      capsuleHash: `sha256:${"0".repeat(64)}`,
    });
    expect(result).toMatchObject({ status: "REFUSED", reasonCode: "ARTIFACT_MISSING", report: null });
  });
});

function preparedRepository() {
  const root = temporaryRoot("mcp-continuation");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.mcp-continuation",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  writeFileSync(
    join(root, ".semctx", "semantic", "mcp-continuation.sem"),
    [
      "goal goal.capacity",
      "  statement: Capacity behavior remains explicit.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 2",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-08-01T10:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.mcp-continuation",
    rawTask: "Adjust capacity behavior.",
    mode: "feature",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-08-01T09:00:00.000Z",
  };
  const sourcePath = "src/domain/capacity.ts";
  const store = openStore(root);
  const node = must(store.loadGraph().nodes.find((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === sourcePath
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === sourcePath)));
  store.saveTaskFrame(frame);
  store.close();
  const coordinateId = `repo:${node.id}` as const;
  const expectation = {
    schemaVersion: 1 as const,
    expectationId: "expectation.capacity",
    kind: "behavior" as const,
    level: 2 as const,
    required: true,
    subjectId: "goal.capacity",
    statement: "Capacity behavior remains explicit.",
    acceptanceEvidenceIds: [],
  };
  const bundle = buildPlanningBundle(root, {
    schemaVersion: 1,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: [{
      coordinateId,
      repositoryPath: sourcePath,
      evidenceId: "discovery:mcp-continuation",
      evidenceProvenance: "test",
      scope: { kind: "file", path: sourcePath },
    }],
    rollbackDescription: "Restore the committed implementation.",
    semanticExpectations: [expectation],
    repositoryEditExpectations: [{
      schemaVersion: 1,
      editId: "edit.capacity",
      kind: "modify",
      required: true,
      path: sourcePath,
      coordinateIds: [coordinateId],
      expectedLiftedExpectationIds: [expectation.expectationId],
      acceptanceEvidenceIds: [],
    }],
  });
  return {
    root,
    currentCoordinateId: "semantic:goal.capacity" as const,
    bundle,
  };
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `semctx-${label}-`));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}
