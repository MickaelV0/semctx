/**
 * Required-altitude authority policy: the single canonical rule that turns a change's
 * abstraction altitude into the authority an agent holds over it.
 *
 * Hosts (Codex, Claude Code) must derive their behaviour from this contract rather than
 * restating it, so the same sealed task yields the same regime everywhere. The policy is
 * descriptive: it reports which authority is required, and never grants execution.
 */

/** Authority regimes, ordered from least to most constrained. */
export const ALTITUDE_AUTHORITY_REGIME_ORDER = [
  "autonomous",
  "constrained",
  "reviewed_plan",
  "human_authority",
] as const;

export type AltitudeAuthorityRegimeV1 = (typeof ALTITUDE_AUTHORITY_REGIME_ORDER)[number];

/** Obligations a regime places on the agent before an eligible write. */
export const ALTITUDE_AUTHORITY_OBLIGATION_ORDER = [
  "preflight_fresh_inputs",
  "bound_repository_scope",
  "reviewed_refinement_plan",
  "declared_rollback",
  "explicit_human_authority",
] as const;

export type AltitudeAuthorityObligationV1 = (typeof ALTITUDE_AUTHORITY_OBLIGATION_ORDER)[number];

/**
 * The policy table. Levels follow the L0-L6 ontology: L0 syntax/hunks, L1 symbols/tests/schemas,
 * L2 components/boundaries, L3 capabilities, L4 invariants/policies, L5 product intent,
 * L6 strategy/constraints.
 */
export interface AltitudeAuthorityRuleV1 {
  readonly regime: AltitudeAuthorityRegimeV1;
  readonly obligations: readonly AltitudeAuthorityObligationV1[];
  /** Why this altitude carries this regime, in the contract's own vocabulary. */
  readonly rationale: string;
}

const AUTONOMOUS: AltitudeAuthorityRuleV1 = {
  regime: "autonomous",
  obligations: ["preflight_fresh_inputs"],
  rationale: "Syntax and symbol-level edits stay inside an already-authorized contract.",
};

const CONSTRAINED: AltitudeAuthorityRuleV1 = {
  regime: "constrained",
  obligations: ["preflight_fresh_inputs", "bound_repository_scope"],
  rationale: "Component and boundary edits may move responsibility, so scope must be bound first.",
};

const REVIEWED_PLAN: AltitudeAuthorityRuleV1 = {
  regime: "reviewed_plan",
  obligations: ["preflight_fresh_inputs", "bound_repository_scope", "reviewed_refinement_plan", "declared_rollback"],
  rationale: "Capability changes alter what the system offers, which needs a reviewed plan and a way back.",
};

const HUMAN_AUTHORITY: AltitudeAuthorityRuleV1 = {
  regime: "human_authority",
  obligations: [
    "preflight_fresh_inputs",
    "bound_repository_scope",
    "reviewed_refinement_plan",
    "declared_rollback",
    "explicit_human_authority",
  ],
  rationale: "Invariants, product intent and strategy are authored truths; only a human may retarget them.",
};

/** Indexed by required altitude L0-L6. Total by construction — every level has a regime. */
export const ALTITUDE_AUTHORITY_POLICY_V1: {
  readonly [Level in 0 | 1 | 2 | 3 | 4 | 5 | 6]: AltitudeAuthorityRuleV1;
} = {
  0: AUTONOMOUS,
  1: AUTONOMOUS,
  2: CONSTRAINED,
  3: REVIEWED_PLAN,
  4: HUMAN_AUTHORITY,
  5: HUMAN_AUTHORITY,
  6: HUMAN_AUTHORITY,
};

/** Rank a regime for comparison; higher means more constrained. */
export function altitudeAuthorityRegimeRank(regime: AltitudeAuthorityRegimeV1): number {
  return ALTITUDE_AUTHORITY_REGIME_ORDER.indexOf(regime);
}

/**
 * A versioned report binding a change's altitude to its authority regime.
 *
 * `executionAuthority` is `"none"` like every other Plane C artifact: naming the authority a
 * change requires is not the same as holding it. `satisfied` is left to the caller's evidence —
 * the policy states obligations, it does not observe them.
 */
export interface AltitudeAuthorityReportV1 {
  schemaVersion: 1;
  kind: "altitude_authority";
  executionAuthority: "none";
  requiredAltitude: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  regime: AltitudeAuthorityRegimeV1;
  obligations: readonly AltitudeAuthorityObligationV1[];
  rationale: string;
  /** True only for the autonomous regime: an agent may write without further authority. */
  allowsAutonomousWrite: boolean;
  /** Freshness verdict the report was computed under; non-fresh inputs never grant autonomy. */
  freshness: {
    verdict: "FRESH" | "DIRTY_KNOWN" | "STALE" | "UNSEALED";
    canRunHighRiskControl: boolean;
  };
  reasons: readonly string[];
}
