import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "@semantic-context/repository-store";
import {
  activeChangePath,
  newChangeContract,
  writeActiveChange,
  writeChangeFile,
} from "@semantic-context/semantic-engine";
import { captureVerificationGitState, checkSemanticState, controlStatus, indexRepository } from "../src";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "semctx-lifecycle-"));
  roots.push(dir);
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), ".semctx/\n", "utf8");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "README.md"], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], { cwd: dir });
  initWorkspace(dir);
  return dir;
}

function change(id: string, lifecycle: "active" | "verified" | "superseded" = "active", statement = id) {
  return newChangeContract({ id, statement, lifecycle, provenance: "author" });
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("semantic lifecycle hygiene", () => {
  it("checks an unprepared repository without creating readiness state", () => {
    const dir = mkdtempSync(join(tmpdir(), "semctx-lifecycle-unprepared-"));
    roots.push(dir);

    const report = checkSemanticState(dir);

    expect(report.graphIndexed).toBe(false);
    expect(report.ok).toBe(true);
    expect(existsSync(join(dir, ".semctx"))).toBe(false);
  });

  it("treats terminal contracts without a pointer as normal closed history", () => {
    const dir = root();
    writeChangeFile(dir, change("change.closed", "verified"));
    writeChangeFile(dir, change("change.replaced", "superseded"));

    const report = checkSemanticState(dir);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("distinguishes missing, invalid and mismatched active pointers", () => {
    const missingRoot = root();
    const active = change("change.current");
    writeChangeFile(missingRoot, active);
    expect(checkSemanticState(missingRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_MISSING"]);

    const invalidRoot = root();
    writeChangeFile(invalidRoot, active);
    writeActiveChange(invalidRoot, active);
    writeFileSync(activeChangePath(invalidRoot), "not a semantic block\n", "utf8");
    expect(checkSemanticState(invalidRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);

    const mismatchRoot = root();
    writeChangeFile(mismatchRoot, active);
    writeActiveChange(mismatchRoot, { ...active, statement: "working copy drifted" });
    expect(checkSemanticState(mismatchRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_MISMATCH"]);
  });

  it("reports obsolete non-selected or closed active state", () => {
    const extraRoot = root();
    const selected = change("change.selected");
    writeChangeFile(extraRoot, selected);
    writeChangeFile(extraRoot, change("change.forgotten"));
    writeActiveChange(extraRoot, selected);
    const extra = checkSemanticState(extraRoot);
    expect(extra.reasonCodes).toEqual(["ACTIVE_CHANGE_OBSOLETE"]);
    expect(extra.lifecycleFindings[0]?.subjectIds).toEqual(["change.forgotten"]);

    const closedRoot = root();
    const closed = change("change.closed", "verified");
    writeChangeFile(closedRoot, closed);
    writeActiveChange(closedRoot, closed);
    expect(checkSemanticState(closedRoot).reasonCodes).toEqual(["ACTIVE_CHANGE_OBSOLETE"]);
  });

  it("separates a corrupt evidence baseline from a superseded one and a stale one", () => {
    const invalidRoot = root();
    writeFileSync(join(invalidRoot, ".semctx", "verification-state.json"), "{broken", "utf8");
    expect(checkSemanticState(invalidRoot).reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);

    const legacyRoot = root();
    writeFileSync(
      join(legacyRoot, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 1,
        diffHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    expect(checkSemanticState(legacyRoot).reasonCodes).toEqual(["EVIDENCE_BASELINE_SUPERSEDED"]);
    writeFileSync(
      join(legacyRoot, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 2,
        headCommit: "a".repeat(40),
        workingStateHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const superseded = checkSemanticState(legacyRoot);
    expect(superseded.reasonCodes).toEqual(["EVIDENCE_BASELINE_SUPERSEDED"]);
    expect(superseded.lifecycleFindings.map((finding) => finding.severity)).toEqual(["warning"]);
    expect(superseded.lifecycleFindings[0]?.message).toBe(
      "The recorded verification baseline uses a schema this build no longer reads; re-record it with semctx verify diff --record.",
    );

    // Recognising a schema is not trusting whatever names itself one. An unknown version, an
    // absent version, and a v3 that fails its own shape all stay invalid.
    for (const unrecognised of [
      { version: 99, verdict: "PASS", recordedAt: "2026-07-23T00:00:00.000Z" },
      { verdict: "PASS", recordedAt: "2026-07-23T00:00:00.000Z" },
      { version: 3, headCommit: "a".repeat(40), verdict: "PASS", recordedAt: "2026-07-23T00:00:00.000Z" },
    ]) {
      writeFileSync(
        join(legacyRoot, ".semctx", "verification-state.json"),
        `${JSON.stringify(unrecognised)}
`,
        "utf8",
      );
      expect(checkSemanticState(legacyRoot).reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);
    }

    const staleRoot = root();
    mkdirSync(join(staleRoot, ".semctx", "working"), { recursive: true });
    writeFileSync(activeChangePath(staleRoot), "not a semantic block\n", "utf8");
    writeFileSync(
      join(staleRoot, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 3,
        ...captureVerificationGitState(staleRoot),
        contentStateHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const report = checkSemanticState(staleRoot);
    expect(report.reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID", "EVIDENCE_BASELINE_STALE"]);
    expect(report.lifecycleFindings.map((finding) => finding.code)).toEqual([
      "ACTIVE_CHANGE_POINTER_INVALID",
      "EVIDENCE_BASELINE_STALE",
    ]);
    expect(report.lifecycleFindings.find((finding) => finding.code === "EVIDENCE_BASELINE_STALE")?.message)
      .toBe("The recorded verification baseline does not match the current analyzed content state.");
  });

  it("rejects malformed recognized legacy baselines before indexing", () => {
    const repositoryRoot = root();
    const common = { verdict: "PASS", recordedAt: "2026-07-23T00:00:00.000Z" };
    const states = [
      { ...common, version: 1, diffHash: `sha256:${"0".repeat(64)}` },
      { ...common, version: 2, headCommit: "a".repeat(40), workingStateHash: `sha256:${"0".repeat(64)}` },
    ];
    for (const state of states) {
      for (const field of Object.keys(state)) {
        if (field === "version") continue;
        for (const value of [undefined, false, "invalid"]) {
          writeFileSync(join(repositoryRoot, ".semctx", "verification-state.json"),
            JSON.stringify({ ...state, [field]: value }));
          const report = checkSemanticState(repositoryRoot);
          expect(report.reasonCodes).toEqual(["EVIDENCE_BASELINE_INVALID"]);
          expect(report.ok).toBe(false);
          expect(() => indexRepository(repositoryRoot, "2026-07-23T00:00:00.000Z"))
            .toThrow("semantic model cannot be sealed during indexing");
        }
      }
    }
  });

  it("survives an exact commit but invalidates changed committed or untracked content", () => {
    const exactCommit = root();
    writeFileSync(join(exactCommit, "README.md"), "verified change\n", "utf8");
    Bun.spawnSync(["git", "add", "README.md"], { cwd: exactCommit });
    const exactState = captureVerificationGitState(exactCommit);
    writeFileSync(
      join(exactCommit, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 3,
        ...exactState,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "exact"],
      { cwd: exactCommit },
    );
    expect(captureVerificationGitState(exactCommit).headCommit).not.toBe(exactState.headCommit);
    expect(checkSemanticState(exactCommit).reasonCodes).toEqual([]);

    const movedHead = root();
    writeFileSync(
      join(movedHead, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 3,
        ...captureVerificationGitState(movedHead),
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    expect(checkSemanticState(movedHead).reasonCodes).toEqual([]);
    writeFileSync(join(movedHead, "NEXT.md"), "next\n", "utf8");
    Bun.spawnSync(["git", "add", "NEXT.md"], { cwd: movedHead });
    Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "next"],
      { cwd: movedHead },
    );
    expect(checkSemanticState(movedHead).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);

    const untracked = root();
    writeFileSync(
      join(untracked, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 3,
        ...captureVerificationGitState(untracked),
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    writeFileSync(join(untracked, "untracked-source.ts"), "export const value = 1;\n", "utf8");
    expect(checkSemanticState(untracked).reasonCodes).toEqual(["EVIDENCE_BASELINE_STALE"]);
  }, 15_000);

  it("indexes a repository whose baseline was written by a superseded schema", () => {
    const dir = root();
    writeFileSync(
      join(dir, ".semctx", "verification-state.json"),
      `${JSON.stringify({
        version: 2,
        headCommit: "a".repeat(40),
        workingStateHash: `sha256:${"0".repeat(64)}`,
        verdict: "PASS",
        recordedAt: "2026-07-23T00:00:00.000Z",
      })}
`,
      "utf8",
    );
    expect(checkSemanticState(dir).reasonCodes).toEqual(["EVIDENCE_BASELINE_SUPERSEDED"]);

    // The point of the whole change: `index` is what produces a current baseline, so it must not
    // be gated on already having one. The only previous exit was deleting the file, which nothing
    // told the operator to do.
    expect(() => indexRepository(dir, "2026-07-23T00:00:00.000Z")).not.toThrow();
    expect(["FRESH", "DIRTY_KNOWN"]).toContain(controlStatus(dir).verdict);
    expect(checkSemanticState(dir).reasonCodes).toEqual(["EVIDENCE_BASELINE_SUPERSEDED"]);
  }, 15_000);

  it("refuses to seal an index while lifecycle inputs are invalid", () => {
    const dir = root();
    const active = change("change.current");
    writeChangeFile(dir, active);
    writeActiveChange(dir, { ...active, statement: "pointer drift" });

    expect(() => indexRepository(dir, "2026-07-23T00:00:00.000Z")).toThrow(
      "semantic model cannot be sealed during indexing",
    );
  });
});
