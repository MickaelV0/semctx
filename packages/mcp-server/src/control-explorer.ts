import { basename } from "node:path";
import { z } from "zod-v4";
import {
  controlAuthorityTool,
  controlGraphTool,
  controlStatusTool,
} from "./control-tools";

export const CONTROL_EXPLORER_DEFAULT_MAX_NODES = 250;
export const CONTROL_EXPLORER_DEFAULT_MAX_EDGES = 500;
export const CONTROL_EXPLORER_MAX_NODES = 1_000;
export const CONTROL_EXPLORER_MAX_EDGES = 2_000;

const JSON_OBJECT = z.record(z.string(), z.json());

export const ControlExplorerOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("control_explorer"),
  repository: z.object({
    name: z.string().min(1),
  }).strict(),
  executionAuthority: z.literal("none"),
  freshness: JSON_OBJECT,
  coverage: JSON_OBJECT,
  graph: JSON_OBJECT,
  impact: z.object({
    status: z.literal("not_requested"),
  }).strict(),
  authority: JSON_OBJECT,
  bounds: z.object({
    maxNodes: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_NODES),
    maxEdges: z.number().int().min(1).max(CONTROL_EXPLORER_MAX_EDGES),
    returnedNodes: z.number().int().nonnegative(),
    returnedEdges: z.number().int().nonnegative(),
  }).strict(),
  truncated: z.boolean(),
}).strict();

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
  const structuralEdges = payload?.structuralEdges ?? [];
  const refinementRelations = payload?.refinementRelations ?? [];
  const boundedStructuralEdges = structuralEdges.slice(0, maxEdges);
  const remainingEdgeBudget = maxEdges - boundedStructuralEdges.length;
  const boundedRefinementRelations = refinementRelations.slice(
    0,
    remainingEdgeBudget,
  );
  const returnedEdges =
    boundedStructuralEdges.length + boundedRefinementRelations.length;
  const totalEdges = structuralEdges.length + refinementRelations.length;
  const truncated = allNodes.length > maxNodes || totalEdges > maxEdges;

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
    nodes: allNodes.slice(0, maxNodes),
    structuralEdges: boundedStructuralEdges,
    refinementRelations: boundedRefinementRelations,
    levelCoverage: payload?.coverage ?? [],
    totals: {
      nodes: allNodes.length,
      edges: totalEdges,
      unsupported: payload?.unsupported.length ?? 0,
      unmapped: payload?.unmapped.length ?? 0,
      staleLinks: payload?.staleLinks.length ?? 0,
      danglingReferences: payload?.danglingReferences.length ?? 0,
    },
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
      returnedNodes: Math.min(allNodes.length, maxNodes),
      returnedEdges,
    },
    truncated,
  }, root));
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
