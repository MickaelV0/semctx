import { describe, expect, test } from "bun:test";
import {
  AGENT_LIFECYCLE_POLICY_V1,
  AGENT_WORKFLOW_STAGE_ORDER,
  AgentLifecycleCheckpointRequestV1Schema,
  AgentLifecyclePolicyV1Schema,
  AgentLifecycleReportV1Schema,
  computeAgentLifecycleReportV1Hash,
  evaluateAgentLifecycleCheckpointV1,
  normalizeAgentLifecycleCheckpointRequestV1,
  serializeControlReport,
} from "../src";

const preWriteImplementationStages = [
  "inspect_repository",
  "semantic_check",
  "status",
  "frame_task",
  "bind_scope",
  "trace_impact",
  "authority",
  "refine",
  "change_contract",
] as const;

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    checkpoint: "before_implementation_write",
    profile: "implementation",
    requiredAltitude: 2,
    recordedStageIds: [],
    priorTouchedCoordinateIds: [],
    newlyObservedTouchedCoordinateIds: [],
    ...overrides,
  };
}

describe("agent lifecycle policy", () => {
  test("publishes the exact shadow-only checkpoint contract", () => {
    expect(AgentLifecyclePolicyV1Schema.parse(AGENT_LIFECYCLE_POLICY_V1)).toEqual({
      schemaVersion: 1,
      kind: "agent_lifecycle_policy",
      enforcementMode: "shadow",
      blockingEnabled: false,
      executionAuthority: "none",
      nonSemctxRepository: "no_op",
      stageOutcomeEvaluation: "none",
      sourceCollection: "none",
      mcpTool: "semctx_control_agent_lifecycle",
      coordinateAccumulation: "stateless_caller_reinjected_unbound",
      limits: {
        maxRecordedStageIds: 15,
        maxPriorTouchedCoordinateIds: 512,
        maxNewlyObservedTouchedCoordinateIds: 256,
        maxAccumulatedTouchedCoordinateIds: 512,
        maxCoordinateIdCharacters: 512,
      },
      checkpoints: [
        {
          id: "before_implementation_write",
          minimumAltitude: 2,
          requiredStageIds: {
            implementation: [...preWriteImplementationStages],
            migration: [
              "inspect_repository",
              "semantic_check",
              "status",
              "frame_task",
              "bind_scope",
              "trace_impact",
              "authority",
              "target_propose",
              "refine",
              "change_contract",
            ],
          },
        },
        {
          id: "after_repository_edits",
          minimumAltitude: 0,
          requiredStageIds: { implementation: [], migration: [] },
        },
        {
          id: "before_completion",
          minimumAltitude: 0,
          requiredStageIds: {
            implementation: ["reconcile_diff", "verify_change", "change_verify"],
            migration: ["reconcile_diff", "verify_change", "change_verify"],
          },
        },
        {
          id: "before_compaction",
          minimumAltitude: 0,
          requiredStageIds: {
            implementation: ["handoff"],
            migration: ["handoff"],
          },
        },
      ],
    });
  });

  test("rejects literal, order, duplicate, and workflow-membership drift", () => {
    expect(AgentLifecyclePolicyV1Schema.safeParse({
      ...AGENT_LIFECYCLE_POLICY_V1,
      blockingEnabled: true,
    }).success).toBe(false);
    expect(AgentLifecyclePolicyV1Schema.safeParse({
      ...AGENT_LIFECYCLE_POLICY_V1,
      checkpoints: [...AGENT_LIFECYCLE_POLICY_V1.checkpoints].reverse(),
    }).success).toBe(false);
    const first = AGENT_LIFECYCLE_POLICY_V1.checkpoints[0];
    expect(AgentLifecyclePolicyV1Schema.safeParse({
      ...AGENT_LIFECYCLE_POLICY_V1,
      checkpoints: [
        {
          ...first,
          requiredStageIds: {
            ...first.requiredStageIds,
            implementation: ["status", "status"],
          },
        },
        ...AGENT_LIFECYCLE_POLICY_V1.checkpoints.slice(1),
      ],
    }).success).toBe(false);
  });
});

describe("agent lifecycle request", () => {
  test("normalizes stage order and opaque coordinate ids deterministically", () => {
    const normalized = normalizeAgentLifecycleCheckpointRequestV1(request({
      recordedStageIds: ["change_contract", "status", "status", "inspect_repository"],
      priorTouchedCoordinateIds: ["repo:z", "semantic:a", "repo:z"],
      newlyObservedTouchedCoordinateIds: ["repo:b", "semantic:a"],
    }));
    expect(normalized.recordedStageIds).toEqual([
      "inspect_repository",
      "status",
      "change_contract",
    ]);
    expect(normalized.priorTouchedCoordinateIds).toEqual(["repo:z", "semantic:a"]);
    expect(normalized.newlyObservedTouchedCoordinateIds).toEqual(["repo:b", "semantic:a"]);
    expect(AgentLifecycleCheckpointRequestV1Schema.parse(normalized)).toEqual(normalized);
    expect(AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
      priorTouchedCoordinateIds: ["repo:const x = sourceLookingButOpaque"],
    })).success).toBe(true);
  });

  test("rejects unknown authority, source, task, telemetry, and applicability fields", () => {
    for (const field of [
      "blockingEnabled",
      "executionAuthority",
      "sourceContent",
      "rawTask",
      "prompt",
      "telemetry",
      "repositoryState",
      "semanticContextPresent",
    ]) {
      expect(AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
        [field]: field === "blockingEnabled" ? true : "caller-controlled",
      })).success).toBe(false);
    }
  });

  test("enforces coordinate syntax and raw/accumulated policy limits", () => {
    for (const coordinate of [
      "",
      "repo:",
      "other:id",
      " repo:id",
      "repo:id ",
      "repo:a\nb",
      "semantic:a\u0000b",
      `repo:${"x".repeat(508)}`,
    ]) {
      expect(AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
        priorTouchedCoordinateIds: [coordinate],
      })).success).toBe(false);
    }
    expect(AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
      priorTouchedCoordinateIds: [`repo:${"x".repeat(507)}`],
    })).success).toBe(true);

    const recordedIssue = AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
      recordedStageIds: Array.from({ length: 16 }, () => "status"),
    }));
    expect(recordedIssue.success).toBe(false);
    if (!recordedIssue.success) {
      expect(recordedIssue.error.issues[0]).toMatchObject({
        code: "too_big",
        path: ["recordedStageIds"],
      });
    }

    for (const [field, values] of [
      [
        "priorTouchedCoordinateIds",
        Array.from({ length: 513 }, (_, index) => `repo:p${index}`),
      ],
      [
        "newlyObservedTouchedCoordinateIds",
        Array.from({ length: 257 }, (_, index) => `semantic:n${index}`),
      ],
    ] as const) {
      const result = AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
        [field]: values,
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({
          code: "too_big",
          path: [field],
        }));
      }
    }

    const unionIssue = AgentLifecycleCheckpointRequestV1Schema.safeParse(request({
      priorTouchedCoordinateIds: Array.from({ length: 512 }, (_, index) => `repo:p${index}`),
      newlyObservedTouchedCoordinateIds: ["semantic:new"],
    }));
    expect(unionIssue.success).toBe(false);
    if (!unionIssue.success) {
      expect(unionIssue.error.issues).toContainEqual(expect.objectContaining({
        code: "custom",
        path: ["newlyObservedTouchedCoordinateIds"],
        message: "accumulated touched coordinate limit exceeds 512",
      }));
    }
  });
});

describe("agent lifecycle evaluator and report identity", () => {
  test("implements the repository/altitude no-op table and clears caller arrays", () => {
    const nonSemctx = evaluateAgentLifecycleCheckpointV1("non_semctx", request({
      recordedStageIds: ["status"],
      priorTouchedCoordinateIds: ["repo:x"],
    }));
    expect(nonSemctx).toMatchObject({
      requiredAltitude: 2,
      applicability: "not_applicable",
      repositoryState: "non_semctx",
      stagePresenceVerdict: "NO_OP",
      reasonCodes: ["NON_SEMCTX_REPOSITORY"],
      requiredStageIds: [],
      recordedStageIds: [],
      missingStageIds: [],
      accumulatedTouchedCoordinateIds: [],
    });

    const belowThreshold = evaluateAgentLifecycleCheckpointV1("semctx_unready", request({
      requiredAltitude: 1,
    }));
    expect(belowThreshold.reasonCodes).toEqual([
      "BELOW_L2_CHECKPOINT_THRESHOLD",
      "SEMCTX_REPOSITORY_UNREADY",
    ]);
    expect(belowThreshold.stagePresenceVerdict).toBe("NO_OP");
    expect(belowThreshold.requiredAltitude).toBe(1);
  });

  test("requires canonical profile/checkpoint stages and evaluates presence only", () => {
    const incomplete = evaluateAgentLifecycleCheckpointV1("semctx_unready", request({
      profile: "migration",
      recordedStageIds: ["change_contract", "inspect_repository", "status"],
    }));
    expect(incomplete).toMatchObject({
      applicability: "eligible",
      stagePresenceVerdict: "INCOMPLETE",
      stageOutcomesEvaluated: false,
      admissibility: "not_evaluated",
      reasonCodes: ["SEMCTX_REPOSITORY_UNREADY", "REQUIRED_STAGE_NOT_RECORDED"],
    });
    expect(incomplete.missingStageIds).toEqual([
      "semantic_check",
      "frame_task",
      "bind_scope",
      "trace_impact",
      "authority",
      "target_propose",
      "refine",
    ]);

    const recorded = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      recordedStageIds: [...preWriteImplementationStages].reverse(),
    }));
    expect(recorded.stagePresenceVerdict).toBe("RECORDED");
    expect(recorded.recordedStageIds).toEqual(preWriteImplementationStages);
    expect(recorded.missingStageIds).toEqual([]);

    expect(evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "before_completion",
      recordedStageIds: ["change_verify", "verify_change"],
    })).missingStageIds).toEqual(["reconcile_diff"]);
    expect(evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "before_compaction",
      recordedStageIds: ["handoff"],
    })).stagePresenceVerdict).toBe("RECORDED");
  });

  test("folds eligible touched coordinates and hashes equivalent requests identically", () => {
    const left = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "after_repository_edits",
      recordedStageIds: ["status", "inspect_repository", "status"],
      priorTouchedCoordinateIds: ["semantic:z", "repo:a"],
      newlyObservedTouchedCoordinateIds: ["repo:b", "repo:a"],
    }));
    const right = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "after_repository_edits",
      recordedStageIds: ["inspect_repository", "status"],
      priorTouchedCoordinateIds: ["repo:a", "semantic:z"],
      newlyObservedTouchedCoordinateIds: ["repo:a", "repo:b"],
    }));
    expect(left.accumulatedTouchedCoordinateIds).toEqual(["repo:a", "repo:b", "semantic:z"]);
    expect(left).toEqual(right);
    expect(serializeControlReport(left)).toBe(serializeControlReport(right));
    expect(left).toMatchObject({
      touchEvidence: "caller_observed_advisory",
      accumulationSemantics: "stateless_caller_reinjected_unbound",
      enforcementMode: "shadow",
      blockingEnabled: false,
      executionAuthority: "none",
      sourceContentCollected: false,
    });
  });

  test("uses a domain-separated hash and rejects hash or relation mutation", () => {
    const report = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "before_compaction",
      recordedStageIds: ["handoff"],
    }));
    const { reportHash: _reportHash, ...preimage } = report;
    expect(report.reportHash).toBe(computeAgentLifecycleReportV1Hash(preimage));
    expect(report.reportHash).toBe(
      "sha256:0ea86e4ef9b7b12a88fca3aac830a44e401ee68596d17266e788da743a525506",
    );
    expect(serializeControlReport(AgentLifecycleReportV1Schema.parse(report)))
      .toBe(serializeControlReport(report));

    expect(AgentLifecycleReportV1Schema.safeParse({
      ...report,
      reportHash: `sha256:${"0".repeat(64)}`,
    }).success).toBe(false);
    expect(AgentLifecycleReportV1Schema.safeParse({
      ...report,
      blockingEnabled: true,
    }).success).toBe(false);

    const inconsistent = {
      ...report,
      stagePresenceVerdict: "INCOMPLETE",
      missingStageIds: [],
    } as const;
    expect(AgentLifecycleReportV1Schema.safeParse({
      ...inconsistent,
      reportHash: computeAgentLifecycleReportV1Hash(inconsistent),
    }).success).toBe(false);

    const altitudeInconsistent = {
      ...evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
        requiredAltitude: 1,
      })),
      requiredAltitude: 2 as const,
    };
    const {
      reportHash: _altitudeReportHash,
      ...altitudeInconsistentPreimage
    } = altitudeInconsistent;
    expect(AgentLifecycleReportV1Schema.safeParse({
      ...altitudeInconsistentPreimage,
      reportHash: computeAgentLifecycleReportV1Hash(altitudeInconsistentPreimage),
    }).success).toBe(false);

    const differentAltitude = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      checkpoint: "before_compaction",
      requiredAltitude: 6,
      recordedStageIds: ["handoff"],
    }));
    expect(differentAltitude.requiredAltitude).toBe(6);
    expect(differentAltitude.reportHash).not.toBe(report.reportHash);
  });

  test("keeps every report stage array in the unchanged workflow vocabulary", () => {
    const report = evaluateAgentLifecycleCheckpointV1("semctx_ready", request({
      recordedStageIds: [...AGENT_WORKFLOW_STAGE_ORDER].reverse(),
    }));
    expect(report.recordedStageIds).toEqual(AGENT_WORKFLOW_STAGE_ORDER);
  });
});
