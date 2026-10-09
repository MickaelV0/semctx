import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { activeChangePath, loadActiveChange, loadSemanticModel } from "@semantic-context/semantic-engine";
import { parseArgs, type ParsedArgs } from "../src/args";
import { runInit } from "../src/commands/init";
import { runIndex } from "../src/commands/index-cmd";
import { runSemantic } from "../src/commands/semantic";
import { runChange } from "../src/commands/change";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, openChange } from "@semantic-context/app-services";
import { initSemanticScaffold, changeFilePath } from "@semantic-context/semantic-engine";
import { changeVerifyTool, changeCloseTool } from "../../../packages/mcp-server/src/semantic-tools";

let root: string;

const GOAL = "goal.semctx-test.reliable-writes";
const INVARIANT = "invariant.semctx-test.idempotent-write";
const UNKNOWN = "unknown.semctx-test.concurrency-race";
const EVIDENCE = "evidence.semctx-test.race-test";

function writeAuthoredFixture(): void {
  writeFileSync(
    join(root, ".semctx", "semantic", "goals.sem"),
    `goal ${GOAL}\n  statement: Every write is applied at most once.\n  status: declared\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "invariants.sem"),
    `invariant ${INVARIANT}\n  statement: Retrying a write is equivalent to applying it once.\n  status: declared\n  serves: ${GOAL}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "unknowns.sem"),
    `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n`,
    "utf8",
  );
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

/** Run a CLI command, capturing stdout so we can assert on JSON payloads and verdicts. */
function run(fn: (root: string, args: ParsedArgs) => number, argv: string[], targetRoot = root): { code: number; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    const code = fn(targetRoot, parseArgs([...argv, "--root", targetRoot]));
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-semantic-cli-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  // Composed verification is anchored to a commit, so the fixture is a real repository and the
  // change flow verifies its (clean) working tree instead of an unattributed diff file.
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  runInit(root, parseArgs(["init", "--root", root]));
  runIndex(root, parseArgs(["index", "--root", root]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semctx semantic — CLI", () => {
  it("init scaffolds inert placeholders and check passes on a fresh repo", () => {
    const init = run(runSemantic, ["semantic", "init"]);
    expect(init.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    const check = run(runSemantic, ["semantic", "check", "--json"]);
    expect(check.code).toBe(0);
    const report = JSON.parse(check.out);
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
    expect(report.graphIndexed).toBe(true);
    expect(report.counts.nodes).toBe(0);
    expect(loadSemanticModel(root).model).toEqual({ nodes: [], changes: [], refinementRelations: [] });
    expect(readFileSync(join(root, ".semctx", "semantic", "goals.sem"), "utf8")).toContain("#   goal goal.<project>.<slug>");
  });

  it("format is dry by default and skips comment-only files", () => {
    const dry = run(runSemantic, ["semantic", "format", "--json"]);
    expect(dry.code).toBe(0);
    const outcomes = JSON.parse(dry.out).outcomes as { file: string; skipped: boolean }[];
    expect(outcomes.some((o) => o.file.endsWith("assumptions.sem") && o.skipped)).toBe(true);
  });

  it("format --write refuses a partially invalid source without rewriting it", () => {
    const path = join(root, ".semctx", "semantic", "goals.sem");
    const before = [
      `goal ${GOAL}`,
      "  statement: remains byte-identical",
      "  status: declared",
      "  malformed field",
      "",
    ].join("\n");
    writeFileSync(path, before, "utf8");
    try {
      let caught: unknown;
      try {
        run(runSemantic, ["semantic", "format", "--write"]);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_INVALID");
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      writeFileSync(path, "# restored fixture\n", "utf8");
    }
  });

  it("returns the canonical lifecycle reason order on a negative path", () => {
    const pointer = activeChangePath(root);
    writeFileSync(pointer, "not a semantic block\n", "utf8");
    try {
      const check = run(runSemantic, ["semantic", "check", "--json"]);
      expect(check.code).toBe(1);
      expect(JSON.parse(check.out).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);
    } finally {
      rmSync(pointer, { force: true });
    }
  });

  it("renders a node without unicode glyphs in ascii notation", () => {
    writeAuthoredFixture();
    const r = run(runSemantic, ["semantic", "render", INVARIANT, "--notation", "ascii"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[invariant]");
    expect(r.out).not.toContain("□");
  });
});

describe("semctx change — CLI end-to-end (PARTIAL → VERIFIED)", () => {
  const CHANGE = "change.payment-webhook-retry";

  it("rejects a prefixed traversal id before writing outside changes", () => {
    const escaped = join(root, ".semctx", "evil-payload.sem");
    expect(() =>
      run(runChange, ["change", "open", "change.x/../../../evil-payload", "--statement", "must stay contained"]),
    ).toThrow();
    expect(existsSync(escaped)).toBe(false);
  });

  it("opens a change contract, tracked and set active", () => {
    writeAuthoredFixture();
    const opened = run(runChange, ["change", "open", CHANGE, "--statement", "retry-safe", "--preserves", INVARIANT, "--unknown", UNKNOWN]);
    expect(opened.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "changes", `${CHANGE}.sem`))).toBe(true);
    expect(loadActiveChange(root)?.id).toBe(CHANGE);
  });

  it("slice seeds from the change and reaches its goal and unknown", () => {
    const slice = run(runSemantic, ["semantic", "slice", "--change", CHANGE, "--format", "json"]);
    const payload = JSON.parse(slice.out);
    expect(payload.intentions.map((n: { id: string }) => n.id)).toContain(GOAL);
    expect(payload.openUnknowns.map((n: { id: string }) => n.id)).toContain(UNKNOWN);
  });

  it("verify returns PARTIAL while an unknown is open (exit 0, not a failure)", () => {
    const v = run(runChange, ["change", "verify", CHANGE, "--format", "json"]);
    expect(v.code).toBe(0);
    const report = JSON.parse(v.out);
    expect(report.verdict).toBe("PARTIAL");
    expect(report.underlying.verdict).toBe("PASS");
  });

  it("cannot claim verified through update or close before composed verification passes", () => {
    expect(() => run(runChange, ["change", "update", CHANGE, "--status", "verified"])).toThrow(
      "use 'semctx change close'",
    );
    expect(() => run(runChange, ["change", "close", CHANGE])).toThrow(
      "composed verification is PARTIAL",
    );
    expect(loadActiveChange(root)?.lifecycle).toBe("active");
  });

  it("verify returns VERIFIED once the unknown is resolved", () => {
    expect(() =>
      run(runChange, ["change", "update", CHANGE, "--resolve-unknown", UNKNOWN]),
    ).toThrow("proved evidence");
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
    const upd = run(runChange, ["change", "update", CHANGE, "--resolve-unknown", UNKNOWN]);
    expect(upd.code).toBe(0);
    const v = run(runChange, ["change", "verify", CHANGE, "--format", "json"]);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out).verdict).toBe("VERIFIED");
  });

  it("handoff captures the active change and re-reads via resume", () => {
    const h = run(runSemantic, ["semantic", "handoff", "--json"]);
    expect(h.code).toBe(0);
    expect(JSON.parse(h.out).activeChangeId).toBe(CHANGE);
    const resume = run(runSemantic, ["semantic", "resume", "--json"]);
    expect(JSON.parse(resume.out).activeChangeId).toBe(CHANGE);
  });

  it("close marks the change verified only after composed verification passes", () => {
    const c = run(runChange, ["change", "close", CHANGE]);
    expect(c.code).toBe(0);
    expect(loadActiveChange(root)).toBeUndefined();
    const model = loadSemanticModel(root);
    expect(model.model.changes.find((x) => x.id === CHANGE)?.lifecycle).toBe("verified");
  });
});

describe("Python authored proof at CLI and MCP consumer boundaries", () => {
  it("returns equivalent PARTIAL reports, honors fail-on partial, and refuses both closes without writes", () => {
    const fixture = mkdtempSync(join(tmpdir(), "semctx-python-consumers-"));
    const change = "change.python-consumers";
    try {
      mkdirSync(join(fixture, "src"));
      writeFileSync(join(fixture, ".gitignore"), ".semctx/\n");
      writeFileSync(join(fixture, "src", "service.py"), "def service():\n    return 1\n");
      writeFileSync(join(fixture, "src", "test_service.py"),
        "from service import service\n\ndef test_service():\n    assert service() == 1\n");
      for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "fixture"]]) {
        const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test",
          "-c", "user.email=semctx@example.test", ...args],
        { cwd: fixture, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      }
      initWorkspace(fixture, { ...createGlobSelectionConfig(fixture), include: ["src/**/*.py"],
        languages: { typescript: "on", python: "on", markdown: "on", sql: "on" } });
      initSemanticScaffold(fixture);
      writeFileSync(join(fixture, ".semctx", "semantic", "invariants.sem"),
        "invariant invariant.python.stable\n  statement: Service behavior remains stable.\n  status: declared\n  tag: critical\n  link: file:src/service.py\n  proved_by: evidence.python.test\n");
      writeFileSync(join(fixture, ".semctx", "semantic", "evidence.sem"),
        "evidence evidence.python.test\n  statement: Preservation regression is tested.\n  status: tested\n  link: test:src/test_service.py\n");
      writeFileSync(join(fixture, "src", "service.py"),
        "def service():\n    import importlib\n    importlib.import_module('math')\n    return 1\n");
      openChange(fixture, { id: change, statement: "Preserve Python service", provenance: "author",
        preserves: ["invariant.python.stable"], requiresEvidence: ["evidence.python.test"] });
      indexRepository(fixture, "2026-10-09T10:01:00.000Z");
      const contractPath = changeFilePath(fixture, change);
      const pointerPath = activeChangePath(fixture);
      const contractBefore = readFileSync(contractPath, "utf8");
      const pointerBefore = readFileSync(pointerPath, "utf8");

      const cli = run(runChange, ["change", "verify", change, "--format", "json"], fixture);
      const strict = run(runChange, ["change", "verify", change, "--format", "json",
        "--fail-on", "partial"], fixture);
      const mcp = changeVerifyTool(fixture, { changeId: change });

      expect(cli.code).toBe(0);
      expect(strict.code).toBe(3);
      expect(JSON.parse(cli.out)).toEqual(mcp);
      expect(JSON.parse(strict.out)).toEqual(mcp);
      expect(mcp.verdict).toBe("PARTIAL");
      expect(mcp.preserved).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "invariant.python.stable", critical: true, state: "proved" }),
      ]));
      expect(mcp.underlying.verdict).toBe("WARN");
      expect(mcp.underlying.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "analysis_scope_incomplete", severity: "warn" }),
      ]));
      expect(mcp.underlying.unknowns.some((unknown) =>
        unknown.includes("No complete negative reference"))).toBe(true);
      expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
      expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
      expect(() => run(runChange, ["change", "close", change], fixture))
        .toThrow("composed verification is PARTIAL");
      expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
      expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
      expect(() => changeCloseTool(fixture, { id: change }))
        .toThrow("composed verification is PARTIAL");
      expect(readFileSync(contractPath, "utf8")).toBe(contractBefore);
      expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
