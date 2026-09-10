import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyReport } from "@semantic-context/core";
import { writeNewLocalReportFile } from "../src/report-output";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const roots: string[] = [];
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "semctx-local-report-cli-")));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function run(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const child = Bun.spawnSync([process.execPath, "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: child.exitCode ?? 1,
    out: new TextDecoder().decode(child.stdout),
    err: new TextDecoder().decode(child.stderr),
  };
}

function fixtureReport(): VerifyReport {
  return {
    schemaVersion: 1, verdict: "WARN", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: ["private/relative.ts"], changedSymbols: [], impactedContracts: [], impactedInvariants: [],
    recommendedTests: [], contradictions: [], unknowns: [],
    findings: [{ rule: "custom TOP_SECRET rule", tier: "advisory", severity: "warn", message: "C:\\private\\secret", nodeIds: [], locations: [] }],
    summary: { blockCount: 0, warnCount: 1 },
  };
}

describe("local report CLI", () => {
  test("feedback refuses a report whose top-level content would be discarded", () => {
    const repository = root();
    const reportPath = join(repository, "verify.json");
    const report = { ...fixtureReport(), ...JSON.parse('{"__proto__":"unrepresentable"}') };
    writeFileSync(reportPath, JSON.stringify(report));
    const recorded = run(["feedback", "record", "--root", repository, "--report", reportPath, "--finding", "0", "--outcome", "useful", "--json"]);
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain("report contains a top-level field that cannot be preserved");
    expect(existsSync(join(repository, ".semctx"))).toBe(false);
  });

  test("relative report paths follow the caller directory independently of repository root", () => {
    const repository = root(); const caller = root();
    writeFileSync(join(caller, "verify.json"), JSON.stringify(fixtureReport()));
    const recorded = run(["feedback", "record", "--root", repository, "--report", "verify.json", "--finding", "0", "--outcome", "useful", "--json"], caller);
    expect(recorded.code, recorded.err).toBe(0);
    expect(JSON.parse(recorded.out).status).toBe("recorded");
    expect(existsSync(join(caller, ".semctx"))).toBe(false);
    expect(existsSync(join(repository, ".semctx", "feedback", "records.json"))).toBe(true);
  });
  test("an output ancestor junction cannot write outside the selected destination", () => {
    const repository = root(); const outside = root();
    const link = join(repository, "link");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => writeNewLocalReportFile(join(link, "support.json"), "{}")).toThrow("symlink");
    expect(existsSync(join(outside, "support.json"))).toBe(false);
  });
  test("support preview is JSON, non-mutating, and explicit output refuses overwrite", () => {
    const repository = root();
    const preview = run(["support", "--root", repository]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.out).kind).toBe("support_report");
    expect(existsSync(join(repository, ".semctx"))).toBe(false);
    const output = join(repository, "support.json");
    const written = run(["support", "--root", repository, "--output", output]);
    expect(written.code).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(written.out);
    const refused = run(["support", "--root", repository, "--output", output]);
    expect(refused.code).toBe(1);
    expect(readFileSync(output, "utf8")).toBe(written.out);
  });

  test("feedback lifecycle dispatches and public export strips private inputs", () => {
    const repository = root();
    const reportPath = join(repository, "verify.json");
    writeFileSync(reportPath, JSON.stringify(fixtureReport()));
    const recorded = run(["feedback", "record", "--root", repository, "--report", reportPath, "--finding", "0", "--outcome", "suspected-error", "--reason", "false-positive", "--note", "TOP_SECRET local note", "--json"]);
    expect(recorded.code).toBe(0);
    const recordId = JSON.parse(recorded.out).record.recordId as string;
    expect(run(["feedback", "show", recordId, "--root", repository, "--json"]).code).toBe(0);
    expect(run(["feedback", "update", recordId, "--root", repository, "--outcome", "useful", "--json"]).code).toBe(0);
    const aggregate = run(["feedback", "export", "--root", repository]);
    expect(aggregate.code).toBe(0);
    expect(JSON.parse(aggregate.out).totals).toEqual({ total: 1, known: 0, absent: 1 });
    expect(aggregate.out).not.toContain("TOP_SECRET");
    expect(aggregate.out).not.toContain("private");
    expect(run(["feedback", "remove", recordId, "--root", repository, "--json"]).code).toBe(0);
    expect(JSON.parse(run(["feedback", "list", "--root", repository, "--json"]).out).records).toEqual([]);
  });
});
