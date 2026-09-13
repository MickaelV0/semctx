import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGlobSelectionConfig, type Claim, type EvidenceRecord, type RepositoryGraph, type SemctxConfigV2 } from "@semantic-context/core";
import { dbPath, initWorkspace, openStore } from "@semantic-context/repository-store";
import { canonicalRepositoryRoot, controlRepositoryIdentity, fingerprintRepositoryFacts, indexRepository } from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, parseIndexedControlSnapshot, type IndexedControlSnapshot } from "../src/freshness";

/**
 * Two real Bun child processes each index a distinct linked worktree of the same Git repository.
 * Both must be observably in flight — blocked inside the existing indexing capture barrier — before
 * either is allowed to finish, so the overlap is a witnessed rendezvous rather than two completed
 * sequential calls dressed up with `Promise.all`.
 */

const REPO_ROOT = process.cwd();
const CHILD_TIMEOUT_MS = 30_000;
const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function gitOutput(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", message);
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function v2Config(root: string): SemctxConfigV2 {
  return { ...createGlobSelectionConfig(root), include: ["src/**/*.ts"] };
}

function ignoreSemctx(root: string): void {
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sortedGraph(graph: RepositoryGraph): RepositoryGraph {
  return {
    nodes: [...graph.nodes].sort(byId),
    edges: [...graph.edges].sort(byId),
  };
}

interface ReturnedIndex {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  repositoryGraphHash: string;
}

interface PersistedSnapshot {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  indexedAt: string | undefined;
  controlSnapshot: IndexedControlSnapshot | null;
  nodeCount: string | undefined;
  edgeCount: string | undefined;
  indexedCommit: string | undefined;
  indexedRepositoryGraphHash: string | undefined;
}

function readPersisted(root: string): PersistedSnapshot {
  const store = openStore(root);
  try {
    return {
      graph: store.loadGraph(),
      evidence: store.loadEvidence(),
      claims: store.loadClaims(),
      indexedAt: store.getMeta("indexed_at"),
      controlSnapshot: parseIndexedControlSnapshot(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)),
      nodeCount: store.getMeta("node_count"),
      edgeCount: store.getMeta("edge_count"),
      indexedCommit: store.getMeta("indexed_commit"),
      indexedRepositoryGraphHash: store.getMeta("indexed_repository_graph_hash"),
    };
  } finally {
    store.close();
  }
}

/**
 * Each child installs the existing one-shot capture barrier on its own module instance (it is
 * process-local) and blocks inside it until the parent releases it, well after the analysis pass
 * but before the second TOCTOU comparison and SQLite replacement — a real, deterministic point
 * inside `indexRepository`, not a sleep timed against wall-clock guesses.
 */
function childSource(): string {
  return `
    import { existsSync, writeFileSync } from "node:fs";
    import { indexRepository, __setIndexRepositoryCaptureBarrierForTesting } from "./packages/app-services/src/indexing.ts";
    const root = process.argv[1];
    const indexedAt = process.argv[2];
    const markerPath = process.argv[3];
    const releasePath = process.argv[4];
    __setIndexRepositoryCaptureBarrierForTesting(() => {
      writeFileSync(markerPath, "reached", "utf8");
      const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
      while (!existsSync(releasePath)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for release");
        Bun.sleepSync(20);
      }
    });
    const result = indexRepository(root, indexedAt);
    console.log(JSON.stringify({
      graph: result.analysis.graph,
      evidence: result.analysis.evidence,
      claims: result.claims,
      repositoryGraphHash: result.freshnessSeal.repositoryGraphHash,
    }));
  `;
}

function launchIndexer(root: string, indexedAt: string, markerPath: string, releasePath: string) {
  return Bun.spawn(
    [process.execPath, "-e", childSource(), root, indexedAt, markerPath, releasePath],
    { cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
}

describe("cross-process indexing overlap across linked worktrees", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it(
    "indexes two linked worktrees concurrently with a witnessed in-flight overlap and no cross-branch contamination",
    async () => {
      const container = tempRoot("semctx-concurrency-container-");
      const mainRoot = join(container, "main");
      const linkedRoot = join(container, "linked");
      mkdirSync(mainRoot, { recursive: true });

      ignoreSemctx(mainRoot);
      git(mainRoot, "init", "-q", "-b", "main");
      commitAll(mainRoot, "initial");
      writeFile(mainRoot, "src/a.ts", ["export function mainOnly(): number {", "  return 1;", "}", ""].join("\n"));
      commitAll(mainRoot, "add main content");

      git(mainRoot, "worktree", "add", "-q", "-b", "linked-branch", linkedRoot);
      rmSync(join(linkedRoot, "src", "a.ts"));
      writeFile(linkedRoot, "src/b.ts", ["export function linkedOnly(): number {", "  return 2;", "}", ""].join("\n"));
      commitAll(linkedRoot, "swap linked content");

      initWorkspace(mainRoot, v2Config(mainRoot));
      initWorkspace(linkedRoot, v2Config(linkedRoot));
      expect(existsSync(dbPath(mainRoot))).toBe(false);
      expect(existsSync(dbPath(linkedRoot))).toBe(false);

      indexRepository(mainRoot, "2026-09-01T09:00:00.000Z");
      indexRepository(linkedRoot, "2026-09-01T09:00:05.000Z");
      const priorMain = readPersisted(mainRoot);
      const priorLinked = readPersisted(linkedRoot);

      const coordination = tempRoot("semctx-concurrency-coordination-");
      const mainMarker = join(coordination, "main.reached");
      const linkedMarker = join(coordination, "linked.reached");
      const mainRelease = join(coordination, "main.release");
      const linkedRelease = join(coordination, "linked.release");

      const mainIndexedAt = "2026-09-01T10:00:00.000Z";
      const linkedIndexedAt = "2026-09-01T10:00:05.000Z";

      const mainChild = launchIndexer(mainRoot, mainIndexedAt, mainMarker, mainRelease);
      const linkedChild = launchIndexer(linkedRoot, linkedIndexedAt, linkedMarker, linkedRelease);
      // Drain both pipes while children run, including their failure paths.
      const mainOutput = new Response(mainChild.stdout).text();
      const linkedOutput = new Response(linkedChild.stdout).text();
      const mainErrors = new Response(mainChild.stderr).text();
      const linkedErrors = new Response(linkedChild.stderr).text();
      const watchdog = setTimeout(() => {
        if (mainChild.exitCode === null) mainChild.kill("SIGKILL");
        if (linkedChild.exitCode === null) linkedChild.kill("SIGKILL");
      }, CHILD_TIMEOUT_MS);

      let mainExited = false;
      let linkedExited = false;
      void mainChild.exited.then(() => { mainExited = true; });
      void linkedChild.exited.then(() => { linkedExited = true; });

      try {
        const deadline = Date.now() + CHILD_TIMEOUT_MS;
        while (!existsSync(mainMarker) || !existsSync(linkedMarker)) {
          if (mainExited || linkedExited) {
            throw new Error("a child exited before reaching the indexing barrier");
          }
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for both children to reach the indexing barrier");
          }
          await Bun.sleep(20);
        }

        // The witnessed rendezvous: both children are provably still in flight at the moment both
        // reached the barrier, because neither can pass it until the release files below exist.
        expect(mainExited).toBe(false);
        expect(linkedExited).toBe(false);
        expect(readPersisted(mainRoot)).toEqual(priorMain);
        expect(readPersisted(linkedRoot)).toEqual(priorLinked);

        writeFileSync(mainRelease, "go", "utf8");
        writeFileSync(linkedRelease, "go", "utf8");

        const [mainExit, linkedExit] = await Promise.all([mainChild.exited, linkedChild.exited]);
        if (mainExit !== 0 || linkedExit !== 0) {
          throw new Error(`index children failed: ${await mainErrors}\n${await linkedErrors}`);
        }
      } finally {
        clearTimeout(watchdog);
        if (mainChild.exitCode === null) mainChild.kill("SIGKILL");
        if (linkedChild.exitCode === null) linkedChild.kill("SIGKILL");
        await Promise.all([mainChild.exited, linkedChild.exited, mainOutput, linkedOutput, mainErrors, linkedErrors]);
      }

      const [mainStdout, linkedStdout] = await Promise.all([
        mainOutput,
        linkedOutput,
      ]);
      const mainReturned = JSON.parse(mainStdout) as ReturnedIndex;
      const linkedReturned = JSON.parse(linkedStdout) as ReturnedIndex;

      const mainPersisted = readPersisted(mainRoot);
      const linkedPersisted = readPersisted(linkedRoot);

      // Complete persisted facts match each child's own returned index — not merely a shared hash.
      expect(mainPersisted.graph).toEqual(sortedGraph(mainReturned.graph));
      expect(linkedPersisted.graph).toEqual(sortedGraph(linkedReturned.graph));
      expect(mainPersisted.evidence).toEqual([...mainReturned.evidence].sort(byId));
      expect(linkedPersisted.evidence).toEqual([...linkedReturned.evidence].sort(byId));
      expect(mainPersisted.claims).toEqual([...mainReturned.claims].sort(byId));
      expect(linkedPersisted.claims).toEqual([...linkedReturned.claims].sort(byId));
      expect(mainPersisted.nodeCount).toBe(String(mainPersisted.graph.nodes.length));
      expect(linkedPersisted.nodeCount).toBe(String(linkedPersisted.graph.nodes.length));
      expect(mainPersisted.edgeCount).toBe(String(mainPersisted.graph.edges.length));
      expect(linkedPersisted.edgeCount).toBe(String(linkedPersisted.graph.edges.length));
      expect(mainPersisted.indexedRepositoryGraphHash).toBe(mainReturned.repositoryGraphHash);
      expect(linkedPersisted.indexedRepositoryGraphHash).toBe(linkedReturned.repositoryGraphHash);
      expect(mainPersisted.indexedCommit).toBe(gitOutput(mainRoot, "rev-parse", "HEAD"));
      expect(linkedPersisted.indexedCommit).toBe(gitOutput(linkedRoot, "rev-parse", "HEAD"));
      for (const [root, persisted, capturedAt] of [
        [mainRoot, mainPersisted, mainIndexedAt],
        [linkedRoot, linkedPersisted, linkedIndexedAt],
      ] as const) {
        const hash = fingerprintRepositoryFacts(persisted);
        expect(persisted.indexedRepositoryGraphHash).toBe(hash);
        expect(persisted.indexedAt).toBe(capturedAt);
        expect(persisted.controlSnapshot?.repositoryGraphHash).toBe(hash);
        expect(persisted.controlSnapshot?.repositoryRoot).toBe(canonicalRepositoryRoot(root));
        expect(persisted.controlSnapshot?.headCommit).toBe(persisted.indexedCommit);
      }

      // Distinct storage, deliberately shared repository identity.
      expect(dbPath(mainRoot)).not.toBe(dbPath(linkedRoot));
      expect(canonicalRepositoryRoot(mainRoot)).not.toBe(canonicalRepositoryRoot(linkedRoot));
      expect(controlRepositoryIdentity(mainRoot)).toBe(controlRepositoryIdentity(linkedRoot));

      // No cross-branch contamination in either direction.
      const mainNames = mainPersisted.graph.nodes.map((node) => node.name);
      const linkedNames = linkedPersisted.graph.nodes.map((node) => node.name);
      expect(mainNames).toContain("mainOnly");
      expect(mainNames).not.toContain("linkedOnly");
      expect(linkedNames).toContain("linkedOnly");
      expect(linkedNames).not.toContain("mainOnly");
      expect(mainPersisted.graph.nodes.some((node) => node.filePath === "src/b.ts")).toBe(false);
      expect(linkedPersisted.graph.nodes.some((node) => node.filePath === "src/a.ts")).toBe(false);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
