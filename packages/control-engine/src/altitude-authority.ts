/**
 * Decide the authority regime a change requires from its altitude and the freshness of the
 * inputs the decision rests on. Pure: same inputs, same report, no repository access.
 */

import {
  ALTITUDE_AUTHORITY_POLICY_V1,
  AltitudeAuthorityReportV1Schema,
  type AltitudeAuthorityReportV1,
  type ControlFreshnessStatusReport,
} from "@semantic-context/control-model";

export interface AltitudeAuthorityInput {
  requiredAltitude: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  freshness: Pick<ControlFreshnessStatusReport, "verdict" | "canRunHighRiskControl">;
}

/**
 * Report the authority a change at `requiredAltitude` demands.
 *
 * Autonomy is a conjunction, never an inheritance: the regime must be autonomous *and* the
 * control plane must trust its inputs. A stale or unsealed preflight therefore withdraws
 * autonomous write at every altitude, including L0 — the policy cannot be more confident than
 * the state it was computed from.
 */
export function decideAltitudeAuthority(input: AltitudeAuthorityInput): AltitudeAuthorityReportV1 {
  const rule = ALTITUDE_AUTHORITY_POLICY_V1[input.requiredAltitude];
  const trustedInputs = input.freshness.canRunHighRiskControl;
  const allowsAutonomousWrite = rule.regime === "autonomous" && trustedInputs;

  const reasons = [
    `required_altitude:L${input.requiredAltitude}`,
    `policy_regime:${rule.regime}`,
    `freshness_verdict:${input.freshness.verdict}`,
  ];
  if (rule.regime !== "autonomous") {
    reasons.push(`autonomous_write_withheld:regime:${rule.regime}`);
  }
  if (!trustedInputs) {
    reasons.push(`autonomous_write_withheld:freshness:${input.freshness.verdict}`);
  }

  return AltitudeAuthorityReportV1Schema.parse({
    schemaVersion: 1,
    kind: "altitude_authority",
    executionAuthority: "none",
    requiredAltitude: input.requiredAltitude,
    regime: rule.regime,
    obligations: [...rule.obligations],
    rationale: rule.rationale,
    allowsAutonomousWrite,
    freshness: {
      verdict: input.freshness.verdict,
      canRunHighRiskControl: trustedInputs,
    },
    reasons,
  }) as AltitudeAuthorityReportV1;
}
