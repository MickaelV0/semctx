import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { indexRepository } from "@semantic-context/app-services";
import {
  buildPlanningBundle,
  prepareTaskEnvelope,
  reconcileWorkingTree,
} from "@semantic-context/app-services/reconciliation";
import {
  captureControlHandoffV2,
  resumeControlHandoffV2,
} from "@semantic-context/app-services/control-handoff";
import {
  serializeControlReport,
  type ReconcileWorkingTreeInputV1,
} from "@semantic-context/control-model/reconciliation";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  newChangeContract,
  writeChangeFile,
  writeKindFile,
} from "@semantic-context/semantic-engine";
import {
  inspectReconciliationAuthorityClosure,
  SAMPLE_REPO,
  must,
} from "@semantic-context/test-fixtures";
import { CONTROL_RECONCILIATION_HELP } from "../src/commands/control-reconciliation";
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

describe("control reconciliation CLI transport", () => {
  it("documents only bounded pre-edit planning and read-only reconciliation", () => {
    expect(CONTROL_RECONCILIATION_HELP).toContain("frame-task <change-id>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("bind-scope <change-id>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("plan-change <change-id>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("executionAuthority \"none\"");
    expect(CONTROL_RECONCILIATION_HELP).toContain("reconcile-diff <input.json>");
    expect(CONTROL_HANDOFF_HELP).toContain("handoff <input.json>");
    expect(CONTROL_HANDOFF_HELP).toContain("resume-handoff <capsule-hash>");
    expect(CONTROL_RECONCILIATION_HELP).toContain("no caller-selected Git refs");
    expect(CONTROL_RECONCILIATION_HELP).not.toContain("--base");
    expect(CONTROL_RECONCILIATION_HELP).not.toContain("--head");
  });

  it("frames a task from framing-only inputs, with no plan and no rollback required", () => {
    const fixture = preparedRepository();
    // Only the framing half: no rollbackDescription, no expectations, no test references.
    const framingInputs = { explicitDiscoveries: fixture.plannerInputs.explicitDiscoveries };
    const inputFile = temporaryJson("framing.json", framingInputs);
    const expected = prepareTaskEnvelope(fixture.root, {
      schemaVersion: 1,
      taskFrameId: fixture.taskFrameId,
      changeId: fixture.changeId,
      ...framingInputs,
    });

    const result = runCli(fixture.root, [
      "control",
      "frame-task",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
      "--json",
    ]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      kind: "prepared_task_envelope",
      certifying: false,
    });
    // Same envelope the full bundle embeds, reached without describing a plan.
    expect(JSON.parse(result.out).envelope)
      .toEqual(buildPlanningBundle(fixture.root, fixture.command).taskEnvelope);
  });

  it("binds scope through a focused primitive while preserving canonical envelope bytes", () => {
    const fixture = preparedRepository();
    const bindingInputs = { explicitDiscoveries: fixture.plannerInputs.explicitDiscoveries };
    const inputFile = temporaryJson("bindings.json", bindingInputs);
    const expected = prepareTaskEnvelope(fixture.root, {
      schemaVersion: 1,
      taskFrameId: fixture.taskFrameId,
      changeId: fixture.changeId,
      ...bindingInputs,
    });

    const result = runCli(fixture.root, [
      "control",
      "bind-scope",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
      "--json",
    ]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      kind: "prepared_task_envelope",
      certifying: false,
      envelope: {
        executionAuthority: "none",
      },
    });
  });

  it("rejects framing-only fields from bind-scope while preserving frame-task compatibility", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("framing-only.json", {
      taskFrameAdvisory: {},
      explicitDiscoveries: fixture.plannerInputs.explicitDiscoveries,
    });
    const common = [
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
      "--json",
    ];

    const focused = runCli(fixture.root, ["control", "bind-scope", ...common]);
    expect(focused.code).not.toBe(0);
    expect(focused.err).toContain("ZodError");

    const compatibility = runCli(fixture.root, ["control", "frame-task", ...common]);
    expect(compatibility.code, compatibility.err).toBe(0);
    expect(JSON.parse(compatibility.out).kind).toBe("prepared_task_envelope");
  });

  it("rejects framing files that redefine CLI-bound identities", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("framing-bad.json", { changeId: "change.other" });

    const result = runCli(fixture.root, [
      "control",
      "frame-task",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("must not redefine CLI-bound fields");
  });

  it("emits the exact canonical PlanningBundle returned by app-services", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("planner.json", fixture.plannerInputs);
    const expected = buildPlanningBundle(fixture.root, fixture.command);

    const result = runCli(fixture.root, [
      "control",
      "plan-change",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
      "--json",
    ]);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toEqual(expected);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 1,
      kind: "planning_bundle",
      executionAuthority: "none",
    });
  });

  it("returns REALIZED with canonical app-service bytes for the actual worktree diff", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, fixture.command);
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
    const input: ReconcileWorkingTreeInputV1 = {
      schemaVersion: 1,
      planningBundle: bundle,
    };
    const inputFile = temporaryJson("reconciliation.json", input);
    const expected = reconcileWorkingTree(fixture.root, input);

    const result = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
      "--json",
    ]);

    expect(expected.terminalStatus, serializeControlReport(expected)).toBe("REALIZED");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe(`${serializeControlReport(expected)}\n`);
    expect(JSON.parse(result.out)).toEqual(expected);
  });

  it("rejects Git reference flags and extra fields in the shared input", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, fixture.command);
    const inputFile = temporaryJson("reconciliation-extra-ref.json", {
      schemaVersion: 1,
      planningBundle: bundle,
      baseRef: "HEAD~1",
    });

    const callerRef = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
      "--base",
      "HEAD~1",
    ]);
    expect(callerRef.code).not.toBe(0);
    expect(callerRef.err).toContain("does not accept caller-selected Git refs");

    const extraInput = runCli(fixture.root, [
      "control",
      "reconcile-diff",
      inputFile,
    ]);
    expect(extraInput.code).not.toBe(0);
    expect(extraInput.err).toContain("Unrecognized key");
  });

  it("rejects planner files that attempt to redefine CLI-bound identities", () => {
    const fixture = preparedRepository();
    const inputFile = temporaryJson("planner-reserved.json", {
      ...fixture.plannerInputs,
      changeId: "change.caller-override",
    });

    const result = runCli(fixture.root, [
      "control",
      "plan-change",
      fixture.changeId,
      "--task-id",
      fixture.taskFrameId,
      "--input",
      inputFile,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("must not redefine CLI-bound fields");
  });

  it("captures and resumes Control Handoff v2 with canonical app-service bytes", () => {
    const fixture = preparedRepository();
    const expectation = handoffExpectation();
    const planningBundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      semanticExpectations: [expectation],
    });
    const currentCoordinateId = `semantic:${expectation.subjectId}` as const;
    const request = {
      schemaVersion: 2 as const,
      planningBundle,
      progress: { state: "not_started" as const, currentCoordinateId },
    };
    const inputFile = temporaryJson("control-handoff-v2.json", request);
    const expectedCapture = captureControlHandoffV2(fixture.root, request);
    expect(expectedCapture.status, serializeControlReport(expectedCapture)).toBe("CAPTURED");
    if (expectedCapture.capsule === null) throw new Error("capture must return a capsule");

    const cliCapture = runCli(fixture.root, ["control", "handoff", inputFile, "--json"]);
    expect(cliCapture.code, cliCapture.err).toBe(0);
    expect(cliCapture.out).toBe(`${serializeControlReport(expectedCapture)}\n`);

    const expectedResume = resumeControlHandoffV2(fixture.root, {
      schemaVersion: 2,
      capsuleHash: expectedCapture.capsule.capsuleHash,
    });
    expect(expectedResume.status).toBe("RESUMED");
    const cliResume = runCli(fixture.root, [
      "control",
      "resume-handoff",
      expectedCapture.capsule.capsuleHash,
      "--json",
    ]);
    expect(cliResume.code, cliResume.err).toBe(0);
    expect(cliResume.out).toBe(`${serializeControlReport(expectedResume)}\n`);

  }, 30_000);

  it("rejects non-strict capture input and propagates stale resume as null", () => {
    const fixture = preparedRepository();
    const expectation = handoffExpectation();
    const planningBundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      semanticExpectations: [expectation],
    });
    const currentCoordinateId = `semantic:${expectation.subjectId}` as const;
    const request = {
      schemaVersion: 2 as const,
      planningBundle,
      progress: { state: "not_started" as const, currentCoordinateId },
    };
    const invalid = runCli(fixture.root, [
      "control",
      "handoff",
      temporaryJson("invalid-control-handoff-v2.json", { ...request, extra: true }),
      "--json",
    ]);
    expect(invalid.code).not.toBe(0);

    const captured = captureControlHandoffV2(fixture.root, request);
    if (captured.capsule === null) {
      throw new Error(`capture must return a capsule: ${serializeControlReport(captured)}`);
    }
    writeFileSync(join(fixture.root, fixture.path), "export const changed = true;\n", "utf8");
    const resumed = runCli(fixture.root, [
      "control",
      "resume-handoff",
      captured.capsule.capsuleHash,
      "--json",
    ]);
    expect(resumed.code).toBe(3);
    expect(JSON.parse(resumed.out)).toMatchObject({
      operation: "resume",
      status: "REFUSED",
      capsule: null,
    });
  }, 30_000);

  it("has no recursive runtime path to authorization, writers, or execution", () => {
    const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
    const entry = resolve(
      repositoryRoot,
      "apps",
      "cli",
      "src",
      "commands",
      "control-reconciliation.ts",
    );
    const closure = inspectReconciliationAuthorityClosure(repositoryRoot, entry);
    expect(closure.violations).toEqual([]);

    const source = readFileSync(entry, "utf8");
    expect(source).toContain("@semantic-context/app-services/reconciliation");
    expect(source).toContain("@semantic-context/control-model/reconciliation");
    expect(source).not.toContain('from "@semantic-context/app-services"');
    expect(source).not.toContain('from "@semantic-context/control-model"');
  });

});

function preparedRepository() {
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-reconciliation-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  writeKindFile(root, "goal", [handoffGoal()]);
  const path = "src/local-patch.ts";
  writeFileSync(
    join(root, path),
    "export function localPatchValue(): number {\n  return 1;\n}\n",
    "utf8",
  );
  const change = newChangeContract({
    id: "change.cli-task-envelope",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-07-23T18:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.cli-issue-27",
    rawTask: "Adjust capacity behavior.",
    mode: "bugfix",
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
    createdAt: "2026-07-23T17:00:00.000Z",
  };
  const store = openStore(root);
  const nodes = store.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === path
  );
  must(nodes[0]);
  store.saveTaskFrame(frame);
  store.close();

  const coordinateIds = nodes.map((node) => `repo:${node.id}` as const).sort();
  const plannerInputs = {
    explicitDiscoveries: coordinateIds.map((coordinateId) => ({
      coordinateId,
      repositoryPath: path,
      evidenceId: `discovery:cli-test:${coordinateId}`,
      evidenceProvenance: "test" as const,
      scope: { kind: "file" as const, path },
    })),
    rollbackDescription: "Restore the committed implementation.",
    repositoryEditExpectations: [{
      schemaVersion: 1 as const,
      editId: "edit.capacity",
      kind: "modify" as const,
      required: true,
      path,
      coordinateIds,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    }],
    testReferences: ["test/capacity.test.ts"],
  };
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    ...plannerInputs,
  };
  return {
    root,
    path,
    taskFrameId: frame.id,
    changeId: change.id,
    plannerInputs,
    command,
  };
}

function handoffExpectation() {
  return {
    schemaVersion: 1 as const,
    expectationId: "expectation.control-handoff",
    kind: "behavior" as const,
    level: 2 as const,
    required: true,
    subjectId: "goal.control-handoff",
    statement: "Control handoff state remains reproducible.",
    acceptanceEvidenceIds: [],
  };
}

function handoffGoal() {
  return {
    id: "goal.control-handoff",
    kind: "goal" as const,
    statement: "Control handoff state remains reproducible.",
    status: "declared" as const,
    provenance: "author" as const,
    sourceRefs: [],
    repositoryLinks: [],
    relations: [],
    tags: [],
    appliesAtLevel: 2 as const,
  };
}

function temporaryJson(name: string, value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "semctx-cli-reconciliation-input-"));
  roots.push(directory);
  const file = join(directory, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
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

function runCli(
  root: string,
  argv: readonly string[],
): { code: number; out: string; err: string } {
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
