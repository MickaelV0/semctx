import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyReport } from "@semantic-context/core";
import { feedbackFilePath } from "@semantic-context/repository-store";
import {
  buildSupportReport,
  exportFeedbackAggregate,
  listFeedback,
  recordFeedback,
  removeFeedback,
  showFeedback,
  updateFeedback,
} from "../src";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "semctx-local-reports-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function report(message = "original"): VerifyReport {
  return {
    schemaVersion: 1,
    verdict: "WARN",
    base: null,
    head: "HEAD",
    mergeBase: null,
    range: null,
    changedFiles: ["private/source.ts"],
    changedSymbols: [], impactedContracts: [], impactedInvariants: [], recommendedTests: [], contradictions: [], unknowns: [],
    findings: [{ rule: "CONFIG_NOT_FOUND", tier: "advisory", severity: "warn", message, nodeIds: [], locations: [] }],
    summary: { blockCount: 0, warnCount: 1 },
  };
}

describe("feedback application service", () => {
  test("record is idempotent, conflict needs update, and exact removal preserves peers", () => {
    const repository = root();
    const clock = () => "2026-09-08T00:00:00.000Z";
    const first = recordFeedback(repository, clock, { report: report(), findingIndex: 0, outcome: "useful", note: "private" });
    expect(first.status).toBe("recorded");
    if (first.status === "conflict") throw new Error("unexpected conflict");
    expect(recordFeedback(repository, clock, { report: report(), findingIndex: 0, outcome: "useful", note: "private" }).status).toBe("unchanged");
    expect(recordFeedback(repository, clock, { report: report(), findingIndex: 0, outcome: "ignored" }).status).toBe("conflict");
    const second = recordFeedback(repository, clock, { report: report("second"), findingIndex: 0, outcome: "unclear" });
    if (second.status === "conflict") throw new Error("unexpected conflict");
    expect(updateFeedback(repository, () => "2026-09-09T00:00:00.000Z", first.record.recordId, { outcome: "ignored" }).outcome).toBe("ignored");
    expect(showFeedback(repository, second.record.recordId).outcome).toBe("unclear");
    removeFeedback(repository, first.record.recordId);
    expect(listFeedback(repository).map((item) => item.recordId)).toEqual([second.record.recordId]);
  });

  test("invalid finding and corrupted store fail without repair", () => {
    const repository = root();
    expect(() => recordFeedback(repository, () => "2026-09-08T00:00:00.000Z", { report: report(), findingIndex: 2, outcome: "useful" })).toThrow("no finding");
    recordFeedback(repository, () => "2026-09-08T00:00:00.000Z", { report: report(), findingIndex: 0, outcome: "useful" });
    writeFileSync(feedbackFilePath(repository), "{broken");
    expect(() => listFeedback(repository)).toThrow("malformed");
    expect(() => exportFeedbackAggregate(repository, () => "2026-09-08T00:00:00.000Z")).toThrow("malformed");
  });
});

describe("support application service", () => {
  test("an uninitialized repository remains unknown with no state writes", () => {
    const repository = root();
    const result = buildSupportReport(repository, {
      semctxVersion: "0.2.0", bunVersion: "1.4.0", platform: "win32", arch: "x64",
      now: () => "2026-09-08T00:00:00.000Z",
    });
    expect(result.workspace).toEqual({ status: "unknown", reasons: ["WORKSPACE_NOT_INITIALIZED"] });
    expect(result.index.status).toBe("unknown");
    expect(existsSync(join(repository, ".semctx"))).toBe(false);
  });
});
