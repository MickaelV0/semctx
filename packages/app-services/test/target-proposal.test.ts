import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  targetArtifactPath,
} from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import * as appServices from "../src";

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

describe("target proposal application boundary", () => {
  it("binds agent-authored target content to the current fresh repository state", () => {
    const fixture = preparedRepository();
    const propose = exportedProposer();
    if (propose === undefined) return;

    const result = propose(fixture.root, proposalCommand());
    const targetPath = targetArtifactPath(
      fixture.root,
      result.artifact.targetId,
      result.artifact.revision,
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "target_architecture_proposal",
      certifying: false,
      executionAuthority: "none",
      relativePath: ".semctx/semantic/targets/target.checkout/r1.target.json",
      artifact: {
        targetId: "target.checkout",
        revision: 1,
        normativeStatus: "proposed",
        authorshipOrigin: "agent",
        baseCommit: fixture.head,
        sourceGraphSeal: fixture.graphSeal,
      },
    });
    expect(readFileSync(targetPath, "utf8")).toBe(`${JSON.stringify(result.artifact, null, 2)}\n`);
  });

  it("rejects caller-selected source state and authorship authority", () => {
    const fixture = preparedRepository();
    const propose = exportedProposer();
    if (propose === undefined) return;

    for (const forbidden of [
      { baseCommit: "caller-selected" },
      { sourceGraphSeal: fixture.graphSeal },
      { authorshipOrigin: "human" },
    ]) {
      expect(() => propose(fixture.root, {
        ...proposalCommand(),
        ...forbidden,
      })).toThrow();
    }
  });

  it("refuses to create a proposal when the repository state is not fresh", () => {
    const fixture = preparedRepository();
    const propose = exportedProposer();
    if (propose === undefined) return;
    writeFileSync(join(fixture.root, "src", "capacity.ts"), "\n// drift\n", { flag: "a" });

    expect(() => propose(fixture.root, proposalCommand())).toThrow(/FRESH|fresh/);
    expect(existsSync(targetArtifactPath(fixture.root, "target.checkout", 1))).toBe(false);
  });
});

function exportedProposer(): ((
  root: string,
  command: Record<string, unknown>,
) => {
  schemaVersion: 1;
  kind: "target_architecture_proposal";
  certifying: false;
  executionAuthority: "none";
  relativePath: string;
  artifact: {
    targetId: string;
    revision: number;
    normativeStatus: "proposed" | "accepted";
    authorshipOrigin: "human" | "agent" | "imported";
    baseCommit: string;
    sourceGraphSeal: string;
  };
}) | undefined {
  const candidate = (appServices as Record<string, unknown>)["proposeTargetArchitecture"];
  expect(candidate).toBeFunction();
  return typeof candidate === "function"
    ? candidate as ReturnType<typeof exportedProposer>
    : undefined;
}

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

function preparedRepository(): {
  root: string;
  head: string;
  graphSeal: string;
} {
  const root = mkdtempSync(join(tmpdir(), "semctx-target-proposal-"));
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
  const indexed = appServices.indexRepository(root, "2026-07-27T09:00:00.000Z");
  return {
    root,
    head: git(root, "rev-parse", "HEAD"),
    graphSeal: indexed.freshnessSeal.repositoryGraphHash,
  };
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
