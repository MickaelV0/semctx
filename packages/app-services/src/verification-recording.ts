import { SemctxError, type VerifyReport } from "@semantic-context/core";
import { verificationStatePath, writeFileNoFollow } from "@semantic-context/repository-store";
import type { VerificationGitState } from "./verification-state";

let temporaryNameForTesting: ((path: string) => string) | undefined;

/** One-shot atomic-writer fault seam; intentionally absent from the package root exports. */
export function __setVerificationTemporaryNameForTesting(temporaryName: ((path: string) => string) | undefined): void {
  temporaryNameForTesting = temporaryName;
}

/** Shared v3 evidence writer for `semctx verify diff --record` and `semctx index --record`. */
export function recordVerificationState(
  root: string,
  verdict: VerifyReport["verdict"],
  verifiedState: VerificationGitState,
  recordedAt: string,
): string {
  const path = verificationStatePath(root);
  const state = { version: 3, ...verifiedState, verdict, recordedAt };
  const temporaryName = temporaryNameForTesting;
  temporaryNameForTesting = undefined;
  writeFileNoFollow(root, path, `${JSON.stringify(state, null, 2)}\n`, temporaryName);
  return path;
}

/**
 * Refuse to authorize a verdict computed against a repository that moved during verification.
 * `analyzedSourceHash` defaults to `before`'s own value so a caller with nothing new to compare
 * (the pre-ADR-0025 `verify diff --record` call site) still proves the source was stable.
 */
export function requireStableVerificationGitState(
  before: VerificationGitState,
  after: VerificationGitState,
  analyzedSourceHash: string = before.analyzedSourceHash,
): VerificationGitState {
  if (
    before.headCommit !== after.headCommit
    || before.analyzedSourceHash !== after.analyzedSourceHash
    || before.analyzedSourceHash !== analyzedSourceHash
    || before.workingStateHash !== after.workingStateHash
    || before.contentStateHash !== after.contentStateHash
    || before.repositoryStateHash !== after.repositoryStateHash
    || before.indexStateHash !== after.indexStateHash
    || before.headTreeHash !== after.headTreeHash
  ) {
    throw new SemctxError("GIT_ERROR", "repository state changed while verification was running", { before, after });
  }
  return before;
}
