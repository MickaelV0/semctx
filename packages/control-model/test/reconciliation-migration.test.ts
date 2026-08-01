import { describe, expect, it } from "bun:test";
import {
  DELETION_PREREQUISITE_OBLIGATIONS,
  MIGRATION_STEP_PROFILES,
} from "@semantic-context/control-model";
import {
  RECONCILIATION_MIGRATION_STEP_PROFILES_V1,
} from "@semantic-context/control-model/reconciliation-migration";

describe("neutral reconciliation migration leaf", () => {
  it("contains the exact eight authority-neutral migration phases", () => {
    expect(RECONCILIATION_MIGRATION_STEP_PROFILES_V1).toHaveLength(8);
    expect(RECONCILIATION_MIGRATION_STEP_PROFILES_V1.map((entry) => entry.phase)).toEqual([
      "capture_baseline",
      "characterize_behavior",
      "define_target_proofs",
      "introduce_parallel",
      "shadow_validate",
      "cutover_replacement",
      "observe_cutover",
      "deletion_readiness",
    ]);
    expect(JSON.stringify(RECONCILIATION_MIGRATION_STEP_PROFILES_V1))
      .not.toMatch(/authoriz/i);
  });

  it("derives the legacy profiles one-to-one without changing their contract", () => {
    expect(MIGRATION_STEP_PROFILES).toEqual(
      RECONCILIATION_MIGRATION_STEP_PROFILES_V1.map((entry) => ({
        profile: entry.phase === "deletion_readiness" ? "authorize_deletion" : entry.phase,
        kind: entry.kind,
        fromState: entry.fromState,
        toState: entry.toState,
        risk: entry.risk,
        minimumProofObligations: [...entry.completionEvidenceRequirementIds],
      })),
    );
    expect(MIGRATION_STEP_PROFILES.at(-1)).toEqual({
      profile: "authorize_deletion",
      kind: "deletion_check",
      fromState: "LEGACY_REMOVABLE",
      toState: "DELETED",
      risk: "R3",
      minimumProofObligations: [
        ...DELETION_PREREQUISITE_OBLIGATIONS,
        "deletion_approved",
      ],
    });
    expect(DELETION_PREREQUISITE_OBLIGATIONS).toEqual(
      RECONCILIATION_MIGRATION_STEP_PROFILES_V1.at(-1)!
        .completionEvidenceRequirementIds.filter((id) => id !== "deletion_approved"),
    );
  });
});
