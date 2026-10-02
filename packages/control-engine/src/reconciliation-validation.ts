import { z } from "zod";
import {
  CoordinateGraphReportV2Schema,
  ObservedDiffHunkV1Schema,
  RefinementRelationV1Schema,
  Sha256HashSchema,
  type CoordinateGraphReportV2,
  type ObservedDiffHunkV1,
  type RefinementRelationV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";

export function parseSha256Hash(value: unknown, label: string): Sha256Hash {
  const parsed = Sha256HashSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  return parsed.data;
}

export function parseObservedDiffHunk(value: unknown): ObservedDiffHunkV1 {
  return ObservedDiffHunkV1Schema.parse(value);
}

export function isObservedDiffHunk(value: unknown): value is ObservedDiffHunkV1 {
  return ObservedDiffHunkV1Schema.safeParse(value).success;
}

export function parseCoordinateGraphV2(value: unknown): CoordinateGraphReportV2 {
  try {
    return CoordinateGraphReportV2Schema.parse(value);
  } catch (cause) {
    const diagnosed = CoordinateGraphReportV2Schema.safeParse(value);
    if (diagnosed.success) throw cause;
    const staleLinkIssues = diagnosed.error.issues.filter((issue) => issue.path[0] === "staleLinks");
    if (staleLinkIssues.length > 0) {
      const index = staleLinkIssues[0]?.path[1];
      throw new Error(
        `staleLinks[${typeof index === "number" ? index : 0}] is invalid: ${staleLinkIssues
          .map((issue) => issue.message)
          .join("; ")}`,
        { cause },
      );
    }
    throw new Error(`coordinate graph is invalid: ${formatIssues(diagnosed.error)}`, { cause });
  }
}

export function parseRefinementRelationV1(value: unknown): RefinementRelationV1 {
  return RefinementRelationV1Schema.parse(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}
