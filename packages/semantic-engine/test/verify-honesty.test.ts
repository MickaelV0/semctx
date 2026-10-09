import { describe, it, expect } from "bun:test";
import type { RepositoryGraph, VerifyReport, VerifyReportFinding, SemanticPolicyConfig } from "@semantic-context/core";
import type { SemanticModel, ChangeContract } from "@semantic-context/semantic-model";
import { verifyChangeContract, DEFAULT_SEMANTIC_POLICY, type RepositoryFacts } from "../src/index";

const POLICY: SemanticPolicyConfig = DEFAULT_SEMANTIC_POLICY;

function facts(): RepositoryFacts {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, sourceKind: "code" }], tags: [], metadata: {} },
      { id: "inv:x", kind: "invariant", name: "x", evidence: [], tags: [], metadata: {} },
    ],
    edges: [{ id: "e1", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:x", evidence: [], metadata: {} }],
  };
  return { graph, claims: [], evidence: [] };
}

function warnReport(findings: VerifyReportFinding[]): VerifyReport {
  return {
    schemaVersion: 1, verdict: "WARN", base: null, head: "HEAD", mergeBase: null, range: null,
    changedFiles: ["x.ts"], changedSymbols: [{ id: "sym:function:x.ts:danger:5", name: "danger", kind: "function", file: "x.ts" }],
    impactedContracts: [], impactedInvariants: [], recommendedTests: [], contradictions: [], unknowns: [],
    findings, summary: { blockCount: 0, warnCount: findings.length },
  };
}

const WARN_FINDING: VerifyReportFinding = { rule: "contract_changed_without_test", tier: "advisory", severity: "warn", message: "x", nodeIds: ["sym:function:x.ts:danger:5"], locations: [] };

/** A change with no obligations of its own — isolates the underlying-report contribution. */
function bareChange(): ChangeContract {
  return { id: "change.c", statement: "c", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: [], preserves: [], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] };
}

function invModel(tags: string[]): SemanticModel {
  return {
    nodes: [{ id: "invariant.i", kind: "invariant", statement: "I", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "invariant", ref: "inv:x" }], relations: [], tags }],
    changes: [{ id: "change.c", statement: "c", lifecycle: "active", provenance: "agent", sourceRefs: [], serves: [], preserves: ["invariant.i"], requiresEvidence: [], openUnknowns: [], repositoryLinks: [], tags: [] }],
  };
}

describe("honesty: underlying WARN is never laundered into VERIFIED", () => {
  it("an underlying WARN with an otherwise-clean contract floors at PARTIAL", () => {
    const model: SemanticModel = { nodes: [], changes: [bareChange()] };
    const r = verifyChangeContract({ contract: bareChange(), model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.findings.some((f) => f.kind === "underlying_warn")).toBe(true);
  });

  it("explicit required test proof preserves a critical invariant under incomplete analysis without laundering WARN", () => {
    const repositoryFacts = facts();
    repositoryFacts.graph.nodes.push({
      id: "test:test/x.test.ts", kind: "test", name: "x.test.ts", filePath: "test/x.test.ts",
      evidence: [{ filePath: "test/x.test.ts", startLine: 1, sourceKind: "code" }], tags: [], metadata: {},
    });
    const model = invModel(["critical"]);
    const invariant = model.nodes[0]!;
    // Link directly to an indexed symbol so this tracer isolates WARN classification, not file-link expansion.
    invariant.repositoryLinks = [{ kind: "symbol", ref: "sym:function:x.ts:danger:5" }];
    invariant.relations = [{ kind: "proved_by", to: "proof.p" }];
    model.nodes.push({
      id: "proof.p", kind: "evidence", statement: "The indexed test proves preservation", status: "tested",
      provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "test", ref: "test:test/x.test.ts" }],
      relations: [], tags: [],
    });
    const contract = model.changes[0]!;
    contract.requiresEvidence = ["proof.p"];
    const underlying = warnReport([{
      rule: "analysis_scope_incomplete", tier: "advisory", severity: "warn",
      message: "Source analysis is incomplete; missing test coverage cannot be inferred",
      nodeIds: ["sym:function:x.ts:danger:5"], locations: [],
    }]);
    const originalUnderlying = structuredClone(underlying);
    const originalGraph = structuredClone(repositoryFacts.graph);
    expect(repositoryFacts.graph.edges.some((edge) => edge.kind === "tested_by" || edge.kind === "covers")).toBe(false);

    const r = verifyChangeContract({ contract, model, facts: repositoryFacts, verifyReport: underlying, policy: POLICY });

    expect(r.preserved).toEqual([{
      id: "invariant.i", statement: "I", critical: true, state: "proved",
      footprint: ["sym:function:x.ts:danger:5"],
    }]);
    expect(r.findings.some((finding) => finding.kind === "critical_invariant_unproven")).toBe(false);
    expect(r.provedEvidence).toEqual([{
      id: "proof.p", statement: "The indexed test proves preservation", proved: true, status: "tested",
    }]);
    expect(r.pendingEvidence).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.findings.some((finding) => finding.kind === "underlying_warn")).toBe(true);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.underlying).toBe(underlying);
    expect(r.underlying).toEqual(originalUnderlying);
    expect(underlying).toEqual(originalUnderlying);
    expect(repositoryFacts.graph).toEqual(originalGraph);
    expect(repositoryFacts.graph.edges.some((edge) => edge.kind === "tested_by" || edge.kind === "covers")).toBe(false);
  });
});

describe("honesty: an invariant touched under an advisory rule is never 'proved'", () => {
  it("non-critical → state unproven, verdict PARTIAL (not VERIFIED/proved)", () => {
    const model = invModel([]);
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("unproven");
    expect(r.verdict).toBe("PARTIAL");
  });

  it("critical → BLOCKED even though the repo relaxed the rule to warn", () => {
    const model = invModel(["critical"]);
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: warnReport([WARN_FINDING]), policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("unproven");
    expect(r.findings.some((f) => f.kind === "critical_invariant_unproven")).toBe(true);
    expect(r.verdict).toBe("BLOCKED");
  });

  it("a genuinely covered touch (no block/warn finding on it) is still 'proved'", () => {
    const model = invModel([]);
    const clean: VerifyReport = { ...warnReport([]), verdict: "PASS", summary: { blockCount: 0, warnCount: 0 } };
    const r = verifyChangeContract({ contract: model.changes[0]!, model, facts: facts(), verifyReport: clean, policy: POLICY });
    expect(r.preserved.find((p) => p.id === "invariant.i")?.state).toBe("proved");
    expect(r.verdict).toBe("VERIFIED");
  });
});

interface ProofFixture {
  repositoryFacts: RepositoryFacts;
  model: SemanticModel;
  invariant: SemanticModel["nodes"][number];
  evidence: SemanticModel["nodes"][number];
  contract: ChangeContract;
  underlying: VerifyReport;
}

/** An obtained, selected proof without any inferred coverage edges. */
function proofCase(): ProofFixture {
  const repositoryFacts = facts();
  repositoryFacts.graph.nodes.push({
    id: "test:test/x.test.ts", kind: "test", name: "x.test.ts", filePath: "test/x.test.ts",
    evidence: [], tags: [], metadata: {},
  });
  const model = invModel(["critical"]);
  const invariant = model.nodes[0]!;
  invariant.relations = [{ kind: "proved_by", to: "proof.p" }];
  const evidence: SemanticModel["nodes"][number] = {
    id: "proof.p", kind: "evidence", statement: "Indexed preservation test", status: "tested",
    provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "test", ref: "test:test/x.test.ts" }],
    relations: [], tags: [],
  };
  model.nodes.push(evidence);
  const contract = model.changes[0]!;
  contract.requiresEvidence = ["proof.p"];
  const underlying = warnReport([{
    rule: "analysis_scope_incomplete", tier: "advisory", severity: "warn",
    message: "Analysis cannot establish negative coverage", nodeIds: ["sym:function:x.ts:danger:5"], locations: [],
  }]);
  return { repositoryFacts, model, invariant, evidence, contract, underlying };
}

function verifyProofCase(fixture: ProofFixture, policy = POLICY) {
  return verifyChangeContract({
    contract: fixture.contract, model: fixture.model, facts: fixture.repositoryFacts,
    verifyReport: fixture.underlying, policy,
  });
}

describe("authored test proof admission under incomplete analysis", () => {
  it.each(["tested", "statically_verified", "runtime_verified"] as const)(
    "accepts obtained %s evidence but retains the incomplete WARN floor", (status) => {
      const fixture = proofCase();
      fixture.evidence.status = status;
      const r = verifyProofCase(fixture);
      expect(r.preserved[0]?.state).toBe("proved");
      expect(r.verdict).toBe("PARTIAL");
      expect(r.provedEvidence[0]?.status).toBe(status);
      expect(r.underlying).toBe(fixture.underlying);
      expect(r.findings.map((finding) => finding.kind)).toEqual(["underlying_warn"]);
    },
  );

  it.each(["declared", "proposed", "assumed", "stale", "contradicted"] as const)(
    "rejects %s evidence as an obtained preservation proof", (status) => {
      const fixture = proofCase();
      fixture.evidence.status = status;
      const r = verifyProofCase(fixture);
      expect(r.preserved[0]?.state).toBe("unproven");
      expect(r.verdict).toBe("BLOCKED");
      expect(r.pendingEvidence).toEqual([{ id: "proof.p", statement: "Indexed preservation test", proved: false, status }]);
      expect(r.provedEvidence).toEqual([]);
    },
  );

  const relevanceRefusals: Array<[string, (fixture: ProofFixture) => void]> = [
    ["absent proved_by", ({ invariant }) => { invariant.relations = []; }],
    ["reversed proved_by", ({ invariant, evidence }) => {
      invariant.relations = [];
      evidence.relations = [{ kind: "proved_by", to: invariant.id }];
    }],
    ["proof for another invariant", ({ invariant, model }) => {
      invariant.relations = [];
      model.nodes.push({ ...invariant, id: "invariant.other", relations: [{ kind: "proved_by", to: "proof.p" }] });
    }],
    ["an unrelated relation kind", ({ invariant }) => { invariant.relations = [{ kind: "depends_on", to: "proof.p" }]; }],
    ["evidence not required by the selected change", ({ contract }) => { contract.requiresEvidence = []; }],
    ["missing required evidence", ({ model }) => { model.nodes = model.nodes.filter((node) => node.id !== "proof.p"); }],
    ["a required tested node of the wrong kind", ({ evidence }) => { evidence.kind = "assumption"; }],
  ];
  it.each(relevanceRefusals)("rejects %s despite an indexed test", (_name, mutate) => {
    const fixture = proofCase();
    mutate(fixture);
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("unproven");
    expect(r.verdict).toBe("BLOCKED");
    expect(r.findings.find((finding) => finding.kind === "critical_invariant_unproven")?.message)
      .toContain("analysis is incomplete and no admissible authored test proof");
    expect(r.findings.find((finding) => finding.kind === "critical_invariant_unproven")?.message)
      .not.toContain("no covering test");
  });

  const targetRefusals: Array<[string, (fixture: ProofFixture) => void]> = [
    ["no repository links", ({ evidence }) => { evidence.repositoryLinks = []; }],
    ["only a function with a test-like name", ({ evidence, repositoryFacts }) => {
      repositoryFacts.graph.nodes.push({
        id: "sym:function:test/x.test.ts:test_danger", kind: "function", name: "test_danger", filePath: "test/x.test.ts",
        evidence: [], tags: [], metadata: {},
      });
      evidence.repositoryLinks = [{ kind: "symbol", ref: "sym:function:test/x.test.ts:test_danger" }];
    }],
    ["a test link whose indexed target is not a test", ({ repositoryFacts }) => {
      repositoryFacts.graph.nodes.find((node) => node.id === "test:test/x.test.ts")!.kind = "function";
    }],
  ];
  it.each(targetRefusals)("rejects %s without claiming the resolved link is stale", (_name, mutate) => {
    const fixture = proofCase();
    mutate(fixture);
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("unproven");
    expect(r.verdict).toBe("BLOCKED");
    expect(r.stale).toEqual([]);
    // Obtained evidence status alone remains reportable; it is not preservation admission.
    expect(r.provedEvidence.map((evidence) => evidence.id)).toEqual(["proof.p"]);
  });

  it.each(["evidence", "invariant"] as const)(
    "rejects a valid test mixed with a stale link on the %s", (owner) => {
      const fixture = proofCase();
      fixture[owner].repositoryLinks.push({ kind: "file", ref: "removed.ts" });
      const r = verifyProofCase(fixture);
      expect(r.preserved[0]?.state).toBe("unproven");
      expect(r.verdict).toBe("BLOCKED");
      expect(r.stale).toEqual([expect.objectContaining({ kind: "stale_link", refs: [fixture[owner].id, "removed.ts"] })]);
      fixture.invariant.tags = [];
      const advisory = verifyProofCase(fixture);
      expect(advisory.preserved[0]?.state).toBe("unproven");
      expect(advisory.verdict).toBe("STALE");
    },
  );

  it("refuses an ambiguous test anchor even alongside a valid indexed test", () => {
    const fixture = proofCase();
    for (const id of ["sym:function:test/x.test.ts:test_danger", "sym:function:test/x.test.ts:suite.test_danger"]) {
      fixture.repositoryFacts.graph.nodes.push({
        id, kind: "test", name: "test_danger", filePath: "test/x.test.ts", evidence: [], tags: [], metadata: {},
      });
    }
    fixture.evidence.repositoryLinks.push({ kind: "symbol", ref: "sym:function:test/x.test.ts:test_danger:7" });
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("unproven");
    expect(r.verdict).toBe("BLOCKED");
    expect(r.stale).toEqual([expect.objectContaining({
      kind: "stale_link", refs: ["proof.p", "sym:function:test/x.test.ts:test_danger:7"],
      message: expect.stringContaining("more than one symbol"),
    })]);
  });
});

describe("underlying coverage and independent adverse gates outrank authored proof", () => {
  const coverageCases = [
    "invariant_touched_without_test", "critical_contract_changed_without_test",
    "contract_changed_without_test", "security_surface_without_verification",
  ].flatMap((rule) => (["warn", "block"] as const).map((severity) => ({ rule, severity })));
  it.each(coverageCases)("keeps $rule at $severity unproven despite valid proof", ({ rule, severity }) => {
    const fixture = proofCase();
    const finding: VerifyReportFinding = { ...WARN_FINDING, rule, severity };
    fixture.underlying = {
      ...warnReport([finding]), verdict: severity === "block" ? "BLOCK" : "WARN",
      summary: { blockCount: severity === "block" ? 1 : 0, warnCount: severity === "warn" ? 1 : 0 },
    };
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("unproven");
    expect(r.verdict).toBe("BLOCKED");
    expect(r.findings.find((entry) => entry.kind === "critical_invariant_unproven")?.message).toContain("no covering test");
    fixture.invariant.tags = [];
    const advisory = verifyProofCase(fixture);
    expect(advisory.preserved[0]?.state).toBe("unproven");
    expect(advisory.verdict).toBe(severity === "block" ? "BLOCKED" : "PARTIAL");
  });

  it.each(["analysis_scope_incomplete", "future_analysis_warning", "contradiction_unresolved"])(
    "handles scoped and unscoped %s honestly rather than manufacturing coverage", (rule) => {
      for (const nodeIds of [["sym:function:x.ts:danger:5"], []]) {
        const fixture = proofCase();
        fixture.underlying.findings = [{ ...WARN_FINDING, rule, nodeIds }];
        const withProof = verifyProofCase(fixture);
        expect(withProof.preserved[0]?.state).toBe(rule === "analysis_scope_incomplete" ? "proved" : "unproven");
        expect(withProof.verdict).toBe(rule === "analysis_scope_incomplete" ? "PARTIAL" : "BLOCKED");
        fixture.invariant.relations = [];
        const withoutProof = verifyProofCase(fixture);
        expect(withoutProof.preserved[0]?.state).toBe("unproven");
        expect(withoutProof.verdict).toBe("BLOCKED");
        expect(withoutProof.findings.find((finding) => finding.kind === "critical_invariant_unproven")?.message)
          .not.toContain("no covering test");
      }
    },
  );

  it("does not treat an unrelated scoped advisory as a coverage gap on a genuinely covered invariant", () => {
    const fixture = proofCase();
    fixture.invariant.relations = [];
    fixture.underlying.findings = [{ ...WARN_FINDING, rule: "future_analysis_warning", nodeIds: ["other-symbol"] }];
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("proved");
    expect(r.verdict).toBe("PARTIAL");
  });

  it.each(["contradicted invariant", "underlying BLOCK", "blocking footprint finding", "critical unknown", "superseded decision"])(
    "retains the independent %s gate despite admitted evidence", (gate) => {
      const fixture = proofCase();
      let expectedKind: string;
      if (gate === "contradicted invariant") {
        fixture.invariant.status = "contradicted";
        expectedKind = "invariant_contradicted";
      } else if (gate === "underlying BLOCK") {
        fixture.underlying.verdict = "BLOCK";
        fixture.underlying.findings.push({ ...WARN_FINDING, rule: "index_binding_stale", severity: "block", nodeIds: [] });
        fixture.underlying.summary.blockCount = 1;
        expectedKind = "underlying_block";
      } else if (gate === "blocking footprint finding") {
        fixture.underlying.findings.push({ ...WARN_FINDING, rule: "contradiction_unresolved", severity: "block" });
        fixture.underlying.summary.blockCount = 1;
        expectedKind = "critical_invariant_unproven";
      } else if (gate === "critical unknown") {
        fixture.model.nodes.push({
          ...fixture.invariant, id: "unknown.race", kind: "unknown", relations: [], repositoryLinks: [],
        });
        fixture.contract.openUnknowns = ["unknown.race"];
        expectedKind = "critical_open_unknown";
      } else {
        fixture.model.nodes.push({
          ...fixture.invariant, id: "decision.old", kind: "decision", status: "stale", repositoryLinks: [],
          relations: [{ kind: "justifies", to: "invariant.i" }],
        });
        expectedKind = "superseded_decision";
      }
      const r = verifyProofCase(fixture, { ...POLICY, supersededDecisionSeverity: "block" });
      expect(r.verdict).toBe("BLOCKED");
      expect(r.findings.some((finding) => finding.kind === expectedKind && finding.severity === "block")).toBe(true);
      expect(r.provedEvidence.map((evidence) => evidence.id)).toEqual(["proof.p"]);
      expect(r.preserved[0]?.state).toBe(
        gate === "contradicted invariant" ? "contradicted"
          : gate === "underlying BLOCK" || gate === "blocking footprint finding" ? "unproven" : "proved",
      );
    },
  );
});

describe("removed authored test targets", () => {
  it("does not admit a proof whose only indexed test was deleted or renamed", () => {
    const fixture = proofCase();
    fixture.repositoryFacts.graph.nodes = fixture.repositoryFacts.graph.nodes.filter((node) => node.kind !== "test");
    const r = verifyProofCase(fixture);
    expect(r.preserved[0]?.state).toBe("unproven");
    expect(r.verdict).toBe("BLOCKED");
    expect(r.stale).toEqual([expect.objectContaining({ kind: "stale_link", refs: ["proof.p", "test:test/x.test.ts"] })]);
  });
});
