import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AgentLifecycleCheckpointRequestV1 } from "@semantic-context/control-model";
import { isSemctxError } from "@semantic-context/core";
import {
  configPath,
  dbPath,
  initWorkspace,
  openStore,
} from "@semantic-context/repository-store";
import * as appServices from "../src";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-agent-lifecycle-"));
  roots.push(root);
  writeFileSync(join(root, "source.ts"), "export const untouched = true;\n", "utf8");
  return root;
}

function request(
  overrides: Partial<AgentLifecycleCheckpointRequestV1> = {},
): AgentLifecycleCheckpointRequestV1 {
  return {
    schemaVersion: 1,
    checkpoint: "after_repository_edits",
    profile: "implementation",
    requiredAltitude: 2,
    recordedStageIds: [],
    priorTouchedCoordinateIds: [],
    newlyObservedTouchedCoordinateIds: [],
    ...overrides,
  };
}

function lifecycleService() {
  const service = (
    appServices as typeof appServices & {
      controlAgentLifecycleCheckpoint?: (
        root: string,
        request: AgentLifecycleCheckpointRequestV1,
      ) => ReturnType<typeof import("@semantic-context/control-model").evaluateAgentLifecycleCheckpointV1>;
    }
  ).controlAgentLifecycleCheckpoint;
  expect(service).toBeFunction();
  return service!;
}

function makeReady(root: string): void {
  initWorkspace(root);
  const store = openStore(root);
  store.saveGraph({
    nodes: [{
      id: "mod:source.ts",
      kind: "module",
      name: "source.ts",
      filePath: "source.ts",
      evidence: [{ filePath: "source.ts", sourceKind: "code" }],
      tags: [],
      metadata: {},
    }],
    edges: [],
  }, []);
  store.close();
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const path of walk(root)) {
    const key = relative(root, path).replaceAll("\\", "/");
    const stat = statSync(path);
    snapshot[key] = stat.isDirectory()
      ? "directory"
      : createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return snapshot;
}

function walk(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(path));
  }
  return paths.sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlAgentLifecycleCheckpoint", () => {
  it("exports the repository-bound lifecycle query", () => {
    expect(lifecycleService()).toBeFunction();
  });

  it("requires a real absolute directory", () => {
    const service = lifecycleService();
    const root = temporaryRoot();
    const file = join(root, "source.ts");
    const absent = join(root, "absent");

    expect(isAbsolute(root)).toBe(true);
    expect(() => service("relative-root", request())).toThrow("absolute");
    expect(() => service(absent, request())).toThrow();
    expect(() => service(file, request())).toThrow("directory");
  });

  it("returns a true no-op for a repository without Semctx markers", () => {
    const report = lifecycleService()(temporaryRoot(), request({
      checkpoint: "before_completion",
      recordedStageIds: ["reconcile_diff"],
      priorTouchedCoordinateIds: ["repo:prior"],
      newlyObservedTouchedCoordinateIds: ["semantic:new"],
    }));

    expect(report.repositoryState).toBe("non_semctx");
    expect(report.applicability).toBe("not_applicable");
    expect(report.stagePresenceVerdict).toBe("NO_OP");
    expect(report.reasonCodes).toEqual(["NON_SEMCTX_REPOSITORY"]);
    expect(report.requiredStageIds).toEqual([]);
    expect(report.recordedStageIds).toEqual([]);
    expect(report.missingStageIds).toEqual([]);
    expect(report.accumulatedTouchedCoordinateIds).toEqual([]);
  });

  it("keeps configuration-only and semantic-directory-only repositories unready", () => {
    const configOnly = temporaryRoot();
    initWorkspace(configOnly);
    const semanticOnly = temporaryRoot();
    mkdirSync(join(semanticOnly, ".semctx", "semantic"), { recursive: true });

    expect(lifecycleService()(configOnly, request()).repositoryState).toBe("semctx_unready");
    expect(lifecycleService()(semanticOnly, request()).repositoryState).toBe("semctx_unready");
  });

  it("derives the complete applicability boundary from repository readiness", () => {
    const nonSemctx = temporaryRoot();
    const unready = temporaryRoot();
    initWorkspace(unready);
    const ready = temporaryRoot();
    makeReady(ready);
    const service = lifecycleService();

    const cases = [
      {
        root: nonSemctx,
        input: request({ checkpoint: "before_implementation_write", requiredAltitude: 2 }),
        expected: ["non_semctx", "not_applicable", "NO_OP", ["NON_SEMCTX_REPOSITORY"]],
      },
      {
        root: unready,
        input: request({ checkpoint: "before_implementation_write", requiredAltitude: 1 }),
        expected: [
          "semctx_unready",
          "not_applicable",
          "NO_OP",
          ["BELOW_L2_CHECKPOINT_THRESHOLD", "SEMCTX_REPOSITORY_UNREADY"],
        ],
      },
      {
        root: unready,
        input: request({ checkpoint: "before_implementation_write", requiredAltitude: 2 }),
        expected: [
          "semctx_unready",
          "eligible",
          "INCOMPLETE",
          ["SEMCTX_REPOSITORY_UNREADY", "REQUIRED_STAGE_NOT_RECORDED"],
        ],
      },
      {
        root: ready,
        input: request({ checkpoint: "before_implementation_write", requiredAltitude: 1 }),
        expected: ["semctx_ready", "not_applicable", "NO_OP", ["BELOW_L2_CHECKPOINT_THRESHOLD"]],
      },
      {
        root: ready,
        input: request({ checkpoint: "before_completion" }),
        expected: ["semctx_ready", "eligible", "INCOMPLETE", ["REQUIRED_STAGE_NOT_RECORDED"]],
      },
      {
        root: ready,
        input: request({
          checkpoint: "before_completion",
          recordedStageIds: ["change_verify", "reconcile_diff", "verify_change"],
        }),
        expected: ["semctx_ready", "eligible", "RECORDED", []],
      },
    ] as const;

    for (const item of cases) {
      const report = service(item.root, item.input);
      const actual = [
        report.repositoryState,
        report.applicability,
        report.stagePresenceVerdict,
        report.reasonCodes,
      ] as const;
      expect(actual).toEqual(item.expected);
    }
  });

  it("validates present configuration and propagates invalid config", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, ".semctx"), { recursive: true });
    writeFileSync(configPath(root), "{not-json", "utf8");

    expect(() => lifecycleService()(root, request())).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("propagates active-WAL store failures instead of converting them to unready", () => {
    const root = temporaryRoot();
    makeReady(root);
    writeFileSync(`${dbPath(root)}-wal`, "active", "utf8");

    try {
      lifecycleService()(root, request());
      throw new Error("expected lifecycle checkpoint to fail");
    } catch (error) {
      expect(isSemctxError(error)).toBe(true);
      if (isSemctxError(error)) expect(error.code).toBe("STORE_ERROR");
    }
  });

  it("folds coordinates deterministically and leaves repository bytes unchanged", () => {
    const root = temporaryRoot();
    makeReady(root);
    const before = treeSnapshot(root);
    const input = request({
      priorTouchedCoordinateIds: ["repo:z", "repo:a", "repo:z"],
      newlyObservedTouchedCoordinateIds: ["semantic:b", "repo:a"],
    });

    const first = lifecycleService()(root, input);
    const second = lifecycleService()(root, {
      ...input,
      priorTouchedCoordinateIds: [...input.priorTouchedCoordinateIds].reverse(),
      newlyObservedTouchedCoordinateIds: [...input.newlyObservedTouchedCoordinateIds].reverse(),
    });

    expect(first.accumulatedTouchedCoordinateIds).toEqual([
      "repo:a",
      "repo:z",
      "semantic:b",
    ]);
    expect(second).toEqual(first);
    expect(first.accumulationSemantics).toBe("stateless_caller_reinjected_unbound");
    expect(treeSnapshot(root)).toEqual(before);
    expect(existsSync(`${dbPath(root)}-wal`)).toBe(false);
    expect(existsSync(`${dbPath(root)}-shm`)).toBe(false);
  });

  it("reads only configuration and repository metadata, never repository source content", () => {
    const root = temporaryRoot();
    makeReady(root);
    const canonicalRoot = realpathSync.native(root);
    const source = join(canonicalRoot, "source.ts");
    const readSpy = spyOn(fs, "readFileSync");

    try {
      lifecycleService()(root, request());
      const readPaths = readSpy.mock.calls.map(([path]) => String(path));
      expect(readPaths).toContain(configPath(canonicalRoot));
      expect(readPaths).not.toContain(source);
    } finally {
      readSpy.mockRestore();
    }
  });
});
