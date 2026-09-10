import { describe, expect, test } from "bun:test";
import {
  SupportReportSchema,
  VerifyReportSchema,
  FeedbackStoreFileSchema,
  buildFeedbackAggregateExport,
  buildFeedbackRecord,
  canonicalJson,
  type VerifyReport,
} from "../src";

function report(rule = "custom secret rule /private/repo"): VerifyReport {
  return {
    schemaVersion: 1,
    verdict: "WARN",
    base: "base-secret",
    head: "head-secret",
    mergeBase: "merge-secret",
    range: "base-secret..head-secret",
    changedFiles: ["relative/private.ts"],
    changedSymbols: [],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings: [{
      rule,
      tier: "advisory",
      severity: "warn",
      message: "token=TOP_SECRET",
      nodeIds: ["private-node"],
      locations: [{ file: "relative/private.ts", line: 7 }],
    }],
    summary: { blockCount: 0, warnCount: 1 },
  };
}

describe("local report schemas and projections", () => {
  test("prototype-named additive fields remain part of feedback identity", () => {
    const firstExtension = JSON.parse('{"__proto__":{"value":1}}');
    const secondExtension = JSON.parse('{"__proto__":{"value":2}}');
    expect(canonicalJson(firstExtension)).toBe('{"__proto__":{"value":1}}');
    const build = (extension: unknown) => buildFeedbackRecord({
      report: VerifyReportSchema.parse({ ...report(), extension }),
      findingIndex: 0, outcome: "useful", now: "2026-09-08T00:00:00.000Z",
    });
    const first = build(firstExtension);
    const second = build(secondExtension);
    if (first.status !== "ok" || second.status !== "ok") throw new Error("fixture finding missing");
    expect(first.record.report.contentDigest).not.toBe(second.record.report.contentDigest);
    expect(first.record.recordId).not.toBe(second.record.recordId);
  });

  test("loaded feedback records must retain their derived content identity", () => {
    const built = buildFeedbackRecord({ report: report(), findingIndex: 0, outcome: "useful", now: "2026-09-08T00:00:00.000Z" });
    if (built.status !== "ok") throw new Error("fixture finding missing");
    expect(FeedbackStoreFileSchema.safeParse({ schemaVersion: 1, records: [built.record] }).success).toBe(true);
    const forged = { ...built.record, recordId: `fb:${"0".repeat(64)}` };
    expect(FeedbackStoreFileSchema.safeParse({ schemaVersion: 1, records: [forged] }).success).toBe(false);
  });
  test("feedback aggregate never exports report, path, custom rule, or note data", () => {
    const built = buildFeedbackRecord({
      report: report(),
      findingIndex: 0,
      outcome: "suspected-error",
      reason: "false-positive",
      note: "TOP_SECRET C:\\private\\repo",
      now: "2026-09-08T00:00:00.000Z",
    });
    if (built.status !== "ok") throw new Error("fixture finding missing");
    const aggregate = buildFeedbackAggregateExport([built.record], "2026-09-08T01:00:00.000Z");
    const serialized = JSON.stringify(aggregate);
    expect(aggregate.totals).toEqual({ total: 1, known: 0, absent: 1 });
    expect(aggregate.byRuleOutcome).toEqual([{ rule: "other", outcome: "suspected-error", count: 1 }]);
    expect(serialized).not.toContain("TOP_SECRET");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("base-secret");
  });

  test("changed report or finding content produces a distinct identity", () => {
    const first = buildFeedbackRecord({ report: report("CONFIG_NOT_FOUND"), findingIndex: 0, outcome: "useful", now: "2026-09-08T00:00:00.000Z" });
    const changed = report("CONFIG_NOT_FOUND");
    changed.findings[0]!.message = "different observed content";
    const second = buildFeedbackRecord({ report: changed, findingIndex: 0, outcome: "useful", now: "2026-09-08T00:00:00.000Z" });
    if (first.status !== "ok" || second.status !== "ok") throw new Error("fixture finding missing");
    expect(first.record.recordId).not.toBe(second.record.recordId);
    expect(first.record.report.contentDigest).not.toBe(second.record.report.contentDigest);
    expect(first.record.recordId).toMatch(/^fb:[a-f0-9]{64}$/);
  });

  test("verify v1 accepts additive fields; support metadata stays closed and safe", () => {
    const additive = VerifyReportSchema.parse({ ...report(), futureField: "private-future-data" });
    expect(additive["futureField"]).toBe("private-future-data");
    const record = buildFeedbackRecord({ report: additive, findingIndex: 0, outcome: "useful", now: "2026-09-08T00:00:00.000Z" });
    if (record.status !== "ok") throw new Error("fixture missing finding");
    expect(JSON.stringify(buildFeedbackAggregateExport([record.record], "2026-09-08T00:00:00.000Z"))).not.toContain("private-future-data");
    expect(VerifyReportSchema.safeParse({ ...report(), schemaVersion: 2 }).success).toBe(false);
    expect(SupportReportSchema.safeParse({
      schemaVersion: 1,
      kind: "support_report",
      observedAt: "2026-09-08T00:00:00.000Z",
      semctxVersion: "0.2.0/private/path",
      bunVersion: "1.4.0",
      platform: "win32",
      arch: "x64",
      workspace: { status: "unknown", reasons: [] },
      index: { status: "unknown", reasons: [] },
    }).success).toBe(false);
  });
});
