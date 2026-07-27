/** Agent-facing application boundary for immutable, non-normative target proposals. */

import { relative, resolve } from "node:path";
import { z } from "zod";
import { SemctxError } from "@semantic-context/core";
import {
  ArchitectureElementSchema,
  ArchitectureRelationSchema,
  type ArchitectureElement,
  type ArchitectureRelation,
} from "@semantic-context/control-model";
import {
  createTargetProposal,
  targetArtifactPath,
  type TargetArchitectureArtifactV1,
} from "@semantic-context/semantic-engine";
import { canonicalRepositoryRoot } from "./freshness";
import { loadControlState } from "./control";

const SAFE_TARGET_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export interface ProposeTargetArchitectureCommandV1 {
  schemaVersion: 1;
  targetId: string;
  revision: number;
  statement: string;
  elements: readonly ArchitectureElement[];
  relations: readonly ArchitectureRelation[];
  preservedInvariantIds: readonly string[];
}

export const ProposeTargetArchitectureCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  targetId: z.string().regex(SAFE_TARGET_ID, "unsafe target id"),
  revision: z.number().int().positive(),
  statement: z.string().trim().min(1),
  elements: z.array(ArchitectureElementSchema),
  relations: z.array(ArchitectureRelationSchema),
  preservedInvariantIds: z.array(z.string().min(1)),
}).strict();

export interface TargetArchitectureProposalResultV1 {
  schemaVersion: 1;
  kind: "target_architecture_proposal";
  certifying: false;
  executionAuthority: "none";
  relativePath: string;
  artifact: TargetArchitectureArtifactV1;
}

/**
 * Persist one immutable Plane-B proposal bound to the exact fresh control state.
 *
 * The caller supplies target content only. Commit, graph seal and agent
 * authorship are application-owned facts, and the resulting proposal remains
 * hypothetical until the separate review boundary creates an accepted revision.
 */
export function proposeTargetArchitecture(
  root: string,
  command: ProposeTargetArchitectureCommandV1,
): TargetArchitectureProposalResultV1 {
  const parsed = ProposeTargetArchitectureCommandV1Schema.parse(
    command,
  ) as ProposeTargetArchitectureCommandV1;
  const state = loadControlState(root);
  const seal = state.freshnessSeal;
  const canonicalRoot = canonicalRepositoryRoot(root);
  if (
    state.freshnessStatus.verdict !== "FRESH"
    || seal.headAtCapture === null
    || seal.repositoryRoot !== canonicalRoot
    || seal.indexedRepositoryRoot !== canonicalRoot
    || seal.headAtCapture !== seal.indexedHeadCommit
    || seal.repositoryGraphHash !== seal.indexedRepositoryGraphHash
  ) {
    throw new SemctxError(
      "CONTROL_INPUTS_UNSAFE",
      "target proposal requires a FRESH repository control state",
      {
        verdict: state.freshnessStatus.verdict,
        reasons: state.freshnessStatus.reasons,
      },
    );
  }

  const artifact = createTargetProposal(root, {
    targetId: parsed.targetId,
    revision: parsed.revision,
    statement: parsed.statement,
    baseCommit: seal.headAtCapture,
    sourceGraphSeal: seal.repositoryGraphHash,
    elements: parsed.elements,
    relations: parsed.relations,
    preservedInvariantIds: parsed.preservedInvariantIds,
    authorshipOrigin: "agent",
  });
  const artifactPath = targetArtifactPath(root, artifact.targetId, artifact.revision);
  return {
    schemaVersion: 1,
    kind: "target_architecture_proposal",
    certifying: false,
    executionAuthority: "none",
    relativePath: relative(resolve(root), artifactPath).replaceAll("\\", "/"),
    artifact,
  };
}
