import { z } from "zod-v4";
import {
  AltitudeAuthorityReportV1Schema,
  ArchitectureComparisonReportSchema,
  ControlFreshnessReasonSchema,
  ControlFreshnessSealV2Schema,
  ControlFreshnessStatusReportSchema,
  ControlReasonCodeV1Schema,
  ControlTerminalStatusV1Schema,
  CoordinateGraphReportV2Schema,
  DeletionAuthorizationReportV2Schema,
  ExplanationReportSchema,
  ImpactReportSchema,
  MigrationPlanReportSchema,
  PlanningBundleV1Schema,
  ReconcileDiffReportV1Schema,
  RefinementCoverageReportV1Schema,
  StepAuthorizationReportV2Schema,
  TaskEnvelopeV1Schema,
  TransitionAuthorizationReportV2Schema,
  TraversalReportV2Schema,
  WorkspaceBaselineSnapshotV1Schema,
} from "@semantic-context/control-model";
import {
  ChangeContractSchema as SemanticChangeContractSchema,
  RepositoryLinkSchema,
  SemanticNodeSchema,
} from "@semantic-context/semantic-model";
import { TargetArchitectureArtifactV1Schema } from "@semantic-context/semantic-engine";
import { ControlExplorerOutputSchema } from "./control-explorer";
import { mcpSchema } from "./schema-boundary";
import type { SemctxToolName } from "./tool-contract";

const described = <T extends z.ZodType>(schema: T, description: string): T =>
  schema.describe(description) as T;

const stringArray = (description: string): z.ZodArray<z.ZodString> =>
  z.array(z.string()).describe(description);

const EvidenceRefSchema = z.object({
  filePath: described(z.string(), "Repository-relative evidence file path."),
  startLine: described(z.number().int().positive().optional(), "Optional first evidence line."),
  endLine: described(z.number().int().positive().optional(), "Optional last evidence line."),
  sourceKind: described(
    z.enum(["code", "test", "document", "git", "runtime", "manual"]),
    "Kind of source that carries the evidence.",
  ),
  excerpt: described(z.string().optional(), "Optional source excerpt."),
}).strict();

const RepositoryNodeSchema = z.object({
  id: described(z.string(), "Stable repository-node identifier."),
  kind: described(z.enum([
    "repository", "package", "module", "symbol", "type", "function", "class",
    "interface", "enum", "test", "migration", "document", "contract",
    "invariant", "capability", "bounded_context", "decision", "risk",
    "external_integration",
  ]), "Repository node kind."),
  name: described(z.string(), "Human-readable node name."),
  filePath: described(z.string().optional(), "Optional repository-relative file path."),
  boundedContext: described(z.string().optional(), "Optional bounded-context identifier."),
  exported: described(z.boolean().optional(), "Whether the node is exported."),
  evidence: described(z.array(EvidenceRefSchema), "Evidence supporting the node."),
  tags: stringArray("Node tags."),
  metadata: described(
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    "Open scalar metadata emitted by repository analyzers.",
  ),
}).strict();

const ClaimSchema = z.object({
  id: described(z.string(), "Stable claim identifier."),
  kind: described(z.enum([
    "contract", "invariant", "decision", "capability", "behavior", "risk",
    "ownership", "deprecation", "assumption",
  ]), "Claim kind."),
  statement: described(z.string(), "Claim statement."),
  subjectNodeIds: stringArray("Repository nodes governed by the claim."),
  evidenceIds: stringArray("Evidence identifiers supporting the claim."),
  authority: described(z.number().min(0).max(1), "Authority score."),
  freshness: described(z.number().min(0).max(1), "Freshness score."),
  confidence: described(z.number().min(0).max(1), "Confidence score."),
  verificationStatus: described(z.enum([
    "unverified", "inferred", "documented", "tested", "statically_verified",
    "runtime_verified", "contradicted", "deprecated",
  ]), "Claim verification status."),
  validFrom: described(z.string().optional(), "Optional validity start."),
  validUntil: described(z.string().optional(), "Optional validity end."),
  tags: stringArray("Claim tags."),
}).strict();

const VerifyReportSymbolSchema = z.object({
  id: described(z.string(), "Stable symbol identifier."),
  name: described(z.string(), "Symbol name."),
  kind: described(z.string(), "Symbol kind."),
  file: described(z.string().optional(), "Optional repository-relative file."),
}).strict();

const VerifyReportClaimSchema = z.object({
  statement: described(z.string(), "Claim statement."),
  kind: described(z.string(), "Claim kind."),
  verificationStatus: described(z.string(), "Claim verification status."),
}).strict();

const VerifyReportSchema = z.object({
  schemaVersion: described(z.literal(1), "Verify-report schema version."),
  verdict: described(z.enum(["PASS", "WARN", "BLOCK"]), "Overall deterministic verdict."),
  base: described(z.string().nullable(), "Requested base ref, if any."),
  head: described(z.string(), "Analyzed head commit."),
  mergeBase: described(z.string().nullable(), "Resolved merge-base commit."),
  range: described(z.string().nullable(), "Human-readable analyzed Git range."),
  changedFiles: stringArray("Changed repository files."),
  changedSymbols: described(z.array(VerifyReportSymbolSchema), "Changed symbols."),
  impactedContracts: described(z.array(VerifyReportClaimSchema), "Impacted contract claims."),
  impactedInvariants: described(z.array(VerifyReportClaimSchema), "Impacted invariant claims."),
  recommendedTests: described(z.array(z.object({
    name: described(z.string(), "Test name."),
    file: described(z.string().optional(), "Optional test file."),
  }).strict()), "Recommended tests."),
  contradictions: described(z.array(VerifyReportClaimSchema), "Contradicted or deprecated claims."),
  unknowns: stringArray("Remaining analysis unknowns."),
  findings: described(z.array(z.object({
    rule: described(z.string(), "Triggered blocking-rule identifier."),
    tier: described(z.enum(["strict", "advisory"]), "Rule enforcement tier."),
    severity: described(z.enum(["warn", "block"]), "Finding severity."),
    message: described(z.string(), "Finding explanation."),
    nodeIds: stringArray("Repository nodes supporting the finding."),
    locations: described(z.array(z.object({
      file: described(z.string(), "Repository-relative file."),
      line: described(z.number().int().positive().optional(), "Optional source line."),
    }).strict()), "Concrete source locations."),
  }).strict()), "Verification findings."),
  impactedConsumers: described(z.array(z.object({
    symbol: described(VerifyReportSymbolSchema, "Impacted exported symbol."),
    consumers: described(z.array(VerifyReportSymbolSchema), "In-repository consumers."),
  }).strict()).optional(), "Optional consumer impact details."),
  coChangedFiles: described(z.array(z.object({
    file: described(z.string(), "Changed file."),
    coChanged: described(z.array(z.object({
      file: described(z.string(), "Historically co-changing file."),
      commits: described(z.number().int().nonnegative(), "Supporting commit count."),
    }).strict()), "Historical co-change evidence."),
  }).strict()).optional(), "Optional historical co-change signal."),
  summary: described(z.object({
    blockCount: described(z.number().int().nonnegative(), "Blocking finding count."),
    warnCount: described(z.number().int().nonnegative(), "Warning finding count."),
  }).strict(), "Finding counts."),
}).strict();

const InspectionResultSchema = z.object({
  query: described(z.string(), "Original inspection query."),
  kind: described(
    z.enum(["symbol", "capability", "invariant", "contract", "test", "document", "any"]),
    "Applied inspection kind.",
  ),
  matchedNodes: described(z.array(RepositoryNodeSchema), "Matching repository nodes."),
  relatedClaims: described(z.array(ClaimSchema), "Claims related to matched nodes."),
  relations: described(z.array(z.object({
    from: described(z.string(), "Source node identifier."),
    fromName: described(z.string(), "Source node name."),
    kind: described(z.string(), "Repository edge kind."),
    to: described(z.string(), "Target node identifier."),
    toName: described(z.string(), "Target node name."),
  }).strict()), "Relations touching matched nodes."),
  contradictions: described(z.array(ClaimSchema), "Contradicted or deprecated related claims."),
  evidence: described(z.array(EvidenceRefSchema.extend({
    id: described(z.string(), "Stable evidence identifier."),
  }).strict()), "Resolved evidence records."),
  filesToRead: stringArray("Repository files justified for reading."),
}).strict();

const TaskFrameSchema = z.object({
  id: described(z.string(), "Stable task-frame identifier."),
  rawTask: described(z.string(), "Original task text."),
  mode: described(z.enum(["bugfix", "feature", "refactor", "audit", "performance", "security", "migration"]), "Task mode."),
  capabilities: stringArray("Relevant capabilities."),
  observedBehavior: stringArray("Observed behaviours."),
  expectedBehavior: stringArray("Expected behaviours."),
  boundedContexts: stringArray("Relevant bounded contexts."),
  hardInvariants: stringArray("Hard invariants."),
  softConstraints: stringArray("Soft constraints."),
  acceptanceEvidence: stringArray("Required acceptance evidence."),
  nonGoals: stringArray("Explicit non-goals."),
  riskSurfaces: stringArray("Risk surfaces."),
  hypotheses: described(z.array(z.object({
    id: described(z.string(), "Hypothesis identifier."),
    statement: described(z.string(), "Hypothesis statement."),
    confidence: described(z.number().min(0).max(1), "Hypothesis confidence."),
    evidenceIds: stringArray("Supporting evidence identifiers."),
    status: described(z.enum(["unverified", "supported", "rejected"]), "Hypothesis status."),
  }).strict()), "Task hypotheses."),
  createdAt: described(z.string(), "ISO creation timestamp."),
}).strict();

const ContextPackSchema = z.object({
  taskFrame: described(TaskFrameSchema, "Compiled task frame."),
  hardConstraints: described(z.array(ClaimSchema), "Hard constraint claims."),
  authoritativeClaims: described(z.array(ClaimSchema), "Authoritative task-relative claims."),
  primaryNodes: described(z.array(RepositoryNodeSchema), "Primary repository nodes."),
  secondaryNodes: described(z.array(RepositoryNodeSchema), "Secondary repository nodes."),
  impactPaths: described(z.array(z.object({
    nodeIds: stringArray("Nodes in the path."),
    edgeKinds: stringArray("Repository edge kinds in the path."),
    description: described(z.string(), "Path explanation."),
  }).strict()), "Structural impact paths."),
  relevantTests: described(z.array(RepositoryNodeSchema), "Relevant test nodes."),
  contradictions: described(z.array(ClaimSchema), "Contradictory claims."),
  unknowns: stringArray("Unresolved context unknowns."),
  recommendedReads: described(z.array(z.object({
    path: described(z.string(), "Repository-relative path."),
    reason: described(z.string(), "Why the file should be read."),
    priority: described(z.enum(["critical", "high", "medium"]), "Read priority."),
    evidenceIds: stringArray("Evidence supporting the recommendation."),
  }).strict()), "Justified reads."),
  verificationPlan: described(z.object({
    steps: described(z.array(z.object({
      description: described(z.string(), "Verification step."),
      kind: described(z.enum(["run_test", "static_check", "manual_review", "reproduce"]), "Verification step kind."),
      command: described(z.string().optional(), "Optional command."),
      targetNodeIds: stringArray("Target repository nodes."),
      evidenceIds: stringArray("Evidence identifiers."),
    }).strict()), "Ordered verification steps."),
    requiredTests: stringArray("Required tests."),
    notes: stringArray("Verification notes."),
  }).strict(), "Verification plan."),
  generatedAt: described(z.string(), "ISO generation timestamp."),
  evidence: described(z.array(EvidenceRefSchema.extend({
    id: described(z.string(), "Stable evidence identifier."),
  }).strict()), "Evidence referenced by the pack."),
  priorityExplanations: described(z.array(z.object({
    targetId: described(z.string(), "Ranked target identifier."),
    targetKind: described(z.enum(["node", "claim"]), "Ranked target kind."),
    score: described(z.number(), "Composite priority score."),
    eligible: described(z.boolean(), "Whether the target passed gates."),
    roleMatch: described(z.number(), "Task-role match score."),
    authority: described(z.number(), "Authority score."),
    graphReachability: described(z.number(), "Graph reachability score."),
    verificationStrength: described(z.number(), "Verification strength score."),
    freshness: described(z.number(), "Freshness score."),
    contradictionPenalty: described(z.number(), "Contradiction penalty."),
    gates: described(z.array(z.object({
      name: described(z.string(), "Gate name."),
      passed: described(z.boolean(), "Gate result."),
      reason: described(z.string(), "Gate rationale."),
    }).strict()), "Eligibility gates."),
    explanation: stringArray("Ranking rationale."),
  }).strict()), "Inspectable ranking rationale."),
  meta: described(z.object({
    taskId: described(z.string(), "Task-frame identifier."),
    questionKind: described(z.enum(["public_api", "persistence", "business_rule", "runtime_behavior", "historical_reason", "style", "security"]), "Question kind."),
    deterministic: described(z.boolean(), "Whether generation is deterministic."),
    generator: described(z.string(), "Generator identity."),
    candidateProviders: stringArray("Candidate provider identities."),
    warnings: stringArray("Context-pack warnings."),
  }).strict(), "Context-pack metadata."),
}).strict();

const PrepareTaskResultSchema = z.object({
  taskFrame: described(TaskFrameSchema, "Extracted task frame."),
  contextPack: described(ContextPackSchema, "Compiled context pack."),
}).strict();

const DiagnosticSchema = z.object({
  severity: described(z.enum(["error", "warning"]), "Diagnostic severity."),
  message: described(z.string(), "Diagnostic message."),
  file: described(z.string(), "Source file."),
  line: described(z.number().int().positive(), "One-based source line."),
  column: described(z.number().int().positive(), "One-based source column."),
  code: described(z.string().optional(), "Optional diagnostic code."),
}).passthrough();

const LinkResolutionSchema = z.object({
  ownerId: described(z.string(), "Semantic owner identifier."),
  link: described(mcpSchema(RepositoryLinkSchema), "Repository link."),
  resolved: described(z.boolean(), "Whether the link resolves."),
  reason: described(z.string().optional(), "Unresolved-link reason."),
}).passthrough();

const SemanticCheckSchema = z.object({
  schemaVersion: described(z.literal(1), "Semantic-check schema version."),
  kind: described(z.literal("semantic_check"), "Report kind."),
  ok: described(z.boolean(), "Whether semantic state is valid."),
  reasonCodes: stringArray("Canonical semantic-check reason codes."),
  diagnostics: described(z.array(DiagnosticSchema), "DSL diagnostics."),
  duplicateIds: stringArray("Duplicate semantic identifiers."),
  invalidIds: described(z.array(z.object({
    id: described(z.string(), "Invalid semantic identifier."),
    kind: described(z.string(), "Semantic entity kind."),
  }).strict()), "Invalid identifiers."),
  danglingReferences: described(z.array(z.object({
    ownerId: described(z.string(), "Owner identifier."),
    field: described(z.string(), "Referencing field."),
    ref: described(z.string(), "Missing target identifier."),
  }).passthrough()), "Dangling semantic references."),
  staleLinks: described(z.array(LinkResolutionSchema), "Stale repository links."),
  lifecycleFindings: described(z.array(z.object({
    code: described(z.string(), "Lifecycle reason code."),
    severity: described(z.enum(["error", "warning"]), "Lifecycle severity."),
    message: described(z.string(), "Lifecycle finding message."),
    subjectIds: stringArray("Affected semantic identifiers."),
  }).strict()), "Lifecycle findings."),
  graphIndexed: described(z.boolean(), "Whether a repository graph was available."),
  counts: described(z.object({
    nodes: described(z.number().int().nonnegative(), "Semantic node count."),
    changes: described(z.number().int().nonnegative(), "Change-contract count."),
    errors: described(z.number().int().nonnegative(), "Error count."),
    warnings: described(z.number().int().nonnegative(), "Warning count."),
  }).strict(), "Report counts."),
}).strict();

const SemanticNode = mcpSchema(SemanticNodeSchema);
const SemanticChange = mcpSchema(SemanticChangeContractSchema);
const SemanticSliceSchema = z.object({
  slice: described(z.object({
    scope: described(z.object({
      changeId: described(z.string().optional(), "Optional change seed."),
      symbolRef: described(z.string().optional(), "Optional symbol seed."),
      claimRef: described(z.string().optional(), "Optional claim seed."),
      maxNodes: described(z.number().int().positive(), "Applied node cap."),
    }).strict(), "Explicit slice scope."),
    truncated: described(z.boolean(), "Whether the node cap truncated traversal."),
    intentions: described(z.array(SemanticNode), "Selected goal nodes."),
    invariants: described(z.array(SemanticNode), "Selected invariant nodes."),
    decisions: described(z.array(SemanticNode), "Selected decision nodes."),
    assumptions: described(z.array(SemanticNode), "Selected assumption nodes."),
    changes: described(z.array(SemanticChange), "Selected change contracts."),
    linkedRepository: described(z.array(mcpSchema(RepositoryLinkSchema)), "Selected repository links."),
    evidence: described(z.array(SemanticNode), "Selected evidence nodes."),
    openUnknowns: described(z.array(SemanticNode), "Selected unknown nodes."),
    safetyConstraints: described(z.array(SemanticNode), "Critical selected invariants."),
    nextProofs: stringArray("Outstanding required evidence identifiers."),
  }).strict(), "Bounded semantic slice."),
  capsule: described(z.string(), "Rendered deterministic slice capsule."),
}).strict();

const ChangeVerifySchema = z.object({
  schemaVersion: described(z.literal(1), "Change-verification schema version."),
  changeId: described(z.string(), "Verified change identifier."),
  lifecycle: described(z.string(), "Current change lifecycle."),
  verdict: described(z.enum(["VERIFIED", "PARTIAL", "BLOCKED", "STALE"]), "Composed semantic verdict."),
  underlying: described(VerifyReportSchema, "Underlying Plane-A verify report."),
  preserved: described(z.array(z.object({
    id: described(z.string(), "Invariant identifier."),
    statement: described(z.string(), "Invariant statement."),
    critical: described(z.boolean(), "Whether the invariant is critical."),
    state: described(z.enum(["proved", "unproven", "untouched", "contradicted", "missing"]), "Preservation state."),
    footprint: stringArray("Repository-coordinate footprint."),
  }).strict()), "Preserved invariant evaluations."),
  provedEvidence: described(z.array(z.object({
    id: described(z.string(), "Evidence identifier."),
    statement: described(z.string(), "Evidence statement."),
    proved: described(z.boolean(), "Whether evidence is proven."),
    status: described(z.string(), "Evidence status."),
  }).strict()), "Proven evidence."),
  pendingEvidence: described(z.array(z.object({
    id: described(z.string(), "Evidence identifier."),
    statement: described(z.string(), "Evidence statement."),
    proved: described(z.boolean(), "Whether evidence is proven."),
    status: described(z.string(), "Evidence status or missing."),
  }).strict()), "Pending evidence."),
  openUnknowns: described(z.array(z.object({
    id: described(z.string(), "Unknown identifier."),
    statement: described(z.string(), "Unknown statement."),
    critical: described(z.boolean(), "Whether the unknown is critical."),
    present: described(z.boolean(), "Whether it exists in the model."),
  }).strict()), "Open unknowns."),
  stale: described(z.array(z.object({
    kind: described(z.string(), "Finding kind."),
    severity: described(z.enum(["warn", "block", "stale"]), "Finding severity."),
    message: described(z.string(), "Finding message."),
    refs: stringArray("Related identifiers."),
  }).strict()), "Staleness findings."),
  findings: described(z.array(z.object({
    kind: described(z.string(), "Finding kind."),
    severity: described(z.enum(["warn", "block", "stale"]), "Finding severity."),
    message: described(z.string(), "Finding message."),
    refs: stringArray("Related identifiers."),
  }).strict()), "All semantic findings."),
}).strict();

const SemanticInspectionSchema = z.object({
  id: described(z.string(), "Inspected semantic identifier."),
  found: described(z.boolean(), "Whether the entity exists."),
  node: described(SemanticNode.optional(), "Semantic node, when found."),
  change: described(SemanticChange.optional(), "Change contract, when found."),
  incoming: described(z.array(z.object({
    from: described(z.string(), "Referencing semantic identifier."),
    field: described(z.string(), "Referencing relation or field."),
  }).strict()), "Incoming semantic references."),
  linkResolutions: described(z.array(LinkResolutionSchema), "Repository-link resolutions."),
}).strict();

const HandoffSchema = z.object({
  version: described(z.literal(1), "Handoff-capsule schema version."),
  createdAt: described(z.string(), "ISO capture timestamp."),
  activeChangeId: described(z.string().optional(), "Optional active change identifier."),
  changeLifecycle: described(z.string().optional(), "Optional active change lifecycle."),
  statement: described(z.string().optional(), "Optional active change statement."),
  touchedInvariants: stringArray("Invariants to preserve."),
  proofsObtained: stringArray("Evidence already proven."),
  pendingProofs: stringArray("Evidence still pending."),
  activeAssumptions: stringArray("Active assumption identifiers."),
  exploredLinks: stringArray("Repository links already explored."),
  openUnknowns: stringArray("Open unknown identifiers."),
  nextValidations: stringArray("Next required validations."),
  note: described(z.string().optional(), "Optional handoff note."),
}).strict();

const ResumeSchema = z.union([
  HandoffSchema,
  z.object({
    message: described(z.string(), "Why no resumable semantic state exists."),
  }).strict(),
]);

const envelope = <K extends string>(kind: K, payload: z.ZodType): z.ZodType =>
  z.object({
    schemaVersion: described(z.literal(1), "Control-query envelope schema version."),
    kind: described(z.literal(kind), "Control-query kind."),
    freshness: described(z.object({
      verdict: described(
        z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]),
        "Control freshness verdict.",
      ),
      reasons: described(z.array(mcpSchema(ControlFreshnessReasonSchema)), "Freshness reason codes."),
      seal: described(mcpSchema(ControlFreshnessSealV2Schema).nullable(), "Bound control freshness seal."),
    }).strict(), "Freshness preflight."),
    terminalStatus: described(mcpSchema(ControlTerminalStatusV1Schema), "Query terminal status."),
    reasonCodes: described(z.array(mcpSchema(ControlReasonCodeV1Schema)), "Canonical reason codes."),
    payload: described(payload.nullable(), "Typed query payload, or null on refusal/empty result."),
  }).strict();

const ControlGraphEnvelope = envelope("coordinate_graph", mcpSchema(CoordinateGraphReportV2Schema));
const ControlTraversalEnvelope = envelope("traversal", mcpSchema(TraversalReportV2Schema));
const ControlCoverageEnvelope = envelope("refinement_coverage", mcpSchema(RefinementCoverageReportV1Schema));
const ControlImpactEnvelope = envelope("impact", mcpSchema(ImpactReportSchema));
const ControlExplanationEnvelope = envelope("explanation", mcpSchema(ExplanationReportSchema));
const ControlArchitectureEnvelope = envelope("architecture_comparison", mcpSchema(ArchitectureComparisonReportSchema));
const TransitionEnvelope = envelope("authorize_transition", mcpSchema(TransitionAuthorizationReportV2Schema));
const StepEnvelope = envelope("authorize_step", mcpSchema(StepAuthorizationReportV2Schema));
const DeletionEnvelope = envelope("authorize_deletion", mcpSchema(DeletionAuthorizationReportV2Schema));

const TargetProposalSchema = z.object({
  schemaVersion: described(z.literal(1), "Target-proposal result schema version."),
  kind: described(z.literal("target_architecture_proposal"), "Result kind."),
  certifying: described(z.literal(false), "Proposal is non-certifying."),
  executionAuthority: described(z.literal("none"), "Proposal grants no execution authority."),
  relativePath: described(z.string(), "Repository-relative immutable artifact path."),
  artifact: described(mcpSchema(TargetArchitectureArtifactV1Schema), "Persisted target architecture artifact."),
}).strict();

const PreparedTaskEnvelopeSchema = z.object({
  schemaVersion: described(z.literal(1), "Prepared-task envelope schema version."),
  kind: described(z.literal("prepared_task_envelope"), "Prepared-task result kind."),
  certifying: described(z.literal(false), "The prepared task is diagnostic, not certifying."),
  envelope: described(
    mcpSchema(TaskEnvelopeV1Schema),
    "Canonical task envelope bound to the requested repository scope.",
  ),
  baseline: described(
    mcpSchema(WorkspaceBaselineSnapshotV1Schema),
    "Workspace baseline captured while preparing the task.",
  ),
}).strict();

/**
 * Precise machine-readable result contracts for every public semctx MCP tool.
 * Business-layer Zod 3 contracts cross the MCP v2 boundary only through mcpSchema.
 */
export const TOOL_OUTPUT_SCHEMAS = {
  semctx_verify_change: VerifyReportSchema,
  semctx_inspect: InspectionResultSchema,
  semctx_prepare_task: PrepareTaskResultSchema,
  semctx_semantic_check: SemanticCheckSchema,
  semctx_semantic_slice: SemanticSliceSchema,
  semctx_change_open: mcpSchema(SemanticChangeContractSchema),
  semctx_change_update: mcpSchema(SemanticChangeContractSchema),
  semctx_change_verify: ChangeVerifySchema,
  semctx_change_close: mcpSchema(SemanticChangeContractSchema),
  semctx_semantic_inspect: SemanticInspectionSchema,
  semctx_handoff: HandoffSchema,
  semctx_resume: ResumeSchema,
  semctx_control_status: mcpSchema(ControlFreshnessStatusReportSchema),
  semctx_control_authority: mcpSchema(AltitudeAuthorityReportV1Schema),
  semctx_control_trace: mcpSchema(TraversalReportV2Schema),
  semctx_control_graph: ControlGraphEnvelope,
  semctx_control_traversal: ControlTraversalEnvelope,
  semctx_control_refinement_coverage: ControlCoverageEnvelope,
  semctx_control_impact: ControlImpactEnvelope,
  semctx_control_explain_why: ControlExplanationEnvelope,
  semctx_control_compare_architecture: ControlArchitectureEnvelope,
  control_authorize_transition: TransitionEnvelope,
  control_authorize_step: StepEnvelope,
  control_authorize_deletion: DeletionEnvelope,
  semctx_control_plan: mcpSchema(MigrationPlanReportSchema),
  semctx_control_bind_scope: PreparedTaskEnvelopeSchema,
  semctx_control_frame_task: PreparedTaskEnvelopeSchema,
  semctx_control_plan_change: mcpSchema(PlanningBundleV1Schema),
  semctx_control_reconcile_diff: mcpSchema(ReconcileDiffReportV1Schema),
  semctx_control_target_propose: TargetProposalSchema,
  semctx_control_explorer: ControlExplorerOutputSchema,
} satisfies Record<SemctxToolName, z.ZodType>;
