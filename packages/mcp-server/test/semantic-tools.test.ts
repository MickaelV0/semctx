import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { activeChangePath, changeFilePath, initSemanticScaffold, loadSemanticModel } from "@semantic-context/semantic-engine";
import {
  semanticSliceTool,
  changeOpenTool,
  changeUpdateTool,
  changeVerifyTool,
  changeCloseTool,
  semanticInspectTool,
  semanticCheckTool,
  handoffTool,
  resumeTool,
} from "../src/semantic-tools";
import { parseArgs } from "../../../apps/cli/src/args";
import { runChange } from "../../../apps/cli/src/commands/change";

let root: string;
const CHANGE = "change.payment-webhook-retry";
const INVARIANT = "invariant.semctx-test.idempotent-write";
const UNKNOWN = "unknown.semctx-test.concurrency-race";
const EVIDENCE = "evidence.semctx-test.race-test";
const SUPPLIED_DIFF =
  "--- a/src/domain/capacity.ts\n+++ b/src/domain/capacity.ts\n@@ -12 +12,2 @@\n-old\n+new\n";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-sem-mcp-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  // A real commit, not a bare directory: impact conclusions are bound to a commit, so a fixture
  // with no Git history could only ever be refused.
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root);
  // Scaffold only inert guidance, then explicitly author the truths used by this fixture.
  initSemanticScaffold(root);
  writeFileSync(
    join(root, ".semctx", "semantic", "invariants.sem"),
    `invariant ${INVARIANT}\n  statement: Retrying a write is equivalent to applying it once.\n  status: declared\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "unknowns.sem"),
    `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n`,
    "utf8",
  );
  // Index through the product path rather than writing the graph into the store by hand: a store
  // populated directly carries no index binding, and an unbound index authorizes no impact
  // conclusion. Indexing last so the seal covers the authored truths above.
  indexRepository(root, "2026-08-12T09:00:00.000Z");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semantic-layer MCP tools", () => {
  it("exposes the same versioned semantic-check contract as the CLI", () => {
    const report = semanticCheckTool(root);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
  });

  it("returns the same canonical lifecycle reason order as the CLI", () => {
    const pointer = activeChangePath(root);
    writeFileSync(pointer, "not a semantic block\n", "utf8");
    try {
      expect(semanticCheckTool(root).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);
    } finally {
      rmSync(pointer, { force: true });
    }
  });

  it("rejects a prefixed traversal id before writing outside changes", () => {
    const escaped = join(root, ".semctx", "evil-payload.sem");
    expect(() =>
      changeOpenTool(root, {
        id: "change.x/../../../evil-payload",
        statement: "must stay contained",
      }),
    ).toThrow();
    expect(Bun.file(escaped).size).toBe(0);
  });

  it("opens an agent-authored change contract", () => {
    const contract = changeOpenTool(root, {
      id: CHANGE,
      statement: "make the webhook retry-safe",
      preserves: [INVARIANT],
      unknowns: [UNKNOWN],
    });
    expect(contract.id).toBe(CHANGE);
    expect(contract.provenance).toBe("agent");
    expect(contract.lifecycle).toBe("active");
  });

  it("slices deterministically from the change scope", () => {
    const { slice, capsule } = semanticSliceTool(root, { changeId: CHANGE });
    expect(slice.changes.map((c) => c.id)).toContain(CHANGE);
    expect(slice.openUnknowns.map((u) => u.id)).toContain(UNKNOWN);
    expect(capsule).toContain("# Semantic slice");
  });

  it("composes verify diff into a PARTIAL verdict while an unknown is open", () => {
    const report = changeVerifyTool(root, { changeId: CHANGE });
    expect(report.verdict).toBe("PARTIAL");
    expect(report.underlying.schemaVersion).toBe(1);
    expect(report.openUnknowns.map((u) => u.id)).toContain(UNKNOWN);
  });

  it("cannot claim verified through update or close before composed verification passes", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, status: "verified" })).toThrow(
      "use semctx_change_close",
    );
    expect(() => changeCloseTool(root, { id: CHANGE })).toThrow(
      "composed verification is PARTIAL",
    );
  });

  it("resolves the unknown and reaches VERIFIED", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, resolveUnknowns: [UNKNOWN] })).toThrow(
      "proved evidence",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "unknowns.sem"),
      `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n  proved_by: ${EVIDENCE}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "evidence.sem"),
      `evidence ${EVIDENCE}\n  statement: Concurrency regression passes.\n  status: tested\n`,
      "utf8",
    );
    changeUpdateTool(root, { id: CHANGE, resolveUnknowns: [UNKNOWN] });
    const report = changeVerifyTool(root, { changeId: CHANGE });
    expect(report.verdict).toBe("VERIFIED");
  });

  it("inspects a semantic id with incoming references", () => {
    const inspection = semanticInspectTool(root, { id: INVARIANT });
    expect(inspection.found).toBe(true);
    expect(inspection.incoming.some((r) => r.from === CHANGE && r.field === "preserves")).toBe(true);
  });

  it("captures and resumes a handoff capsule", () => {
    const capsule = handoffTool(root, { note: "mid-task" });
    expect(capsule.activeChangeId).toBe(CHANGE);
    const resumed = resumeTool(root);
    expect("activeChangeId" in resumed ? resumed.activeChangeId : undefined).toBe(CHANGE);
  });

  it("closes verified only after composed verification passes", () => {
    const closed = changeCloseTool(root, { id: CHANGE });
    expect(closed.lifecycle).toBe("verified");
  });

  it("does not disturb the first-class verify tool (import still works)", async () => {
    const { verifyChangeTool } = await import("../src/tools");
    const result = verifyChangeTool(root, { gitDiff: SUPPLIED_DIFF });
    expect(["PASS", "WARN", "BLOCK"]).toContain(result.verdict);
  });
});

// The MCP surface accepts diff text but offers no way to say which commit it belongs to, so every
// conclusion drawn from it is unanchored. It must stay diagnostic rather than certifying.
describe("MCP-supplied diff text carries no provenance", () => {
  it("refuses an impact verdict for a diff handed to semctx_verify_change", async () => {
    const { verifyChangeTool } = await import("../src/tools");

    const report = verifyChangeTool(root, { gitDiff: SUPPLIED_DIFF });

    expect(report.verdict).toBe("BLOCK");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("SOURCE_IDENTITY_ABSENT"),
        }),
      ]),
    );
  });

  it("never composes a supplied diff into VERIFIED", () => {
    const composed = changeVerifyTool(root, { changeId: CHANGE, gitDiff: SUPPLIED_DIFF });

    expect(composed.verdict).not.toBe("VERIFIED");
    expect(composed.verdict).toBe("BLOCKED");
  });

  it("refuses to close a change on a supplied diff", () => {
    expect(() => changeCloseTool(root, { id: CHANGE, gitDiff: SUPPLIED_DIFF })).toThrow(
      "composed verification is BLOCKED",
    );
  });
});

describe("CLI and MCP close require fresh VERIFIED proof", () => {
  for (const consumer of ["CLI", "MCP"] as const) {
    it.each(["BLOCKED", "STALE", "VERIFIED"] as const)(
      `${consumer} closes only VERIFIED and preserves contract/pointer on %s refusal`,
      (verdict) => {
        const fixture = mkdtempSync(join(tmpdir(), "semctx-close-consumer-"));
        const change = "change.close-consumer";
        try {
          cpSync(SAMPLE_REPO, fixture, { recursive: true,
            filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
          writeFileSync(join(fixture, ".gitignore"), ".semctx/\n");
          git(fixture, "init", "-q");
          git(fixture, "add", ".");
          git(fixture, "commit", "-q", "-m", "fixture");
          initWorkspace(fixture);
          initSemanticScaffold(fixture);
          changeOpenTool(fixture, { id: change, statement: "Close through real verification",
            links: verdict === "STALE" ? ["file:src/removed.ts"] : [] });
          indexRepository(fixture, "2026-10-09T10:02:00.000Z");
          const contractPath = changeFilePath(fixture, change);
          const pointerPath = activeChangePath(fixture);
          const contractBefore = readFileSync(contractPath, "utf8");
          const pointerBefore = readFileSync(pointerPath, "utf8");
          // A supplied diff has no source identity on either surface. Keep it outside the indexed
          // fixture so the refusal cannot accidentally be caused by an untracked source file.
          const diffPath = `${fixture}.diff`;
          try {
            if (verdict === "BLOCKED") writeFileSync(diffPath, SUPPLIED_DIFF);
            const input = { changeId: change,
              ...(verdict === "BLOCKED" ? { gitDiff: SUPPLIED_DIFF } : {}) };
            const report = changeVerifyTool(fixture, input);
            expect(report.verdict).toBe(verdict);
            if (verdict === "BLOCKED") {
              expect(report.underlying.findings).toEqual(expect.arrayContaining([
                expect.objectContaining({ rule: "index_binding_stale",
                  message: expect.stringContaining("SOURCE_IDENTITY_ABSENT") }),
              ]));
            }
            expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
            expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
            const close = () => consumer === "MCP"
              ? changeCloseTool(fixture, { id: change,
                ...(verdict === "BLOCKED" ? { gitDiff: SUPPLIED_DIFF } : {}) })
              : runChange(fixture, parseArgs(["change", "close", change, "--root", fixture,
                ...(verdict === "BLOCKED" ? ["--from-file", diffPath] : [])]));

            if (verdict === "VERIFIED") {
              close();
              expect(loadSemanticModel(fixture).model.changes.find((node) => node.id === change)?.lifecycle)
                .toBe("verified");
              expect(existsSync(pointerPath)).toBe(false);
            } else {
              expect(close).toThrow(`composed verification is ${verdict}`);
              expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
              expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
            }
          } finally {
            rmSync(diffPath, { force: true });
          }
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      },
    );
    it(`${consumer} reruns verification instead of closing from a previously VERIFIED report`, () => {
      const fixture = mkdtempSync(join(tmpdir(), "semctx-close-freshness-"));
      const change = "change.fresh-close";
      try {
        mkdirSync(join(fixture, "src"));
        writeFileSync(join(fixture, "src", "service.py"),
          "# @invariant stable-service: Service behavior remains stable.\ndef service():\n    return 1\n");
        writeFileSync(join(fixture, ".gitignore"), ".semctx/\n");
        git(fixture, "init", "-q");
        git(fixture, "add", ".");
        git(fixture, "commit", "-q", "-m", "fixture");
        initWorkspace(fixture, { ...createGlobSelectionConfig(fixture), include: ["src/**/*.py"],
          languages: { typescript: "on", python: "on", markdown: "on", sql: "on" } });
        initSemanticScaffold(fixture);
        writeFileSync(join(fixture, ".semctx", "semantic", "invariants.sem"),
          "invariant invariant.python.stable\n  statement: Service behavior remains stable.\n  status: declared\n  tag: critical\n  link: file:src/service.py\n");
        changeOpenTool(fixture, { id: change, statement: "Close only current source",
          preserves: ["invariant.python.stable"] });
        indexRepository(fixture, "2026-10-09T10:03:00.000Z");
        const initiallyVerified = changeVerifyTool(fixture, { changeId: change });
        expect(initiallyVerified.verdict).toBe("VERIFIED");
        expect(initiallyVerified.preserved).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "invariant.python.stable", critical: true, state: "untouched" }),
        ]));
        expect(initiallyVerified.preserved.find((node) => node.id === "invariant.python.stable")?.footprint.length)
          .toBeGreaterThan(0);
        const contractPath = changeFilePath(fixture, change);
        const pointerPath = activeChangePath(fixture);
        const contractBefore = readFileSync(contractPath, "utf8");
        const pointerBefore = readFileSync(pointerPath, "utf8");
        // Unlike an unrelated EOF comment, this changes the behavior constrained by the indexed
        // Python invariant and the contract's explicit preservation obligation.
        writeFileSync(join(fixture, "src", "service.py"),
          "# @invariant stable-service: Service behavior remains stable.\ndef service():\n    return 2\n");

        if (consumer === "MCP") {
          expect(() => changeCloseTool(fixture, { id: change }))
            .toThrow("composed verification is BLOCKED");
        } else {
          expect(() => runChange(fixture, parseArgs(["change", "close", change, "--root", fixture])))
            .toThrow("composed verification is BLOCKED");
        }

        expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
        expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }
});
