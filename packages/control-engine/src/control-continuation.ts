import {
  CONTROL_CONTINUATION_DEPENDENCY_KINDS,
  type ControlContinuationClosedReasonV1,
  type ControlContinuationDependencyDecisionV1,
  type ControlContinuationDependencyKindV1,
  type ControlContinuationDependencyScopeV1,
  type ControlContinuationProvenanceV1,
} from "@semantic-context/control-model/control-continuation";

/**
 * Pure, explicit dependency fixture. `matchRequired` compares `baselineRef` against
 * `currentRef`; `forceUnknown` always yields UNKNOWN regardless of the refs. Callers
 * (app-services) construct fixtures from observed facts; this module never reads or
 * infers anything itself.
 */
export interface ControlContinuationDependencyFixtureV1 {
  obligation: string;
  scope: ControlContinuationDependencyScopeV1;
  dependencyKind: ControlContinuationDependencyKindV1;
  baselineRef: string | null;
  currentRef: string | null;
  provenance: ControlContinuationProvenanceV1;
  comparison: "match_required" | "always_unknown";
  /** Required when comparison is "always_unknown", or used when currentRef is unreadable. */
  unknownReason?: ControlContinuationClosedReasonV1;
  /** Used when baselineRef and currentRef are both present but differ. Defaults to CHANGED. */
  changedReason?: ControlContinuationClosedReasonV1;
}

/**
 * Compare one explicit dependency fixture to one deterministic decision. Never performs I/O
 * and never invents a fixture; the caller supplies every baseline/current reference.
 */
export function compareControlContinuationDependencyV1(
  fixture: ControlContinuationDependencyFixtureV1,
): ControlContinuationDependencyDecisionV1 {
  const base = {
    obligation: fixture.obligation,
    scope: fixture.scope,
    dependencyKind: fixture.dependencyKind,
    baselineRef: fixture.baselineRef,
    currentRef: fixture.currentRef,
    provenance: fixture.provenance,
  };
  if (fixture.comparison === "always_unknown") {
    return {
      ...base,
      status: "UNKNOWN",
      closedReason: fixture.unknownReason ?? "DEPENDENCY_UNVERIFIED",
    };
  }
  if (fixture.currentRef === null) {
    return {
      ...base,
      status: "UNKNOWN",
      closedReason: fixture.unknownReason ?? "DEPENDENCY_UNREADABLE",
    };
  }
  if (fixture.baselineRef === fixture.currentRef) {
    return { ...base, status: "APPLICABLE", closedReason: "MATCH" };
  }
  return { ...base, status: "STALE", closedReason: fixture.changedReason ?? "CHANGED" };
}

/**
 * Compare every supplied dependency fixture and return decisions in the fixed, canonical
 * `dependencyKind` order. Fixtures must use unique dependency kinds.
 */
export function compareControlContinuationDependenciesV1(
  fixtures: readonly ControlContinuationDependencyFixtureV1[],
): readonly ControlContinuationDependencyDecisionV1[] {
  return [...fixtures]
    .sort((left, right) =>
      CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(left.dependencyKind)
      - CONTROL_CONTINUATION_DEPENDENCY_KINDS.indexOf(right.dependencyKind)
    )
    .map(compareControlContinuationDependencyV1);
}
