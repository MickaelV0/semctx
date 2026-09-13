import { SemctxError } from "@semantic-context/core";
import { discoverRepository, type IndexWorkerSelection } from "@semantic-context/ts-analyzer";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { loadConfig } from "@semantic-context/repository-store";
import { loadSemanticModel } from "@semantic-context/semantic-engine";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, fingerprintAnalysisInputs, fingerprintRepositoryFacts,
  fingerprintSemanticModel, parseIndexedControlSnapshot } from "./freshness";
import { inspectSemanticLifecycleWithIdentity } from "./semantic-check";
import { indexRepository, indexRepositoryAsync, type RepositoryIndex } from "./indexing";
import { openReadyRepository } from "./readiness";
import { captureRecordableVerificationGitState, type VerificationGitState } from "./verification-state";
import { recordVerificationState, requireStableVerificationGitState } from "./verification-recording";
import { runVerify, type VerifyComputation } from "./verify";

export interface IndexRecoveryOutcome {
  index: RepositoryIndex;
  verification: VerifyComputation;
  recordedPath: string;
}

/**
 * An exception thrown after the rebuild step of `index --record` completed. The old evidence
 * baseline is byte-identical (recording did not complete), but a plain rebuild already happened and
 * a caller must not read this as "nothing happened" — ADR 0025 requires the partial outcome named.
 */
function reportPartialRecoveryFailure(error: unknown): never {
  if (error instanceof SemctxError) {
    throw new SemctxError(
      error.code,
      `index rebuilt but evidence was not recorded: ${error.message}`,
      { ...error.details, indexRebuilt: true, evidenceRecorded: false },
    );
  }
  const cause = error instanceof Error ? error.message : String(error);
  throw new SemctxError(
    "STORE_ERROR",
    `index rebuilt but evidence was not recorded: ${cause}`,
    { indexRebuilt: true, evidenceRecorded: false, cause },
  );
}

/**
 * The exact persisted control-index snapshot this rebuild wrote, read back through a fresh
 * read-only handle. Read raw (not via `controlStatus`/Plane-C): projection there refuses whenever
 * *any* lifecycle error is active, including the very `EVIDENCE_BASELINE_STALE` this recovery
 * exists to repair, which would make the identity check unusable during the one operation it must
 * protect.
 */
function captureRecoveryIndex(root: string, index: RepositoryIndex): {
  snapshotHash: string; factsHash: string; configHash: string; semanticInputHash: string;
} {
  const reader = openReadyRepository(root);
  try {
    const raw = reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
    const snapshot = parseIndexedControlSnapshot(raw);
    const config = loadConfig(root);
    const semantic = loadSemanticModel(root);
    const lifecycle = inspectSemanticLifecycleWithIdentity(root, semantic.model.changes);
    const lifecycleErrors = lifecycle.findings
      .filter((finding) => finding.severity === "error" && finding.code !== "EVIDENCE_BASELINE_STALE");
    const factsHash = fingerprintRepositoryFacts({
      graph: reader.loadGraph(), claims: reader.loadClaims(), evidence: reader.loadEvidence(),
    });
    const seal = index.freshnessSeal;
    if (
      snapshot === null || snapshot.schemaVersion !== 2
      || snapshot.capturedAt !== seal.indexedAt
      || snapshot.repositoryRoot !== seal.indexedRepositoryRoot
      || snapshot.headCommit !== seal.indexedHeadCommit
      || snapshot.workingDiffHash !== seal.indexedWorkingDiffHash
      || snapshot.repositoryGraphHash !== seal.indexedRepositoryGraphHash
      || snapshot.semanticModelHash !== seal.indexedSemanticModelHash
      || snapshot.analysisInputHash !== seal.indexedAnalysisInputHash
      || snapshot.toolVersion !== seal.indexedToolVersion
      || snapshot.storeSchemaVersion !== seal.indexedStoreSchemaVersion
      || snapshot.planeAIndexSnapshotHash !== seal.indexedPlaneAIndexSnapshotHash
      || factsHash !== seal.repositoryGraphHash
      || fingerprintAnalysisInputs(config, discoverRepository(config).files) !== seal.analysisInputHash
      || fingerprintSemanticModel(semantic.model) !== seal.semanticModelHash
      || semantic.diagnostics.some((diagnostic) => diagnostic.severity === "error")
      || semantic.duplicateIds.length > 0 || lifecycleErrors.length > 0
    ) {
      throw new SemctxError("GIT_ERROR", "the rebuilt index inputs changed during recovery", {
        reason: "RECOVERY_INDEX_INPUT_MISMATCH",
      });
    }
    return {
      snapshotHash: digestCanonical(raw), factsHash, configHash: digestCanonical(config),
      semanticInputHash: digestCanonical({
        semanticModelHash: fingerprintSemanticModel(semantic.model), lifecycleInputHash: lifecycle.inputHash,
      }),
    };
  } finally {
    reader.close();
  }
}

/**
 * Compute a fresh working-tree verification against the just-rebuilt index and atomically record
 * it, refusing when any input drifted across the whole rebuild+verify+record window.
 */
function finishIndexRecovery(
  root: string,
  recordedAt: string,
  index: RepositoryIndex,
  stateBefore: VerificationGitState,
): IndexRecoveryOutcome {
  try {
    const afterRebuild = captureRecoveryIndex(root, index);
    const verification = runVerify(root, { kind: "working-tree" });
    const beforeRecord = captureRecoveryIndex(root, index);
    if (
      beforeRecord.semanticInputHash !== afterRebuild.semanticInputHash
      || verification.analyzedSemanticInputHashes.length === 0
      || verification.analyzedSemanticInputHashes.some((hash) => hash !== afterRebuild.semanticInputHash)
    ) {
      throw new SemctxError("GIT_ERROR", "semantic or evidence inputs changed during recovery verification", {
        reason: "RECOVERY_ANALYZED_SEMANTIC_INPUT_MISMATCH",
      });
    }
    // Compare actual analyzed objects as well as current persisted state. Equal metadata alone
    // cannot bind a verdict: a writer may change graph/claims without changing that metadata.
    if (
      afterRebuild.snapshotHash !== beforeRecord.snapshotHash
      || verification.analyzedIndexSnapshotHash !== afterRebuild.snapshotHash
      || verification.analyzedRepositoryFactsHash !== afterRebuild.factsHash
      || verification.analyzedConfigHash !== afterRebuild.configHash
    ) {
      throw new SemctxError(
        "GIT_ERROR",
        "the analyzed index changed while recovery verification was running",
        { reason: "RECOVERY_ANALYZED_INDEX_MISMATCH" },
      );
    }
    const stateAfter = captureRecordableVerificationGitState(root);
    const verifiedState = requireStableVerificationGitState(
      stateBefore,
      stateAfter,
      verification.analyzedSourceHash ?? "",
    );
    const recordedPath = recordVerificationState(root, verification.report.verdict, verifiedState, recordedAt);
    return { index, verification, recordedPath };
  } catch (error) {
    return reportPartialRecoveryFailure(error);
  }
}

/** `semctx index --record` (sync): rebuild, verify the working tree, and atomically record evidence. */
export function recoverIndexEvidence(root: string, recordedAt: string): IndexRecoveryOutcome {
  const stateBefore = captureRecordableVerificationGitState(root);
  const index = indexRepository(root, recordedAt);
  return finishIndexRecovery(root, recordedAt, index, stateBefore);
}

/** `semctx index --record` (async): rebuild, verify the working tree, and atomically record evidence. */
export async function recoverIndexEvidenceAsync(
  root: string,
  recordedAt: string,
  workers: IndexWorkerSelection = "auto",
): Promise<IndexRecoveryOutcome> {
  const stateBefore = captureRecordableVerificationGitState(root);
  const index = await indexRepositoryAsync(root, recordedAt, workers);
  return finishIndexRecovery(root, recordedAt, index, stateBefore);
}
