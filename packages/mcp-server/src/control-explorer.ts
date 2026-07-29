import { basename } from "node:path";
import { z } from "zod-v4";
import {
  AltitudeAuthorityReportV1Schema,
  ControlFreshnessReasonSchema,
  ControlFreshnessVerdictSchema,
  ControlReasonCodeV1Schema,
  ControlTerminalStatusV1Schema,
  CoordinateEdgeSchema,
  CoordinateNodeV2Schema,
  LevelCoverageV2Schema,
  RefinementRelationV1Schema,
  Sha256HashSchema,
} from "@semantic-context/control-model";
import {
  controlAuthorityTool,
  controlGraphTool,
  controlStatusTool,
} from "./control-tools";
import { mcpSchema } from "./schema-boundary";

export const CONTROL_EXPLORER_DEFAULT_MAX_NODES = 250;
export const CONTROL_EXPLORER_DEFAULT_MAX_EDGES = 500;
export const CONTROL_EXPLORER_MAX_NODES = 1_000;
export const CONTROL_EXPLORER_MAX_EDGES = 2_000;

const ExplorerFreshnessSchema = z.object({
  schemaVersion: z.literal(1).describe("Freshness report schema version."),
  kind: z.literal("control_freshness_status").describe("Freshness report kind."),
  basis: z.literal("control_index_snapshot_v1").describe("Snapshot basis used for the verdict."),
  verdict: mcpSchema(ControlFreshnessVerdictSchema).describe("Current repository freshness verdict."),
  canRunHighRiskControl: z.boolean().describe("Whether the current freshness state admits high-risk control."),
  reasons: z.array(mcpSchema(ControlFreshnessReasonSchema)).describe("Canonical freshness reason codes."),
  seal: z.object({
    kind: z.literal("control_freshness_seal").describe("Freshness seal kind."),
    sealSchemaVersion: z.literal(1).describe("Freshness seal schema version."),
    sealHash: mcpSchema(Sha256HashSchema).describe("Digest of the complete underlying freshness seal."),
    headAtCapture: z.string().min(1).nullable().describe("Git HEAD captured by the seal, when available."),
    indexedHeadCommit: z.string().min(1).nullable().describe("Git commit bound to the index, when available."),
    indexedAt: z.string().datetime().nullable().describe("Index capture time, when available."),
    toolVersion: z.string().min(1).describe("Semctx version that produced the seal."),
  }).strict().nullable().describe("Redacted freshness seal summary without repository paths."),
}).strict();

const ExplorerCoverageSchema = z.object({
  status: mcpSchema(ControlTerminalStatusV1Schema).describe("Coordinate query terminal status."),
  levels: z.number().int().min(0).max(7).describe("Number of represented L0-L6 coverage bands."),
  unsupported: z.number().int().nonnegative().describe("Unsupported coordinate source count."),
  unmapped: z.number().int().nonnegative().describe("Unmapped coordinate source count."),
  reasons: z.array(mcpSchema(ControlReasonCodeV1Schema)).describe("Canonical coordinate query reason codes."),
}).strict();

const ExplorerGraphSchema = z.object({
  schemaVersion: z.literal(1).describe("Control query envelope schema version."),
  kind: z.literal("coordinate_graph").describe("Control query kind."),
  terminalStatus: mcpSchema(ControlTerminalStatusV1Schema).describe("Coordinate graph terminal status."),
  reasonCodes: z.array(mcpSchema(ControlReasonCodeV1Schema)).describe("Canonical coordinate graph reason codes."),
  nodes: z.array(mcpSchema(CoordinateNodeV2Schema))
    .max(CONTROL_EXPLORER_MAX_NODES)
    .describe("Bounded coordinate nodes."),
  structuralEdges: z.array(mcpSchema(CoordinateEdgeSchema))
    .max(CONTROL_EXPLORER_MAX_EDGES)
    .describe("Bounded structural graph edges."),
  refinementRelations: z.array(mcpSchema(RefinementRelationV1Schema))
    .max(CONTROL_EXPLORER_MAX_EDGES)
    .describe("Bounded proof-carrying refinement relations."),
  levelCoverage: z.array(mcpSchema(LevelCoverageV2Schema))
    .max(7)
    .describe("Explicit coordinate coverage for L0 through L6."),
  totals: z.object({
    nodes: z.number().int().nonnegative().describe("Total coordinate nodes before bounding."),
    edges: z.number().int().nonnegative().describe("Total structural and refinement edges before bounding."),
    unsupported: z.number().int().nonnegative().describe("Total unsupported sources."),
    unmapped: z.number().int().nonnegative().describe("Total unmapped sources."),
    staleLinks: z.number().int().nonnegative().describe("Total stale repository links."),
    danglingReferences: z.number().int().nonnegative().describe("Total dangling semantic references."),
  }).strict(),
  omissions: z.object({
    nodesByNodeLimit: z.number().int().nonnegative()
      .describe("Coordinate nodes omitted by the requested node limit."),
    structuralEdgesByNodeLimit: z.number().int().nonnegative()
      .describe("Structural edges omitted because a required node was omitted by the node limit."),
    structuralEdgesByEdgeLimit: z.number().int().nonnegative()
      .describe("Structural edges omitted by the requested combined edge limit."),
    refinementRelationsByMissingEndpoint: z.number().int().nonnegative()
      .describe("Refinement relations omitted because an endpoint is absent from the full coordinate graph."),
    refinementRelationsByNodeLimit: z.number().int().nonnegative()
      .describe("Refinement relations omitted because an existing endpoint node was omitted by the node limit."),
    refinementRelationsByEdgeLimit: z.number().int().nonnegative()
      .describe("Refinement relations omitted by the requested combined edge limit."),
  }).strict().describe("Exact omission counts without exposing omitted identifiers."),
}).strict();

export const ControlExplorerOutputSchema = z.object({
  schemaVersion: z.literal(1).describe("Control Explorer snapshot schema version."),
  kind: z.literal("control_explorer").describe("Control Explorer snapshot kind."),
  repository: z.object({
    name: z.string().min(1).describe("Repository directory name without an absolute path."),
  }).strict().describe("Redacted repository identity."),
  executionAuthority: z.literal("none").describe("The Explorer grants no execution authority."),
  freshness: ExplorerFreshnessSchema.describe("Redacted control freshness report."),
  coverage: ExplorerCoverageSchema.describe("Bounded L0-L6 coordinate coverage summary."),
  graph: ExplorerGraphSchema.describe("Bounded coordinate graph evidence."),
  impact: z.object({
    status: z.literal("not_requested").describe("Impact analysis is not run by this read-only snapshot."),
  }).strict().describe("Explicit impact-analysis state."),
  authority: mcpSchema(AltitudeAuthorityReportV1Schema)
    .describe("Required authority report for the highest abstraction altitude."),
  bounds: z.object({
    maxNodes: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_NODES).describe("Requested node limit."),
    maxEdges: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_EDGES).describe("Requested combined edge limit."),
    returnedNodes: z.number().int().nonnegative().describe("Nodes returned after bounding."),
    returnedEdges: z.number().int().nonnegative().describe("Combined edges returned after bounding."),
  }).strict().describe("Applied result bounds."),
  truncated: z.boolean().describe("Whether any raw graph node or edge was omitted from the self-contained snapshot."),
}).strict().superRefine((value, context) => {
  const selectedNodeIds = new Set(value.graph.nodes.map((node) => node.id));
  const selectedSemanticSourceIds = new Set(
    value.graph.nodes
      .filter((node) => node.plane === "semantic")
      .map((node) => node.sourceId),
  );
  const selectedObservedIds = new Set(
    value.graph.nodes
      .filter((node) => node.plane === "observed")
      .flatMap((node) => [node.id, node.sourceId]),
  );
  if (value.graph.nodes.length !== value.bounds.returnedNodes) {
    context.addIssue({
      code: "custom",
      path: ["bounds", "returnedNodes"],
      message: "returnedNodes must equal the bounded node count",
    });
  }
  if (
    value.bounds.returnedNodes > value.bounds.maxNodes
    || value.graph.nodes.length > value.bounds.maxNodes
  ) {
    context.addIssue({
      code: "custom",
      path: ["bounds", "returnedNodes"],
      message: "returnedNodes must not exceed maxNodes",
    });
  }
  const returnedEdges =
    value.graph.structuralEdges.length + value.graph.refinementRelations.length;
  if (returnedEdges !== value.bounds.returnedEdges) {
    context.addIssue({
      code: "custom",
      path: ["bounds", "returnedEdges"],
      message: "returnedEdges must equal the bounded combined edge count",
    });
  }
  if (
    value.bounds.returnedEdges > value.bounds.maxEdges
    || returnedEdges > value.bounds.maxEdges
  ) {
    context.addIssue({
      code: "custom",
      path: ["bounds", "returnedEdges"],
      message: "returnedEdges must not exceed maxEdges",
    });
  }
  const omissions = value.graph.omissions;
  if (
    value.graph.totals.nodes
    !== value.bounds.returnedNodes + omissions.nodesByNodeLimit
  ) {
    context.addIssue({
      code: "custom",
      path: ["graph", "totals", "nodes"],
      message: "total nodes must equal returned nodes plus node-limit omissions",
    });
  }
  const omittedEdges =
    omissions.structuralEdgesByNodeLimit
    + omissions.structuralEdgesByEdgeLimit
    + omissions.refinementRelationsByMissingEndpoint
    + omissions.refinementRelationsByNodeLimit
    + omissions.refinementRelationsByEdgeLimit;
  if (value.graph.totals.edges !== returnedEdges + omittedEdges) {
    context.addIssue({
      code: "custom",
      path: ["graph", "totals", "edges"],
      message: "total edges must equal returned edges plus all edge omissions",
    });
  }
  const hasOmissions =
    omissions.nodesByNodeLimit > 0
    || omissions.structuralEdgesByNodeLimit > 0
    || omissions.structuralEdgesByEdgeLimit > 0
    || omissions.refinementRelationsByMissingEndpoint > 0
    || omissions.refinementRelationsByNodeLimit > 0
    || omissions.refinementRelationsByEdgeLimit > 0;
  if (value.truncated !== hasOmissions) {
    context.addIssue({
      code: "custom",
      path: ["truncated"],
      message: "truncated must be true exactly when at least one item was omitted",
    });
  }
  if (
    value.coverage.levels !== value.graph.levelCoverage.length
    || value.coverage.unsupported !== value.graph.totals.unsupported
    || value.coverage.unmapped !== value.graph.totals.unmapped
  ) {
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "coverage summary must match the bounded graph report",
    });
  }
  for (const [index, edge] of value.graph.structuralEdges.entries()) {
    if (!selectedNodeIds.has(edge.from) || !selectedNodeIds.has(edge.to)) {
      context.addIssue({
        code: "custom",
        path: ["graph", "structuralEdges", index],
        message: "structural edge endpoints must be present in the bounded node set",
      });
    }
  }
  for (const [index, relation] of value.graph.refinementRelations.entries()) {
    const endpoints = [relation.source, relation.target];
    if (endpoints.some((endpoint) =>
      endpoint.plane === "B"
        ? !selectedSemanticSourceIds.has(endpoint.nodeId)
        : !selectedObservedIds.has(endpoint.coordinateDigest)
    )) {
      context.addIssue({
        code: "custom",
        path: ["graph", "refinementRelations", index],
        message: "refinement relation endpoints must be present in the bounded node set",
      });
    }
  }
  for (const [index, level] of value.graph.levelCoverage.entries()) {
    if (level.coordinateIds.some((coordinateId) => !selectedNodeIds.has(coordinateId))) {
      context.addIssue({
        code: "custom",
        path: ["graph", "levelCoverage", index, "coordinateIds"],
        message: "level coverage must expose only bounded node identifiers",
      });
    }
  }
});

export type ControlExplorerSnapshot = z.infer<typeof ControlExplorerOutputSchema>;

export interface ControlExplorerInput {
  maxNodes?: number;
  maxEdges?: number;
}

/**
 * Build one bounded, read-only Plane-C snapshot for MCP App hosts.
 *
 * The snapshot deliberately keeps freshness, coordinate coverage, graph evidence,
 * and authority separate. It carries no execution affordance and omits the
 * repository's absolute path even when lower-level seals contain it.
 */
export function controlExplorerTool(
  root: string,
  input: ControlExplorerInput = {},
): ControlExplorerSnapshot {
  const maxNodes = input.maxNodes ?? CONTROL_EXPLORER_DEFAULT_MAX_NODES;
  const maxEdges = input.maxEdges ?? CONTROL_EXPLORER_DEFAULT_MAX_EDGES;
  const status = controlStatusTool(root);
  const graphEnvelope = controlGraphTool(root);
  const authority = controlAuthorityTool(root, 6);

  const payload = graphEnvelope.payload;
  const allNodes = payload?.nodes ?? [];
  const boundedNodes = selectBoundedNodes(allNodes, maxNodes);
  const selectedNodeIds = new Set(boundedNodes.map((node) => node.id));
  const selectedSemanticSourceIds = new Set(
    boundedNodes
      .filter((node) => node.plane === "semantic")
      .map((node) => node.sourceId),
  );
  const selectedObservedIds = new Set(
    boundedNodes
      .filter((node) => node.plane === "observed")
      .flatMap((node) => [node.id, node.sourceId]),
  );
  const structuralEdges = payload?.structuralEdges ?? [];
  const refinementRelations = payload?.refinementRelations ?? [];
  const fullSemanticSourceIds = new Set(
    allNodes
      .filter((node) => node.plane === "semantic")
      .map((node) => node.sourceId),
  );
  const fullObservedIds = new Set(
    allNodes
      .filter((node) => node.plane === "observed")
      .flatMap((node) => [node.id, node.sourceId]),
  );
  const eligibleStructuralEdges = structuralEdges.filter((edge) =>
    selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to)
  );
  const boundedStructuralEdges = eligibleStructuralEdges.slice(0, maxEdges);
  const remainingEdgeBudget = maxEdges - boundedStructuralEdges.length;
  const refinementRelationsWithFullEndpoints = refinementRelations.filter(
    (relation) =>
      [relation.source, relation.target].every((endpoint) =>
        endpoint.plane === "B"
          ? fullSemanticSourceIds.has(endpoint.nodeId)
          : fullObservedIds.has(endpoint.coordinateDigest)
      ),
  );
  const eligibleRefinementRelations = refinementRelationsWithFullEndpoints.filter(
    (relation) =>
      [relation.source, relation.target].every((endpoint) =>
        endpoint.plane === "B"
          ? selectedSemanticSourceIds.has(endpoint.nodeId)
          : selectedObservedIds.has(endpoint.coordinateDigest)
      ),
  );
  const boundedRefinementRelations =
    eligibleRefinementRelations.slice(0, remainingEdgeBudget);
  const returnedEdges =
    boundedStructuralEdges.length + boundedRefinementRelations.length;
  const totalEdges = structuralEdges.length + refinementRelations.length;
  const omissions = {
    nodesByNodeLimit: allNodes.length - boundedNodes.length,
    structuralEdgesByNodeLimit:
      structuralEdges.length - eligibleStructuralEdges.length,
    structuralEdgesByEdgeLimit:
      eligibleStructuralEdges.length - boundedStructuralEdges.length,
    refinementRelationsByMissingEndpoint:
      refinementRelations.length - refinementRelationsWithFullEndpoints.length,
    refinementRelationsByNodeLimit:
      refinementRelationsWithFullEndpoints.length
      - eligibleRefinementRelations.length,
    refinementRelationsByEdgeLimit:
      eligibleRefinementRelations.length - boundedRefinementRelations.length,
  };
  const truncated = Object.values(omissions).some((count) => count > 0);

  const freshness = {
    schemaVersion: status.schemaVersion,
    kind: status.kind,
    basis: status.basis,
    verdict: status.verdict,
    canRunHighRiskControl: status.canRunHighRiskControl,
    reasons: status.reasons,
    seal: status.freshnessSeal === null
      ? null
      : {
          kind: status.freshnessSeal.kind,
          sealSchemaVersion: status.freshnessSeal.sealSchemaVersion,
          sealHash: status.freshnessSeal.sealHash,
          headAtCapture: status.freshnessSeal.headAtCapture,
          indexedHeadCommit: status.freshnessSeal.indexedHeadCommit,
          indexedAt: status.freshnessSeal.indexedAt,
          toolVersion: status.freshnessSeal.toolVersion,
        },
  };

  const graph = {
    schemaVersion: graphEnvelope.schemaVersion,
    kind: graphEnvelope.kind,
    terminalStatus: graphEnvelope.terminalStatus,
    reasonCodes: graphEnvelope.reasonCodes,
    nodes: boundedNodes,
    structuralEdges: boundedStructuralEdges,
    refinementRelations: boundedRefinementRelations,
    levelCoverage: (payload?.coverage ?? []).map((level) => ({
      ...level,
      coordinateIds: level.coordinateIds.filter((coordinateId) =>
        selectedNodeIds.has(coordinateId)
      ),
    })),
    totals: {
      nodes: allNodes.length,
      edges: totalEdges,
      unsupported: payload?.unsupported.length ?? 0,
      unmapped: payload?.unmapped.length ?? 0,
      staleLinks: payload?.staleLinks.length ?? 0,
      danglingReferences: payload?.danglingReferences.length ?? 0,
    },
    omissions,
  };
  const coverage = {
    status: graphEnvelope.terminalStatus,
    levels: payload?.coverage.length ?? 0,
    unsupported: payload?.unsupported.length ?? 0,
    unmapped: payload?.unmapped.length ?? 0,
    reasons: graphEnvelope.reasonCodes,
  };

  return ControlExplorerOutputSchema.parse(redactRepositoryRoot({
    schemaVersion: 1,
    kind: "control_explorer",
    repository: { name: basename(root) },
    executionAuthority: "none",
    freshness,
    coverage,
    graph,
    impact: { status: "not_requested" },
    authority,
    bounds: {
      maxNodes,
      maxEdges,
      returnedNodes: boundedNodes.length,
      returnedEdges,
    },
    truncated,
  }, root));
}

function selectBoundedNodes<T extends {
  appliesAtLevel: number | null;
}>(nodes: readonly T[], maxNodes: number): T[] {
  if (nodes.length <= maxNodes) {
    return [...nodes];
  }

  const selected: T[] = [];
  const selectedIndexes = new Set<number>();
  const representedLevels = new Set<number | null>();

  for (const [index, node] of nodes.entries()) {
    if (representedLevels.has(node.appliesAtLevel)) continue;
    selected.push(node);
    selectedIndexes.add(index);
    representedLevels.add(node.appliesAtLevel);
    if (selected.length === maxNodes) return selected;
  }

  for (const [index, node] of nodes.entries()) {
    if (selectedIndexes.has(index)) continue;
    selected.push(node);
    if (selected.length === maxNodes) break;
  }
  return selected;
}

function redactRepositoryRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    const variants = new Set([
      root,
      root.replaceAll("\\", "/"),
      root.replaceAll("/", "\\"),
    ]);
    let redacted = value;
    for (const variant of variants) {
      if (variant.length > 0) {
        redacted = redacted.replaceAll(variant, "<repository>");
      }
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRepositoryRoot(item, root));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactRepositoryRoot(item, root),
      ]),
    );
  }
  return value;
}
