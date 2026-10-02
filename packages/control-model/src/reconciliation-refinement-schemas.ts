import { z } from "zod";
import { computeRefinementRelationDigest } from "./hashing";
import { compareCodeUnits } from "./ordering";
import { Sha256HashSchema } from "./primitive-schemas";
import type {
  EvidenceRefV1,
  RefinementRelationV1,
} from "./refinement";

export const ReconciliationEpistemicStatuses = [
  "human_declared",
  "statically_observed",
  "dynamically_observed",
  "test_observed",
  "historically_observed",
  "llm_inferred",
  "hypothetical",
] as const;

export const ReconciliationRelationProvenanceV1Schema = z.enum([
  "author",
  "agent",
  "derived",
]);

export const ReconciliationRefinementRelationKindV1Schema = z.enum([
  "decomposes_to",
  "realizes",
  "implements",
  "constrained_by",
  "proved_by",
]);

export const ReconciliationEvidenceKindV1Schema = z.enum([
  "semantic_node",
  "observed_diff_hunk",
  "document_span",
  "test_result",
  "commit",
]);

export const ReconciliationSha256DigestV1Schema = z.object({
  algorithm: z.literal("sha256"),
  value: z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase sha256 hex characters"),
}).strict();

export const ReconciliationEvidenceRefV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: ReconciliationEvidenceKindV1Schema,
  locator: z.string().min(1),
  digest: ReconciliationSha256DigestV1Schema,
}).strict();

export const ReconciliationRelationEndpointV1Schema = z.discriminatedUnion("plane", [
  z.object({
    plane: z.literal("B"),
    kind: z.literal("semantic_node"),
    nodeId: z.string().min(1),
  }).strict(),
  z.object({
    plane: z.literal("A"),
    kind: z.literal("observed_diff_hunk"),
    coordinateDigest: Sha256HashSchema,
  }).strict(),
]);

export const ReconciliationRefinementRelationV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  kind: ReconciliationRefinementRelationKindV1Schema,
  source: ReconciliationRelationEndpointV1Schema,
  target: ReconciliationRelationEndpointV1Schema,
  epistemicStatus: z.enum(ReconciliationEpistemicStatuses),
  provenance: ReconciliationRelationProvenanceV1Schema,
  evidenceRefs: z.array(ReconciliationEvidenceRefV1Schema).min(1),
  relationDigest: Sha256HashSchema.optional(),
}).strict().superRefine((value, context) => {
  const keys = value.evidenceRefs.map(evidenceKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceRefs"],
      message: "values must be unique",
    });
  }
  const sorted = [...keys].sort(compareCodeUnits);
  if (keys.some((key, index) => key !== sorted[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceRefs"],
      message: "values must use canonical ASCII order",
    });
  }
  if (
    value.relationDigest !== undefined
    && computeRefinementRelationDigest(value)
      !== value.relationDigest
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relationDigest"],
      message: "relation digest mismatch",
    });
  }
}) satisfies z.ZodType<RefinementRelationV1>;

function evidenceKey(evidence: EvidenceRefV1): string {
  return `${evidence.kind}\0${evidence.locator}\0${evidence.digest.value}`;
}
