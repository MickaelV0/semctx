import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  targetArtifactPath,
} from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";

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

describe("control target proposal CLI transport", () => {
  it("creates the canonical agent proposal without caller-selected source state", () => {
    const root = preparedRepository();
    const inputRoot = mkdtempSync(join(tmpdir(), "semctx-cli-target-input-"));
    roots.push(inputRoot);
    const input = join(inputRoot, "target-proposal.json");
    writeFileSync(input, `${JSON.stringify(proposalCommand(), null, 2)}\n`);

    const result = runCli(root, [
      "control",
      "target-propose",
      "--input",
      input,
      "--json",
    ]);

    expect(result.code, result.err).toBe(0);
    const output = JSON.parse(result.out);
    expect(output).toMatchObject({
      schemaVersion: 1,
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
  const root = mkdtempSync(join(tmpdir(), "semctx-cli-target-proposal-"));
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

function runCli(root: string, args: string[]): {
  code: number;
  out: string;
  err: string;
} {
  const result = Bun.spawnSync(["bun", CLI, "--root", root, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
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
