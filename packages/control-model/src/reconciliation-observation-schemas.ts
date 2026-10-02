import { z } from "zod";
import { createObservedDiffHunkV1 } from "./hashing";
import { UnresolvedRepositoryLinkSchema } from "./link-resolution";
import { compareCodeUnits } from "./ordering";
import {
  CoordinateCategorySchema,
  CoordinateEdgeSchema,
  DanglingSemanticReferenceSchema,
  EpistemicStatusSchema,
  QualifiedCoordinateIdSchema,
  SemanticLevelSchema,
  Sha256HashSchema,
  SourceKindLevelMappingSchema,
  UnsupportedCoordinateSourceSchema,
  UnmappedCoordinateSourceSchema,
} from "./primitive-schemas";
import { ReconciliationRefinementRelationV1Schema } from "./reconciliation-refinement-schemas";
import type {
  CompatibilityNormalizationNoteV1,
  CoordinateGraphReportV2,
  CoordinateNodeV2,
  LevelCoverageV2,
  ObservedDiffHunkV1,
  ObservedDiffRangeV1,
} from "./refinement";
import type { SemanticLevel } from "./types";

// The shared numeric schema enforces the complete integer 0..6 predicate before applying the brand.
const ReconciliationSemanticLevelSchema = SemanticLevelSchema as z.ZodType<SemanticLevel>;

export const ReconciliationObservedDiffRangeV1Schema = z.object({
  start: z.number().int().min(0).max(0xffff_ffff),
  lines: z.number().int().min(0).max(0xffff_ffff),
}).strict() satisfies z.ZodType<ObservedDiffRangeV1>;

export const ReconciliationObservedDiffHunkV1Schema = z.object({
  schemaVersion: z.literal(1),
  repositoryIdentity: z.string().min(1),
  normalizedPath: z.string().min(1),
  oldRange: ReconciliationObservedDiffRangeV1Schema,
  newRange: ReconciliationObservedDiffRangeV1Schema,
  oldBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  newBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  rawHunkBytes: z.instanceof(Uint8Array),
  identity: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  try {
    const canonical = createObservedDiffHunkV1(value);
    if (canonical.identity !== value.identity) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "observed hunk identity mismatch" });
    }
    if (canonical.normalizedPath !== value.normalizedPath) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["normalizedPath"], message: "path is not canonical" });
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid observed hunk",
    });
  }
}) satisfies z.ZodType<ObservedDiffHunkV1>;

export const ReconciliationCoordinateNodeV2Schema = z.object({
  id: z.union([QualifiedCoordinateIdSchema, Sha256HashSchema]),
  plane: z.enum(["repo", "semantic", "observed"]),
  sourceId: z.string().min(1),
  sourceKind: z.string().min(1),
  appliesAtLevel: ReconciliationSemanticLevelSchema.nullable(),
  category: CoordinateCategorySchema.nullable(),
  label: z.string(),
  epistemicStatus: EpistemicStatusSchema,
  references: z.array(z.string()),
  metadata: z.record(z.string()).optional(),
}).strict().superRefine((value, context) => {
  if (value.plane === "observed" && !value.id.startsWith("sha256:")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "observed coordinates require a sha256 identity" });
  }
  if (value.plane !== "observed" && !value.id.startsWith(`${value.plane}:`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "coordinate id must match its plane" });
  }
  if ((value.appliesAtLevel === null) !== (value.category === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "level and category must both be explicit or both be absent" });
  }
}) satisfies z.ZodType<CoordinateNodeV2>;

export const ReconciliationLevelCoverageV2Schema = z.object({
  level: ReconciliationSemanticLevelSchema,
  categories: z.array(CoordinateCategorySchema),
  coordinateIds: z.array(z.union([QualifiedCoordinateIdSchema, Sha256HashSchema])),
}).strict().superRefine((value, context) => {
  validateSortedUnique(value.categories, String, context, ["categories"]);
  validateSortedUnique(value.coordinateIds, String, context, ["coordinateIds"]);
}) satisfies z.ZodType<LevelCoverageV2>;

export const ReconciliationCompatibilityNormalizationNoteV1Schema = z.object({
  schemaVersion: z.literal(1),
  sourceSchemaVersion: z.literal(1),
  targetSchemaVersion: z.literal(2),
  notes: z.array(z.string().min(1)).min(1),
}).strict() satisfies z.ZodType<CompatibilityNormalizationNoteV1>;

export const ReconciliationCoordinateGraphReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  nodes: z.array(ReconciliationCoordinateNodeV2Schema),
  structuralEdges: z.array(CoordinateEdgeSchema),
  refinementRelations: z.array(ReconciliationRefinementRelationV1Schema),
  verifiedEvidenceDigests: z.array(Sha256HashSchema),
  mapping: z.array(SourceKindLevelMappingSchema),
  coverage: z.array(ReconciliationLevelCoverageV2Schema),
  unsupported: z.array(UnsupportedCoordinateSourceSchema),
  unmapped: z.array(UnmappedCoordinateSourceSchema),
  staleLinks: z.array(UnresolvedRepositoryLinkSchema),
  danglingReferences: z.array(DanglingSemanticReferenceSchema),
  compatibilityNormalization: z.array(ReconciliationCompatibilityNormalizationNoteV1Schema),
}).strict().superRefine((value, context) => {
  validateSortedUnique(value.nodes, (item) => item.id, context, ["nodes"]);
  validateSortedUnique(value.refinementRelations, (item) => item.id, context, ["refinementRelations"]);
  validateSortedUnique(value.verifiedEvidenceDigests, String, context, ["verifiedEvidenceDigests"]);
}) satisfies z.ZodType<CoordinateGraphReportV2>;

function validateSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const keys = values.map(key);
  const canonical = [...new Set(keys)].sort(compareCodeUnits);
  if (canonical.length !== keys.length || canonical.some((value, index) => value !== keys[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "values must be sorted and unique" });
  }
}
