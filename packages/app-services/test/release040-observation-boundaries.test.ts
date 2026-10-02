import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { createTargetProposal } from "@semantic-context/semantic-engine";
import { captureTrackedWorkingDiff } from "../src/freshness";
import { historicalCoChanges } from "../src/verify";
import { assertTargetProposalContained } from "../src/reconciliation-index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-observation-refusal-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "semctx-test");
  git(root, "config", "user.email", "semctx-test@example.com");
  return root;
}

function assertNamedRefusal(run: () => unknown, code: string, message: string): void {
  let refusal: unknown;
  try { run(); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(SemctxError);
  expect(refusal).toMatchObject({ code, message: expect.stringContaining(message) });
}

describe("release 0.4 observation boundaries", () => {
  it("preserves the named unborn case and refuses a corrupt HEAD", () => {
    const root = repository();
    expect(captureTrackedWorkingDiff(root)).toEqual(new Uint8Array());
    writeFileSync(join(root, ".git", "HEAD"), "not-a-valid-head\n");
    assertNamedRefusal(() => captureTrackedWorkingDiff(root), "GIT_ERROR", "cannot observe repository HEAD");
  });

  it("does not call failed Git history an empty co-change observation", () => {
    const root = repository();
    assertNamedRefusal(() => historicalCoChanges(root, ["src/a.ts"], "missing-commit"), "GIT_ERROR", "cannot observe co-change history");
    expect(historicalCoChanges(root, [], "missing-commit")).toEqual([]);
  });

  it("revalidates the bytes of a proposal in its attested commit", () => {
    const root = repository();
    initWorkspace(root);
    git(root, "commit", "--allow-empty", "-qm", "initial");
    const proposal = createTargetProposal(root, {
      targetId: "target.boundary",
      revision: 1,
      statement: "Preserve the declared target",
      baseCommit: git(root, "rev-parse", "HEAD"),
      sourceGraphSeal: `sha256:${"a".repeat(64)}`,
      elements: [{ id: "repo:src/a.ts", level: 1, category: "code_entity", fingerprint: "source" }],
      relations: [],
      preservedInvariantIds: [],
      authorshipOrigin: "agent",
    });
    const path = join(root, ".semctx", "semantic", "targets", proposal.targetId, "r1.target.json");
    git(root, "add", "-f", ".semctx/semantic/targets");
    git(root, "commit", "-qm", "proposal");
    expect(() => assertTargetProposalContained(root, proposal, "HEAD")).not.toThrow();
    writeFileSync(path, JSON.stringify({ ...proposal, statement: "Forged bytes, retained declared hash" }));
    git(root, "add", "-f", path);
    git(root, "commit", "-qm", "forged");
    assertNamedRefusal(() => assertTargetProposalContained(root, proposal, "HEAD"), "CONTROL_INPUTS_UNSAFE", "accepted target proposal is absent or invalid");
    writeFileSync(path, "null\n");
    git(root, "add", "-f", path);
    git(root, "commit", "-qm", "null artifact");
    assertNamedRefusal(() => assertTargetProposalContained(root, proposal, "HEAD"), "CONTROL_INPUTS_UNSAFE", "accepted target proposal is absent or invalid");
  });
});
