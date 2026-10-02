import { describe, expect, it } from "bun:test";
import {
  CoordinateGraphReportV2Schema as PublicCoordinateGraphReportV2Schema,
  ObservedDiffHunkV1Schema as PublicObservedDiffHunkV1Schema,
  RefinementRelationV1Schema as PublicRefinementRelationV1Schema,
} from "@semantic-context/control-model";
import {
  CoordinateGraphReportV2Schema,
  ObservedDiffHunkV1Schema,
  RefinementRelationV1Schema,
  createObservedDiffHunkV1,
} from "@semantic-context/control-model/reconciliation";
import {
  parseCoordinateGraphV2,
  parseObservedDiffHunk,
  parseRefinementRelationV1,
} from "../src/reconciliation-validation";

function graph(staleLink: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    nodes: [],
    structuralEdges: [],
    refinementRelations: [],
    verifiedEvidenceDigests: [],
    mapping: [],
    coverage: [],
    unsupported: [],
    unmapped: [],
    staleLinks: [staleLink],
    danglingReferences: [],
    compatibilityNormalization: [],
  };
}

const diagnostic = {
  ownerId: "change.anchor",
  link: { kind: "symbol" as const, ref: "sym:function:src/a.ts:run" },
  resolved: false as const,
  reason: "the symbol moved",
  reasonCode: "symbol_gone" as const,
  candidates: ["sym:function:src/a.ts:outer.run", "sym:function:src/a.ts:run"],
};

describe("Plane C reconciliation link parsing", () => {
  it("uses the same canonical schemas on the public and read-only surfaces", () => {
    expect(CoordinateGraphReportV2Schema).toBe(PublicCoordinateGraphReportV2Schema);
    expect(ObservedDiffHunkV1Schema).toBe(PublicObservedDiffHunkV1Schema);
    expect(RefinementRelationV1Schema).toBe(PublicRefinementRelationV1Schema);
  });

  it("parses canonical observed hunks and refinement relations without widening branded fields", () => {
    const hunk = createObservedDiffHunkV1({
      repositoryIdentity: "repo:test",
      normalizedPath: "src/example.ts",
      oldRange: { start: 1, lines: 1 },
      newRange: { start: 1, lines: 1 },
      oldBlobId: "old",
      newBlobId: "new",
      rawHunkBytes: new TextEncoder().encode("@@ -1 +1 @@\n-old\n+new\n"),
    });
    const relation = {
      schemaVersion: 1 as const,
      id: "relation.example",
      kind: "realizes" as const,
      source: { plane: "B" as const, kind: "semantic_node" as const, nodeId: "goal.example" },
      target: { plane: "A" as const, kind: "observed_diff_hunk" as const, coordinateDigest: hunk.identity },
      epistemicStatus: "statically_observed" as const,
      provenance: "derived" as const,
      evidenceRefs: [{
        schemaVersion: 1 as const,
        kind: "observed_diff_hunk" as const,
        locator: hunk.identity,
        digest: { algorithm: "sha256" as const, value: hunk.identity.slice("sha256:".length) },
      }],
    };

    expect(parseObservedDiffHunk(hunk)).toEqual(hunk);
    expect(parseRefinementRelationV1(relation)).toEqual(relation);
  });

  it("round-trips the complete coordinate diagnostic", () => {
    const wire = JSON.parse(JSON.stringify(graph(diagnostic)));
    expect(parseCoordinateGraphV2(wire).staleLinks).toEqual([diagnostic]);
  });

  it("rejects unknown fields and malformed diagnostics", () => {
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, surprise: true }))).toThrow(/staleLinks\[0\] is invalid/);
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, reasonCode: "unknown" }))).toThrow(/staleLinks\[0\] is invalid/);
    expect(() => parseCoordinateGraphV2(graph({ ...diagnostic, candidates: [...diagnostic.candidates].reverse() }))).toThrow(/staleLinks\[0\] is invalid/);
  });
});
