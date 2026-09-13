import { totalmem } from "node:os";
import { canonicalRepositoryRoot, captureVerificationGitState, type VerificationGitState } from "@semantic-context/app-services";

export interface ImplementationIdentity {
  repositoryRoot: string;
  /**
   * Complete dirty-source identity at capture time: HEAD plus tracked index/worktree bytes and
   * every non-ignored untracked file's bytes, so adding or editing a helper module changes this
   * value. Reuses the same verification-state capture the proof-gate/guard mechanism relies on,
   * rather than a benchmark-local content fingerprint.
   */
  gitState: VerificationGitState;
}

/** Computed from the real Git state of the semctx implementation repository, never from its branch name or size. */
export function captureImplementationIdentity(repositoryRoot: string): ImplementationIdentity {
  return {
    repositoryRoot: canonicalRepositoryRoot(repositoryRoot),
    gitState: captureVerificationGitState(repositoryRoot),
  };
}

export interface HostIdentity {
  bunVersion: string;
  platform: string;
  arch: string;
  totalMemoryBytes: number;
  /** Native resource-usage APIs are OS-specific; only same-host/runtime comparisons are meaningful. */
  crossOsComparability: "UNKNOWN";
}

export function captureHostIdentity(): HostIdentity {
  return {
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    totalMemoryBytes: totalmem(),
    crossOsComparability: "UNKNOWN",
  };
}
