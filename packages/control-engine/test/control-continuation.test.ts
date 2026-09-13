import { describe, expect, it } from "bun:test";
import {
  compareControlContinuationDependenciesV1,
  compareControlContinuationDependencyV1,
  type ControlContinuationDependencyFixtureV1,
} from "../src/control-continuation";

function fixture(
  overrides: Partial<ControlContinuationDependencyFixtureV1> = {},
): ControlContinuationDependencyFixtureV1 {
  return {
    obligation: "source_commit_binding",
    scope: "repository",
    dependencyKind: "source_commit",
    baselineRef: "commit-a",
    currentRef: "commit-a",
    provenance: "historically_observed",
    comparison: "match_required",
    ...overrides,
  };
}

describe("Control Continuation v1 pure comparison", () => {
  it("matches identical baseline and current refs", () => {
    expect(compareControlContinuationDependencyV1(fixture())).toMatchObject({
      status: "APPLICABLE",
      closedReason: "MATCH",
    });
  });

  it("reports STALE with the configured changedReason on mismatch", () => {
    expect(compareControlContinuationDependencyV1(fixture({
      currentRef: "commit-b",
      changedReason: "CURRENT_STATE_CHANGED",
    }))).toMatchObject({ status: "STALE", closedReason: "CURRENT_STATE_CHANGED" });
  });

  it("defaults the changedReason to CHANGED", () => {
    expect(compareControlContinuationDependencyV1(fixture({ currentRef: "commit-b" })))
      .toMatchObject({ status: "STALE", closedReason: "CHANGED" });
  });

  it("reports UNKNOWN when currentRef is unreadable", () => {
    expect(compareControlContinuationDependencyV1(fixture({
      currentRef: null,
      unknownReason: "DEPENDENCY_UNREADABLE",
    }))).toMatchObject({ status: "UNKNOWN", closedReason: "DEPENDENCY_UNREADABLE" });
  });

  it("defaults the unknownReason to DEPENDENCY_UNREADABLE when currentRef is unreadable", () => {
    expect(compareControlContinuationDependencyV1(fixture({ currentRef: null })))
      .toMatchObject({ status: "UNKNOWN", closedReason: "DEPENDENCY_UNREADABLE" });
  });

  it("forces UNKNOWN for always_unknown fixtures even when refs would otherwise match", () => {
    expect(compareControlContinuationDependencyV1(fixture({
      comparison: "always_unknown",
      unknownReason: "DEPENDENCY_UNVERIFIED",
    }))).toMatchObject({ status: "UNKNOWN", closedReason: "DEPENDENCY_UNVERIFIED" });
  });

  it("never upgrades a losing/unreadable dependency into APPLICABLE regardless of baselineRef", () => {
    // A hostile fixture that supplies matching refs but declares always_unknown must still
    // never certify reuse; UNKNOWN never becomes a favorable admission.
    const hostile = fixture({
      baselineRef: "same",
      currentRef: "same",
      comparison: "always_unknown",
    });
    const decision = compareControlContinuationDependencyV1(hostile);
    expect(decision.status).not.toBe("APPLICABLE");
  });

  it("orders decisions by the fixed dependencyKind order regardless of input order", () => {
    const decisions = compareControlContinuationDependenciesV1([
      fixture({ dependencyKind: "expiry", scope: "evidence" }),
      fixture({ dependencyKind: "repository_identity" }),
      fixture({ dependencyKind: "diff" }),
    ]);
    expect(decisions.map((decision) => decision.dependencyKind)).toEqual([
      "repository_identity",
      "diff",
      "expiry",
    ]);
  });
});
