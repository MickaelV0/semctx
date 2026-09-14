import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositoryStore } from "@semantic-context/repository-store";
import type { RepositoryGraph, EvidenceRecord, Claim, TaskFrame } from "@semantic-context/core";
import { must } from "@semantic-context/test-fixtures";

const dir = mkdtempSync(join(tmpdir(), "semctx-store-"));
const store = SqliteRepositoryStore.open(join(dir, "test.db"));

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const graph: RepositoryGraph = {
  nodes: [
    { id: "mod:a.ts", kind: "module", name: "a.ts", filePath: "a.ts", evidence: [{ filePath: "a.ts", sourceKind: "code" }], tags: [], metadata: {} },
    { id: "sym:function:a.ts:foo:1", kind: "function", name: "foo", filePath: "a.ts", exported: true, evidence: [{ filePath: "a.ts", startLine: 1, sourceKind: "code" }], tags: ["x"], metadata: { exported: true } },
  ],
  edges: [{ id: "edge:declares:1", kind: "declares", from: "mod:a.ts", to: "sym:function:a.ts:foo:1", evidence: [], metadata: {} }],
};

const evidence: EvidenceRecord[] = [
  { id: "ev:code:a.ts:1:0", filePath: "a.ts", startLine: 1, sourceKind: "code" },
];

describe("SqliteRepositoryStore", () => {
  it("round-trips a graph", () => {
    store.saveGraph(graph, evidence);
    const loaded = store.loadGraph();
    expect(loaded.nodes.length).toBe(2);
    expect(loaded.edges.length).toBe(1);
    const foo = must(loaded.nodes.find((n) => n.id === "sym:function:a.ts:foo:1"));
    expect(foo.exported).toBe(true);
    expect(foo.tags).toEqual(["x"]);
    expect(foo.metadata["exported"]).toBe(true);
    expect(store.isIndexed()).toBe(true);
  });

  it("round-trips evidence records", () => {
    const loaded = store.loadEvidence();
    expect(loaded.length).toBe(1);
    expect(must(loaded[0]).id).toBe("ev:code:a.ts:1:0");
  });

  it("replaces claims idempotently", () => {
    const claims: Claim[] = [
      {
        id: "claim:invariant:x-1",
        kind: "invariant",
        statement: "x holds",
        subjectNodeIds: ["sym:function:a.ts:foo:1"],
        evidenceIds: ["ev:code:a.ts:1:0"],
        authority: 0.85,
        freshness: 0.85,
        confidence: 0.8,
        verificationStatus: "tested",
        tags: ["invariant"],
      },
    ];
    store.replaceClaims(claims);
    expect(store.loadClaims().length).toBe(1);
    store.replaceClaims(claims); // idempotent, no duplication
    expect(store.loadClaims().length).toBe(1);
    expect(must(store.loadClaims()[0]).verificationStatus).toBe("tested");
  });

  it("replaces the complete index snapshot and metadata together", () => {
    const claims: Claim[] = [{
      id: "claim:behavior:snapshot",
      kind: "behavior",
      statement: "snapshot is atomic",
      subjectNodeIds: ["mod:a.ts"],
      evidenceIds: [],
      authority: 1,
      freshness: 1,
      confidence: 1,
      verificationStatus: "tested",
      tags: [],
    }];
    store.replaceIndex({ graph, evidence, claims, metadata: { indexed_at: "2026-07-21T00:00:00.000Z", seal: "bound" } });
    expect(store.loadGraph()).toEqual(graph);
    expect(store.loadEvidence()).toEqual(evidence);
    expect(store.loadClaims()).toEqual(claims);
    expect(store.getMeta("seal")).toBe("bound");
  });

  it("round-trips a task frame", () => {
    const tf: TaskFrame = {
      id: "task:deadbeef",
      rawTask: "do the thing",
      mode: "bugfix",
      capabilities: ["cap-a"],
      observedBehavior: [],
      expectedBehavior: [],
      boundedContexts: [],
      hardInvariants: [],
      softConstraints: [],
      acceptanceEvidence: [],
      nonGoals: [],
      riskSurfaces: [],
      hypotheses: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.saveTaskFrame(tf);
    expect(must(store.getTaskFrame("task:deadbeef")).rawTask).toBe("do the thing");
    expect(store.listTaskFrames().length).toBe(1);
  });

  it("stores and reads meta", () => {
    store.setMeta("k", "v");
    expect(store.getMeta("k")).toBe("v");
    expect(store.getMeta("absent")).toBeUndefined();
  });
});

describe("SqliteRepositoryStore replaceIndex transactional rollback", () => {
  it("keeps the prior complete snapshot when a later metadata write throws mid-transaction", () => {
    const localDir = mkdtempSync(join(tmpdir(), "semctx-store-rollback-"));
    const localPath = join(localDir, "test.db");
    let localStore = SqliteRepositoryStore.open(localPath);
    try {
      const oldGraph: RepositoryGraph = {
        nodes: [
          { id: "mod:old.ts", kind: "module", name: "old.ts", filePath: "old.ts", evidence: [], tags: [], metadata: {} },
        ],
        edges: [],
      };
      const oldEvidence: EvidenceRecord[] = [
        { id: "ev:code:old.ts:1:0", filePath: "old.ts", startLine: 1, sourceKind: "code" },
      ];
      const oldClaims: Claim[] = [
        {
          id: "claim:behavior:old",
          kind: "behavior",
          statement: "old snapshot",
          subjectNodeIds: ["mod:old.ts"],
          evidenceIds: ["ev:code:old.ts:1:0"],
          authority: 1,
          freshness: 1,
          confidence: 1,
          verificationStatus: "tested",
          tags: [],
        },
      ];
      localStore.replaceIndex({
        graph: oldGraph,
        evidence: oldEvidence,
        claims: oldClaims,
        metadata: { indexed_at: "2026-07-21T00:00:00.000Z", marker: "old" },
      });

      const newGraph: RepositoryGraph = {
        nodes: [
          { id: "mod:new.ts", kind: "module", name: "new.ts", filePath: "new.ts", evidence: [], tags: [], metadata: {} },
          { id: "sym:new", kind: "function", name: "newFn", filePath: "new.ts", evidence: [], tags: [], metadata: {} },
        ],
        edges: [{ id: "edge:new", kind: "declares", from: "mod:new.ts", to: "sym:new", evidence: [], metadata: {} }],
      };
      const newEvidence: EvidenceRecord[] = [
        { id: "ev:code:new.ts:1:0", filePath: "new.ts", startLine: 1, sourceKind: "code" },
      ];
      const newClaims: Claim[] = [
        {
          id: "claim:behavior:new",
          kind: "behavior",
          statement: "new snapshot",
          subjectNodeIds: ["mod:new.ts"],
          evidenceIds: ["ev:code:new.ts:1:0"],
          authority: 1,
          freshness: 1,
          confidence: 1,
          verificationStatus: "tested",
          tags: [],
        },
      ];
      const faultConnection = new Database(localPath);
      try {
        faultConnection.exec(`
          CREATE TRIGGER fail_late_metadata BEFORE INSERT ON meta
          WHEN NEW.key = 'poison'
          BEGIN
            SELECT CASE WHEN
              (SELECT value FROM meta WHERE key = 'newOnly') = 'present' AND
              (SELECT value FROM meta WHERE key = 'indexed_at') = '2026-07-21T01:00:00.000Z' AND
              (SELECT value FROM meta WHERE key = 'marker') = 'new' AND
              (SELECT value FROM meta WHERE key = 'node_count') = '2' AND
              (SELECT value FROM meta WHERE key = 'edge_count') = '1'
            THEN RAISE(ABORT, 'simulated replace interruption')
            ELSE RAISE(ABORT, 'fault reached before expected writes') END;
          END;
        `);
      } finally {
        faultConnection.close();
      }

      expect(() => localStore.replaceIndex({
        graph: newGraph,
        evidence: newEvidence,
        claims: newClaims,
        metadata: {
          indexed_at: "2026-07-21T01:00:00.000Z",
          marker: "new",
          newOnly: "present",
          poison: "fail after the preceding writes",
        },
      })).toThrow("simulated replace interruption");

      localStore.close();
      localStore = SqliteRepositoryStore.open(localPath);

      expect(localStore.loadGraph()).toEqual(oldGraph);
      expect(localStore.loadEvidence()).toEqual(oldEvidence);
      expect(localStore.loadClaims()).toEqual(oldClaims);
      expect(localStore.getMeta("marker")).toBe("old");
      expect(localStore.getMeta("indexed_at")).toBe("2026-07-21T00:00:00.000Z");
      expect(localStore.getMeta("node_count")).toBe("1");
      expect(localStore.getMeta("edge_count")).toBe("0");
      expect(localStore.getMeta("newOnly")).toBeUndefined();
    } finally {
      localStore.close();
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});
