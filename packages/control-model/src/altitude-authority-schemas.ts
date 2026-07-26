/** Boundary schema for the required-altitude authority contract. */

import { z } from "zod";
import {
  ALTITUDE_AUTHORITY_OBLIGATION_ORDER,
  ALTITUDE_AUTHORITY_POLICY_V1,
  ALTITUDE_AUTHORITY_REGIME_ORDER,
} from "./altitude-authority";

export const AltitudeAuthorityRegimeV1Schema = z.enum(ALTITUDE_AUTHORITY_REGIME_ORDER);
export const AltitudeAuthorityObligationV1Schema = z.enum(ALTITUDE_AUTHORITY_OBLIGATION_ORDER);

const RequiredAltitudeSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3),
  z.literal(4), z.literal(5), z.literal(6),
]);

export const AltitudeAuthorityReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("altitude_authority"),
  executionAuthority: z.literal("none"),
  requiredAltitude: RequiredAltitudeSchema,
  regime: AltitudeAuthorityRegimeV1Schema,
  obligations: z.array(AltitudeAuthorityObligationV1Schema),
  rationale: z.string().min(1),
  allowsAutonomousWrite: z.boolean(),
  freshness: z.object({
    verdict: z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]),
    canRunHighRiskControl: z.boolean(),
  }).strict(),
  reasons: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  const rule = ALTITUDE_AUTHORITY_POLICY_V1[value.requiredAltitude];
  if (value.regime !== rule.regime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["regime"],
      message: "regime contradicts the policy for this required altitude",
    });
  }
  if (
    value.obligations.length !== rule.obligations.length
    || value.obligations.some((obligation, index) => obligation !== rule.obligations[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["obligations"],
      message: "obligations must match the policy for this required altitude, in canonical order",
    });
  }
  // Autonomy is the conjunction of an autonomous regime and inputs the control plane trusts.
  const autonomous = value.regime === "autonomous" && value.freshness.canRunHighRiskControl;
  if (value.allowsAutonomousWrite !== autonomous) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowsAutonomousWrite"],
      message: "autonomous write requires both the autonomous regime and trusted freshness",
    });
  }
  if (value.reasons.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "a report must state its reasons" });
  }
  if (new Set(value.reasons).size !== value.reasons.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "reasons must be unique" });
  }
});
