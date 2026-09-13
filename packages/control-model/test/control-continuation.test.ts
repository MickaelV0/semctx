import { describe, expect, it } from "bun:test";
import {
  CONTROL_CONTINUATION_DEPENDENCY_KINDS,
  ControlContinuationDependencyDecisionV1Schema,
  ControlContinuationExplainResultV1Schema,
  ControlContinuationReportV1Schema,
  computeControlContinuationReportV1Hash,
  type ControlContinuationDependencyDecisionV1,
  type ControlContinuationReportV1,
} from "@semantic-context/control-model/control-continuation";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;

function dependency(
  overrides: Partial<ControlContinuationDependencyDecisionV1> = {},
): ControlContinuationDependencyDecisionV1 {
  return {
    obligation: "repository_identity_binding",
    scope: "repository",
    dependencyKind: "repository_identity",
    baselineRef: "repo:sample",
    currentRef: "repo:sample",
    provenance: "historically_observed",
    status: "APPLICABLE",
    closedReason: "MATCH",
    ...overrides,
  };
}

function allDependencies(): ControlContinuationDependencyDecisionV1[] {
  return [
    dependency(),
    dependency({
      obligation: "worktree_identity_binding",
      dependencyKind: "worktree_identity",
      baselineRef: null,
      currentRef: null,
      status: "UNKNOWN",
      closedReason: "DEPENDENCY_UNVERIFIED",
    }),
    dependency({
      obligation: "source_commit_binding",
      dependencyKind: "source_commit",
      baselineRef: "commit-a",
      currentRef: "commit-b",
      status: "STALE",
      closedReason: "CHANGED",
    }),
    dependency({
      obligation: "diff_binding",
      dependencyKind: "diff",
      baselineRef: hashA,
      currentRef: hashA,
      status: "APPLICABLE",
      closedReason: "MATCH",
    }),
    dependency({
      obligation: "semantic_index_input_binding",
      dependencyKind: "semantic_index_inputs",
      baselineRef: hashA,
      currentRef: null,
      status: "UNKNOWN",
      closedReason: "DEPENDENCY_UNVERIFIED",
    }),
    ...(["producer_tool", "configuration", "environment", "policy", "expiry"] as const).map(
      (dependencyKind) =>
        dependency({
          obligation: `evidence_${dependencyKind}_binding`,
          scope: "evidence",
          dependencyKind,
          baselineRef: null,
          currentRef: null,
          provenance: "declared",
          status: "UNKNOWN",
          closedReason: "DEPENDENCY_MISSING",
        }),
    ),
  ];
}

function reportPayload(): Omit<ControlContinuationReportV1, "reportHash"> {
  return {
    schemaVersion: 1,
    kind: "control_continuation_report",
    executionAuthority: "none",
    enforcementMode: "shadow",
    blockingEnabled: false,
    sourceContentCollected: false,
    gateAdmission: "NOT_EVALUATED",
    requestedCapsuleHash: hashA,
    historicalSource: {
      repositoryIdentity: "repo:sample",
      observedCommit: "commit-a",
      observedWorkingDiffHash: hashA,
      planningCommit: "commit-a",
      planningBundleHash: hashB,
      envelopeHash: hashB,
      changeSetHash: hashB,
      baselineFreshnessSealHash: hashA,
    },
    currentCapture: {
      repositoryIdentity: "repo:sample",
      headCommit: "commit-b",
      workingDiffHash: hashA,
      indexFreshnessVerdict: "FRESH",
      currentFreshnessSealHash: null,
    },
    captureTime: "2026-09-13T00:00:00.000Z",
    completeness: "complete",
    sections: {
      objective: [],
      declaredDecisions: [],
      declaredNonGoals: [],
      expectedChanges: [],
      observedChanges: [],
      risks: [],
      missingEvidence: [],
      nextChecks: [{
        text: "run verify_change",
        provenance: "historically_observed",
        sourceArtifactHash: hashA,
        sourceField: "capsule.nextValidTransition.kind",
      }],
    },
    dependencies: allDependencies(),
    omittedSectionCounts: {
      objective: 0,
      declaredDecisions: 0,
      declaredNonGoals: 0,
      expectedChanges: 0,
      observedChanges: 0,
      risks: 0,
      missingEvidence: 0,
      nextChecks: 0,
    },
  };
}

function report(): ControlContinuationReportV1 {
  const payload = reportPayload();
  return { ...payload, reportHash: computeControlContinuationReportV1Hash(payload) };
}

describe("Control Continuation v1 model", () => {
  it("accepts a well-formed, canonically ordered report", () => {
    expect(ControlContinuationReportV1Schema.safeParse(report()).success).toBe(true);
  });

  it("orders dependencies by the fixed dependencyKind order", () => {
    const value = report();
    const kinds = value.dependencies.map((dependency) => dependency.dependencyKind);
    expect(kinds).toEqual([...kinds].sort(
      (left, right) =>
        CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(left)
        - CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(right),
    ));
  });

  it("rejects a tampered reportHash", () => {
    const value = { ...report(), reportHash: `sha256:${"0".repeat(64)}` as const };
    expect(ControlContinuationReportV1Schema.safeParse(value).success).toBe(false);
  });

  it("excludes captureTime from the reportHash domain", () => {
    const payload = reportPayload();
    const hashAtOneTime = computeControlContinuationReportV1Hash(payload);
    const hashAtAnotherTime = computeControlContinuationReportV1Hash({
      ...payload,
      captureTime: "2030-01-01T00:00:00.000Z",
    });
    expect(hashAtOneTime).toBe(hashAtAnotherTime);
  });

  it("rejects out-of-order dependencies", () => {
    const value = report();
    const scrambled = { ...value, dependencies: [...value.dependencies].reverse() };
    expect(ControlContinuationReportV1Schema.safeParse(scrambled).success).toBe(false);
  });

  it("rejects an APPLICABLE dependency whose refs disagree", () => {
    expect(ControlContinuationDependencyDecisionV1Schema.safeParse(
      dependency({ baselineRef: "a", currentRef: "b", status: "APPLICABLE", closedReason: "MATCH" }),
    ).success).toBe(false);
  });

  it("rejects a report-only closed reason at the dependency level", () => {
    expect(ControlContinuationDependencyDecisionV1Schema.safeParse(
      dependency({ status: "UNKNOWN", closedReason: "ARTIFACT_MISSING" }),
    ).success).toBe(false);
  });

  it("rejects a report that silently drops a canonical dependency kind", () => {
    const value = report();
    const dropped = { ...value, dependencies: [dependency()] };
    expect(ControlContinuationReportV1Schema.safeParse(dropped).success).toBe(false);
  });

  it("requires EXPLAINED results to carry a report and no reasonCode", () => {
    expect(ControlContinuationExplainResultV1Schema.safeParse({
      schemaVersion: 1,
      kind: "control_continuation_result",
      operation: "explain",
      status: "EXPLAINED",
      reasonCode: "ARTIFACT_MISSING",
      report: report(),
    }).success).toBe(false);

    expect(ControlContinuationExplainResultV1Schema.safeParse({
      schemaVersion: 1,
      kind: "control_continuation_result",
      operation: "explain",
      status: "EXPLAINED",
      reasonCode: null,
      report: report(),
    }).success).toBe(true);
  });

  it("requires REFUSED results to carry a reasonCode and no report", () => {
    expect(ControlContinuationExplainResultV1Schema.safeParse({
      schemaVersion: 1,
      kind: "control_continuation_result",
      operation: "explain",
      status: "REFUSED",
      reasonCode: "ARTIFACT_MISSING",
      report: null,
    }).success).toBe(true);

    expect(ControlContinuationExplainResultV1Schema.safeParse({
      schemaVersion: 1,
      kind: "control_continuation_result",
      operation: "explain",
      status: "REFUSED",
      reasonCode: null,
      report: null,
    }).success).toBe(false);
  });
});
