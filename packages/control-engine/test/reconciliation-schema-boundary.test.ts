import { describe, expect, it } from "bun:test";
import { parseCoordinateGraphV2, parseObservedDiffHunk, parseRefinementRelationV1 } from "../src/reconciliation-validation";

describe("canonical reconciliation schema boundaries", () => {
  it("refuses a coordinate whose declared plane disagrees with its identity", () => {
    const graph = {
      schemaVersion: 2,
      nodes: [{ id: "repo:src/a.ts", plane: "semantic", sourceId: "src/a.ts", sourceKind: "file", appliesAtLevel: null, category: null, label: "file", epistemicStatus: "statically_observed", references: [] }],
      structuralEdges: [], refinementRelations: [], verifiedEvidenceDigests: [], mapping: [],
      coverage: [], unsupported: [], unmapped: [], staleLinks: [], danglingReferences: [], compatibilityNormalization: [],
    };
    expect(() => parseCoordinateGraphV2(graph)).toThrow();
  });

  it("rejects incomplete hunk and relation inputs rather than asserting their type", () => {
    expect(() => parseObservedDiffHunk({ schemaVersion: 1 })).toThrow();
    expect(() => parseRefinementRelationV1({ schemaVersion: 1 })).toThrow();
  });
});
