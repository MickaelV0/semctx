import { describe, expect, test } from "bun:test";
import {
  FeedbackStoreFileSchema,
  SupportReportSchema,
  buildFeedbackRecord,
  type VerifyReport,
} from "../src";

function report(): VerifyReport {
  return {
    schemaVersion: 1,
    verdict: "WARN",
    base: "base-a",
    head: "head-a",
    mergeBase: "base-a",
    range: "base-a..head-a",
    changedFiles: ["src/a.ts"],
    changedSymbols: [],
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings: [{
      rule: "CONFIG_NOT_FOUND",
      tier: "advisory",
      severity: "warn",
      message: "missing configuration",
      nodeIds: [],
      locations: [],
    }],
    summary: { blockCount: 0, warnCount: 1 },
  };
}

function record() {
  const result = buildFeedbackRecord({
    report: report(),
    findingIndex: 0,
    outcome: "useful",
    now: "2026-09-08T00:00:00.000Z",
  });
  if (result.status !== "ok") throw new Error("fixture finding missing");
  return result.record;
}

describe("local report integrity regressions", () => {
  test("feedback identity binds the observed source scope", () => {
    const original = record();
    const altered = { ...original, source: { ...original.source, head: "unrelated-head" } };

    expect(FeedbackStoreFileSchema.safeParse({ schemaVersion: 1, records: [original] }).success).toBe(true);
    expect(FeedbackStoreFileSchema.safeParse({ schemaVersion: 1, records: [altered] }).success).toBe(false);
  });

  test("feedback chronology rejects updates before the original recording", () => {
    const original = record();
    const reversed = { ...original, updatedAt: "2026-09-07T00:00:00.000Z" };

    expect(FeedbackStoreFileSchema.safeParse({ schemaVersion: 1, records: [reversed] }).success).toBe(false);
  });

  test("support reports accept SemVer prerelease and build metadata together", () => {
    const parsed = SupportReportSchema.safeParse({
      schemaVersion: 1,
      kind: "support_report",
      observedAt: "2026-09-08T00:00:00.000Z",
      semctxVersion: "0.2.0-rc.1+build.7",
      bunVersion: "1.4.0-canary.2+git.abc123",
      platform: "win32",
      arch: "x64",
      workspace: { status: "healthy", reasons: [] },
      index: { status: "healthy", reasons: [] },
    });

    expect(parsed.success).toBe(true);
  });
});
