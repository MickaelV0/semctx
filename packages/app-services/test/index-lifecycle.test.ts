import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGlobSelectionConfig, type Claim, type EvidenceRecord, type RepositoryGraph, type RepositoryNode, type SemctxConfigV2 } from "@semantic-context/core";
import { dbPath, initWorkspace, openStore } from "@semantic-context/repository-store";
import { must } from "@semantic-context/test-fixtures";
import { indexRepository } from "../src/indexing";
import { canonicalRepositoryRoot, controlRepositoryIdentity, fingerprintRepositoryFacts } from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, parseIndexedControlSnapshot, type IndexedControlSnapshot } from "../src/freshness";

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function gitOutput(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
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

function writeCallFixture(root: string): void {
  writeFile(root, "src/a.ts", ["export function helper(): number {", "  return 1;", "}", ""].join("\n"));
  writeFile(root, "src/b.ts", [
    'import { helper } from "./a";',
    "",
    "export function caller(): number {",
    "  return helper();",
    "}",
    "",
  ].join("\n"));
}

function names(nodes: readonly RepositoryNode[]): string[] {
  return nodes.map((node) => node.name);
}

function callPairs(graph: RepositoryGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.kind === "calls")
    .map((edge) => `${byId.get(edge.from)?.name}->${byId.get(edge.to)?.name}`);
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** `store.loadGraph()` returns rows in `ORDER BY id`; the in-memory analysis result carries no such guarantee. */
function sortedGraph(graph: RepositoryGraph): RepositoryGraph {
  return {
    nodes: [...graph.nodes].sort(byId),
    edges: [...graph.edges].sort(byId),
  };
}

interface PersistedSnapshot {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  claims: Claim[];
  indexedAt: string | undefined;
  indexedCommit: string | undefined;
  indexedRepositoryGraphHash: string | undefined;
  nodeCount: string | undefined;
  edgeCount: string | undefined;
  controlSnapshot: IndexedControlSnapshot | null;
}

function readPersisted(root: string): PersistedSnapshot {
  const store = openStore(root);
  try {
    return {
      graph: store.loadGraph(),
      evidence: store.loadEvidence(),
      claims: store.loadClaims(),
      indexedAt: store.getMeta("indexed_at"),
      indexedCommit: store.getMeta("indexed_commit"),
      indexedRepositoryGraphHash: store.getMeta("indexed_repository_graph_hash"),
      nodeCount: store.getMeta("node_count"),
      edgeCount: store.getMeta("edge_count"),
      controlSnapshot: parseIndexedControlSnapshot(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)),
    };
  } finally {
    store.close();
  }
}

function expectCoherent(root: string, result: ReturnType<typeof indexRepository>): PersistedSnapshot {
  const persisted = readPersisted(root);
  expect(persisted.graph).toEqual(sortedGraph(result.analysis.graph));
  expect(persisted.evidence).toEqual([...result.analysis.evidence].sort(byId));
  expect(persisted.claims).toEqual([...result.claims].sort(byId));
  expect(persisted.nodeCount).toBe(String(persisted.graph.nodes.length));
  expect(persisted.edgeCount).toBe(String(persisted.graph.edges.length));
  const hash = fingerprintRepositoryFacts(persisted);
  const snapshot = must(persisted.controlSnapshot);
  expect(persisted.indexedRepositoryGraphHash).toBe(hash);
  expect(snapshot.repositoryGraphHash).toBe(hash);
  expect(result.freshnessSeal.repositoryGraphHash).toBe(hash);
  expect(snapshot.repositoryRoot).toBe(canonicalRepositoryRoot(root));
  const head = gitOutput(root, "rev-parse", "HEAD");
  expect(snapshot.headCommit).toBe(head);
  expect(persisted.indexedCommit).toBe(head);
  return persisted;
}

function expectSourceFacts(snapshot: PersistedSnapshot, functions: Record<string, string>): void {
  const files = Object.keys(functions).sort();
  expect([...new Set(snapshot.graph.nodes.map((node) => node.filePath).filter((path) => path?.startsWith("src/")))].sort()).toEqual(files);
  expect([...new Set(snapshot.evidence.map((record) => record.filePath).filter((path) => path.startsWith("src/")))].sort()).toEqual(files);
  expect(snapshot.graph.nodes.filter((node) => node.kind === "function").map((node) => `${node.filePath}:${node.name}`).sort())
    .toEqual(Object.entries(functions).map(([path, name]) => `${path}:${name}`).sort());
}

describe("index lifecycle — full rebuild characterization", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists a complete coherent snapshot from a cold repository", () => {
    const root = tempRoot("semctx-lifecycle-cold-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));

    expect(existsSync(dbPath(root))).toBe(false);

    const result = indexRepository(root, "2026-07-28T11:00:00.000Z");
    const persisted = expectCoherent(root, result);

    expect(existsSync(dbPath(root))).toBe(true);
    expectSourceFacts(persisted, { "src/a.ts": "helper", "src/b.ts": "caller" });
    expect(callPairs(persisted.graph)).toContain("caller->helper");

  });

  it("rebuilds an unchanged repository to identical facts while advancing capture time", () => {
    const root = tempRoot("semctx-lifecycle-stable-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));

    const first = indexRepository(root, "2026-07-28T11:00:00.000Z");
    const firstPersisted = expectCoherent(root, first);
    const second = indexRepository(root, "2026-07-28T11:05:00.000Z");
    const secondPersisted = expectCoherent(root, second);
    expectSourceFacts(secondPersisted, { "src/a.ts": "helper", "src/b.ts": "caller" });

    expect(secondPersisted.graph).toEqual(firstPersisted.graph);
    expect(secondPersisted.evidence).toEqual(firstPersisted.evidence);
    expect(secondPersisted.claims).toEqual(firstPersisted.claims);
    expect(secondPersisted.indexedRepositoryGraphHash).toBe(firstPersisted.indexedRepositoryGraphHash);
    expect(second.freshnessSeal.repositoryGraphHash).toBe(first.freshnessSeal.repositoryGraphHash);

    expect(secondPersisted.indexedAt).not.toBe(firstPersisted.indexedAt);
    expect(secondPersisted.controlSnapshot?.capturedAt).not.toBe(firstPersisted.controlSnapshot?.capturedAt);
    expect(secondPersisted.indexedAt).toBe("2026-07-28T11:05:00.000Z");
  });

  it("replaces a renamed exported symbol's facts after an uncommitted edit", () => {
    const root = tempRoot("semctx-lifecycle-edit-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));
    indexRepository(root, "2026-07-28T11:00:00.000Z");

    writeFile(root, "src/a.ts", ["export function helperRenamed(): number {", "  return 1;", "}", ""].join("\n"));
    writeFile(root, "src/b.ts", [
      'import { helperRenamed } from "./a";',
      "",
      "export function caller(): number {",
      "  return helperRenamed();",
      "}",
      "",
    ].join("\n"));

    const result = indexRepository(root, "2026-07-28T11:01:00.000Z");
    const persisted = expectCoherent(root, result);
    expectSourceFacts(persisted, { "src/a.ts": "helperRenamed", "src/b.ts": "caller" });

    expect(names(persisted.graph.nodes)).toContain("helperRenamed");
    expect(names(persisted.graph.nodes)).not.toContain("helper");
    expect(callPairs(persisted.graph)).toContain("caller->helperRenamed");
    expect(callPairs(persisted.graph)).not.toContain("caller->helper");
  });

  it("adds a new symbol's facts after an uncommitted addition", () => {
    const root = tempRoot("semctx-lifecycle-add-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));
    indexRepository(root, "2026-07-28T11:00:00.000Z");

    writeFile(root, "src/c.ts", ["export function extra(): number {", "  return 3;", "}", ""].join("\n"));

    const result = indexRepository(root, "2026-07-28T11:01:00.000Z");
    const persisted = expectCoherent(root, result);
    expectSourceFacts(persisted, { "src/a.ts": "helper", "src/b.ts": "caller", "src/c.ts": "extra" });

    expect(names(persisted.graph.nodes)).toContain("extra");
    expect(callPairs(persisted.graph)).toContain("caller->helper");
  });

  it("removes a deleted file's facts after an uncommitted deletion", () => {
    const root = tempRoot("semctx-lifecycle-delete-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));
    indexRepository(root, "2026-07-28T11:00:00.000Z");

    rmSync(join(root, "src", "b.ts"));

    const result = indexRepository(root, "2026-07-28T11:01:00.000Z");
    const persisted = expectCoherent(root, result);
    expectSourceFacts(persisted, { "src/a.ts": "helper" });

    expect(names(persisted.graph.nodes)).not.toContain("caller");
    expect(persisted.graph.nodes.some((node) => node.filePath === "src/b.ts")).toBe(false);
    expect(callPairs(persisted.graph)).not.toContain("caller->helper");
    expect(names(persisted.graph.nodes)).toContain("helper");
  });

  it("moves a file's facts to its new path after an uncommitted rename", () => {
    const root = tempRoot("semctx-lifecycle-rename-");
    writeCallFixture(root);
    ignoreSemctx(root);
    git(root, "init", "-q");
    commitAll(root, "fixture");
    initWorkspace(root, v2Config(root));
    indexRepository(root, "2026-07-28T11:00:00.000Z");

    const helperContents = readFileSync(join(root, "src", "a.ts"), "utf8");
    rmSync(join(root, "src", "a.ts"));
    writeFile(root, "src/moved.ts", helperContents);
    writeFile(root, "src/b.ts", [
      'import { helper } from "./moved";',
      "",
      "export function caller(): number {",
      "  return helper();",
      "}",
      "",
    ].join("\n"));

    const result = indexRepository(root, "2026-07-28T11:01:00.000Z");
    const persisted = expectCoherent(root, result);
    expectSourceFacts(persisted, { "src/moved.ts": "helper", "src/b.ts": "caller" });

    const helperNode = must(persisted.graph.nodes.find((node) => node.name === "helper"));
    expect(helperNode.filePath).toBe("src/moved.ts");
    expect(persisted.graph.nodes.some((node) => node.filePath === "src/a.ts")).toBe(false);
    expect(persisted.evidence.some((evidence) => evidence.filePath === "src/a.ts")).toBe(false);
    expect(callPairs(persisted.graph)).toContain("caller->helper");
  });

  it("replaces branch facts across a real checkout switch", () => {
    const root = tempRoot("semctx-lifecycle-branch-");
    ignoreSemctx(root);
    git(root, "init", "-q", "-b", "main");
    commitAll(root, "initial");

    writeFile(root, "src/alpha.ts", ["export function alphaFn(): number {", "  return 1;", "}", ""].join("\n"));
    commitAll(root, "add alpha");

    git(root, "checkout", "-q", "-b", "feature");
    rmSync(join(root, "src", "alpha.ts"));
    writeFile(root, "src/beta.ts", ["export function betaFn(): number {", "  return 2;", "}", ""].join("\n"));
    commitAll(root, "swap to beta");

    git(root, "checkout", "-q", "main");
    initWorkspace(root, v2Config(root));
    const before = indexRepository(root, "2026-07-28T11:00:00.000Z");
    expectSourceFacts(expectCoherent(root, before), { "src/alpha.ts": "alphaFn" });
    git(root, "checkout", "-q", "feature");
    const result = indexRepository(root, "2026-07-28T11:01:00.000Z");
    const persisted = expectCoherent(root, result);
    expectSourceFacts(persisted, { "src/beta.ts": "betaFn" });

    expect(persisted.indexedCommit).toBe(gitOutput(root, "rev-parse", "HEAD"));
    expect(names(persisted.graph.nodes)).toContain("betaFn");
    expect(names(persisted.graph.nodes)).not.toContain("alphaFn");
    expect(persisted.graph.nodes.some((node) => node.filePath === "src/alpha.ts")).toBe(false);
  });

  it("keeps distinct index artifacts across a linked Git worktree", () => {
    const container = tempRoot("semctx-lifecycle-worktree-");
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
    const mainResult = indexRepository(mainRoot, "2026-07-28T11:00:00.000Z");
    const mainPersistedBefore = expectCoherent(mainRoot, mainResult);

    initWorkspace(linkedRoot, v2Config(linkedRoot));
    const linkedResult = indexRepository(linkedRoot, "2026-07-28T11:01:00.000Z");

    const mainPersistedAfter = readPersisted(mainRoot);
    const linkedPersisted = expectCoherent(linkedRoot, linkedResult);
    expectSourceFacts(mainPersistedAfter, { "src/a.ts": "mainOnly" });
    expectSourceFacts(linkedPersisted, { "src/b.ts": "linkedOnly" });
    expect(mainPersistedAfter).toEqual(mainPersistedBefore);

    expect(dbPath(mainRoot)).not.toBe(dbPath(linkedRoot));
    expect(canonicalRepositoryRoot(mainRoot)).not.toBe(canonicalRepositoryRoot(linkedRoot));
    expect(controlRepositoryIdentity(mainRoot)).toBe(controlRepositoryIdentity(linkedRoot));

    expect(mainPersistedBefore.graph).toEqual(sortedGraph(mainResult.analysis.graph));
    expect(names(linkedPersisted.graph.nodes)).toContain("linkedOnly");
    expect(names(linkedPersisted.graph.nodes)).not.toContain("mainOnly");
    expect(names(mainPersistedAfter.graph.nodes)).toContain("mainOnly");
    expect(names(mainPersistedAfter.graph.nodes)).not.toContain("linkedOnly");
    expect(mainPersistedAfter.graph).toEqual(mainPersistedBefore.graph);
    expect(mainPersistedAfter.evidence).toEqual(mainPersistedBefore.evidence);
    expect(mainPersistedAfter.claims).toEqual(mainPersistedBefore.claims);
    expect(mainPersistedAfter.indexedAt).toBe(mainPersistedBefore.indexedAt);
    expect(mainPersistedAfter.indexedCommit).toBe(mainPersistedBefore.indexedCommit);
  });
});
