import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepositoryStore } from "@semantic-context/repository-store";
import type { Claim, EvidenceRecord, RepositoryGraph } from "@semantic-context/core";

/**
 * `SqliteRepositoryStore.replaceIndex` wraps graph, claims, counts and metadata in one SQLite
 * transaction. These tests prove the transaction boundary against a genuine abrupt OS termination
 * of the owning process, not a synchronous throw or a graceful exit: a real child is killed while
 * it is provably still inside the open transaction (pre-commit), and — as a control — again only
 * after the transaction has already returned (post-commit).
 */

const REPO_ROOT = process.cwd();
const CRASH_TIMEOUT_MS = 30_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OLD_GRAPH: RepositoryGraph = {
  nodes: [
    { id: "mod:old.ts", kind: "module", name: "old.ts", filePath: "old.ts", evidence: [], tags: [], metadata: {} },
  ],
  edges: [],
};
const OLD_EVIDENCE: EvidenceRecord[] = [
  { id: "ev:code:old.ts:1:0", filePath: "old.ts", startLine: 1, sourceKind: "code" },
];
const OLD_CLAIMS: Claim[] = [
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
const OLD_INDEXED_AT = "2026-09-01T00:00:00.000Z";

const NEW_GRAPH: RepositoryGraph = {
  nodes: [
    { id: "mod:new.ts", kind: "module", name: "new.ts", filePath: "new.ts", evidence: [], tags: [], metadata: {} },
    { id: "sym:new", kind: "function", name: "newFn", filePath: "new.ts", evidence: [], tags: [], metadata: {} },
  ],
  edges: [{ id: "edge:new", kind: "declares", from: "mod:new.ts", to: "sym:new", evidence: [], metadata: {} }],
};
const NEW_EVIDENCE: EvidenceRecord[] = [
  { id: "ev:code:new.ts:1:0", filePath: "new.ts", startLine: 1, sourceKind: "code" },
];
const NEW_CLAIMS: Claim[] = [
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
const NEW_INDEXED_AT = "2026-09-01T01:00:00.000Z";

function crashDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "semctx-store-crash-"));
  dirs.push(dir);
  return join(dir, "test.db");
}

function seedOldSnapshot(dbPath: string): void {
  const store = SqliteRepositoryStore.open(dbPath);
  store.replaceIndex({
    graph: OLD_GRAPH,
    evidence: OLD_EVIDENCE,
    claims: OLD_CLAIMS,
    metadata: { indexed_at: OLD_INDEXED_AT, marker: "old" },
  });
  store.close();
}

/**
 * The blocking key is read first: `Object.entries()` evaluates every own-enumerable getter of
 * `metadata` eagerly, before `replaceIndex`'s loop writes any of them, so the child blocks exactly
 * after graph/claims/node_count/edge_count are applied to the open transaction and before any
 * `metadata` key — including `indexed_at` — is written. It never claims that a later, syntactically
 * separate metadata-loop rollback (already covered by the transactional-rollback trigger test) is
 * the same seam.
 */
function preCommitKillChildSource(): string {
  return `
    import { deepStrictEqual } from "node:assert/strict";
    import { writeSync } from "node:fs";
    import { SqliteRepositoryStore } from "./packages/repository-store/src/store.ts";
    const dbPath = process.argv[1];
    const newGraph = JSON.parse(process.argv[2]);
    const newEvidence = JSON.parse(process.argv[3]);
    const newClaims = JSON.parse(process.argv[4]);
    const store = SqliteRepositoryStore.open(dbPath);
    let signaled = false;
    const metadata = {};
    Object.defineProperty(metadata, "signal", {
      enumerable: true,
      get() {
        if (signaled) return "already-signaled";
        signaled = true;
        const graph = store.loadGraph();
        const claims = store.loadClaims();
        deepStrictEqual(graph, newGraph);
        deepStrictEqual(store.loadEvidence(), newEvidence);
        deepStrictEqual(claims, newClaims);
        deepStrictEqual(store.getMeta("indexed_at"), "${OLD_INDEXED_AT}");
        deepStrictEqual(store.getMeta("marker"), "old");
        deepStrictEqual(store.getMeta("newOnly"), undefined);
        const nodeCount = store.getMeta("node_count");
        const edgeCount = store.getMeta("edge_count");
        if (
          graph.nodes.length !== newGraph.nodes.length
          || claims.length !== newClaims.length
          || nodeCount !== String(newGraph.nodes.length)
          || edgeCount !== String(newGraph.edges.length)
        ) {
          throw new Error("uncommitted NEW state was not visible on the child's own store");
        }
        writeSync(1, "SIGNAL:IN_TRANSACTION\\n");
        while (true) {
          Bun.sleepSync(50);
        }
      },
    });
    Object.assign(metadata, { indexed_at: "${NEW_INDEXED_AT}", marker: "new", newOnly: "present" });
    store.replaceIndex({ graph: newGraph, evidence: newEvidence, claims: newClaims, metadata });
  `;
}

function postCommitKillChildSource(): string {
  return `
    import { writeSync } from "node:fs";
    import { SqliteRepositoryStore } from "./packages/repository-store/src/store.ts";
    const dbPath = process.argv[1];
    const newGraph = JSON.parse(process.argv[2]);
    const newEvidence = JSON.parse(process.argv[3]);
    const newClaims = JSON.parse(process.argv[4]);
    const store = SqliteRepositoryStore.open(dbPath);
    store.replaceIndex({
      graph: newGraph,
      evidence: newEvidence,
      claims: newClaims,
      metadata: { indexed_at: "${NEW_INDEXED_AT}", marker: "new", newOnly: "present" },
    });
    writeSync(1, "SIGNAL:COMMITTED\\n");
    while (true) {
      Bun.sleepSync(50);
    }
  `;
}

async function waitForStdoutMarker(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!buffer.includes(marker)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for marker ${marker}; observed: ${buffer}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}: ${buffer}`)), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) throw new Error(`child stdout closed before marker ${marker}; observed: ${buffer}`);
      buffer += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function spawnCrashChild(source: string, dbPath: string) {
  return Bun.spawn(
    [process.execPath, "-e", source, dbPath, JSON.stringify(NEW_GRAPH), JSON.stringify(NEW_EVIDENCE), JSON.stringify(NEW_CLAIMS)],
    { cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  );
}

describe("abrupt OS termination during SQLite index replacement", () => {
  it(
    "preserves the entire old snapshot when the owned child is killed mid-transaction, before commit",
    async () => {
      const dbPath = crashDbPath();
      seedOldSnapshot(dbPath);
      const child = spawnCrashChild(preCommitKillChildSource(), dbPath);

      try {
        await waitForStdoutMarker(child.stdout, "SIGNAL:IN_TRANSACTION", CRASH_TIMEOUT_MS);
        expect(child.exitCode).toBeNull();

        child.kill("SIGKILL");
        await child.exited;

        const store = SqliteRepositoryStore.open(dbPath);
        try {
          expect(store.loadGraph()).toEqual(OLD_GRAPH);
          expect(store.loadEvidence()).toEqual(OLD_EVIDENCE);
          expect(store.loadClaims()).toEqual(OLD_CLAIMS);
          expect(store.getMeta("marker")).toBe("old");
          expect(store.getMeta("indexed_at")).toBe(OLD_INDEXED_AT);
          expect(store.getMeta("node_count")).toBe(String(OLD_GRAPH.nodes.length));
          expect(store.getMeta("edge_count")).toBe(String(OLD_GRAPH.edges.length));
          expect(store.getMeta("newOnly")).toBeUndefined();
        } finally {
          store.close();
        }
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
    CRASH_TIMEOUT_MS + 10_000,
  );

  it(
    "preserves the entire new snapshot when the owned child is killed only after the transaction commits",
    async () => {
      const dbPath = crashDbPath();
      seedOldSnapshot(dbPath);
      const child = spawnCrashChild(postCommitKillChildSource(), dbPath);

      try {
        await waitForStdoutMarker(child.stdout, "SIGNAL:COMMITTED", CRASH_TIMEOUT_MS);
        expect(child.exitCode).toBeNull();

        child.kill("SIGKILL");
        await child.exited;

        const store = SqliteRepositoryStore.open(dbPath);
        try {
          expect(store.loadGraph()).toEqual(NEW_GRAPH);
          expect(store.loadEvidence()).toEqual(NEW_EVIDENCE);
          expect(store.loadClaims()).toEqual(NEW_CLAIMS);
          expect(store.getMeta("marker")).toBe("new");
          expect(store.getMeta("indexed_at")).toBe(NEW_INDEXED_AT);
          expect(store.getMeta("newOnly")).toBe("present");
          expect(store.getMeta("node_count")).toBe(String(NEW_GRAPH.nodes.length));
          expect(store.getMeta("edge_count")).toBe(String(NEW_GRAPH.edges.length));
        } finally {
          store.close();
        }
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
    CRASH_TIMEOUT_MS + 10_000,
  );
});
