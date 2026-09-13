import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { indexRepository } from "@semantic-context/app-services";
import { captureControlHandoffV2 } from "@semantic-context/app-services/control-handoff";
import { explainControlHandoffV2 } from "@semantic-context/app-services/control-continuation";
import { buildPlanningBundle } from "@semantic-context/app-services/reconciliation";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO, must } from "@semantic-context/test-fixtures";
import { CONTROL_HANDOFF_HELP } from "../src/commands/control-handoff";

const roots: string[] = [];
const CLI = join(import.meta.dir, "..", "src", "index.ts");
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

describe("control handoff explain CLI transport", () => {
  it("documents the explain subcommand and grants no execution authority", () => {
    expect(CONTROL_HANDOFF_HELP).toContain("control handoff explain --hash <sha256>");
    expect(CONTROL_HANDOFF_HELP).toContain("granting no execution authority");
    const help = runCli(process.cwd(), ["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("control handoff explain --hash <sha256>");
  });

  it("projects the same deterministic facts as the application service", () => {
    const fixture = preparedRepository();
    const captured = captureControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      planningBundle: fixture.bundle,
      progress: { state: "not_started", currentCoordinateId: fixture.currentCoordinateId },
    });
    const capsule = must(captured.capsule);

    const result = runCli(fixture.root, [
      "control",
      "handoff",
      "explain",
      "--hash",
      capsule.capsuleHash,
      "--json",
    ]);
    expect(result.code, result.err).toBe(0);

    const cliBody = JSON.parse(result.out) as { report: { captureTime: string } | null };
    const direct = explainControlHandoffV2(
      fixture.root,
      { schemaVersion: 1, capsuleHash: capsule.capsuleHash },
      must(cliBody.report).captureTime,
    );
    expect(cliBody).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it("exits 2 on a typed refusal without granting authority", () => {
    const fixture = preparedRepository();
    const result = runCli(fixture.root, [
      "control",
      "handoff",
      "explain",
      "--hash",
      `sha256:${"0".repeat(64)}`,
      "--json",
    ]);
    expect(result.code, result.err).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ status: "REFUSED", reasonCode: "ARTIFACT_MISSING" });
  });
});

function preparedRepository() {
  const root = temporaryRoot("cli-continuation");
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.cli-continuation",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  writeFileSync(
    join(root, ".semctx", "semantic", "cli-continuation.sem"),
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
    id: "task.cli-continuation",
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
      evidenceId: "discovery:cli-continuation",
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
  const root = mkdtempSync(join(tmpdir(), `semctx-cli-${label}-`));
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

function runCli(root: string, argv: readonly string[]): { code: number; out: string; err: string } {
  const process = Bun.spawnSync(
    ["bun", "run", CLI, ...argv, "--root", root],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: process.exitCode ?? 1,
    out: new TextDecoder().decode(process.stdout),
    err: new TextDecoder().decode(process.stderr),
  };
}
