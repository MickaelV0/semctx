# ADR 0009 — The semantic layer is a separate plane from the repository graph

- Status: accepted
- Date: 2026-07-05
- Related: ADR 0001 (local-first SQLite), ADR 0005 (retriever rejected), ADR 0008 (versioned output)

## Context

`semctx verify diff` computes, deterministically, *"given this change, what did it put at risk, and
is it proven?"* over a graph **derived** from source. Agents transforming a system need a second,
longer-lived thing the derived graph cannot hold: the **authored** intent, business invariants,
decisions, assumptions, evidence and unknowns that must survive across many edits and across context
compactions — and the explicit links between that authored truth and the code.

The temptation is to fold this into the existing graph (add "goal" and "decision" node kinds and
let the analyzer infer them). ADR 0005 is the standing warning against that: the moment `semctx`
*infers* what matters from names/structure it loses to a content retriever and stops being honest.

## Decision

Introduce a **Semantic Layer** as a strictly separate plane, and keep the boundary sharp.

1. **Two planes, never conflated.**
   - **Plane A — repository facts** (derived): symbols, imports, calls, contracts, invariants,
     tests, markers, claims, `verify diff` results. Owned by the analyzer; a fact.
   - **Plane B — authored semantic truth** (declared): goals, invariants, decisions, assumptions,
     unknowns, change contracts, evidence. Owned by a human/agent; an intention.
   - A fact and an intention never share a type without explicit `provenance` (`author` / `agent` /
     `derived`). The only coupling from B to A is an explicit `RepositoryLink`.

2. **The DSL is canonical; Unicode is a view.** The `.sem` source is a line/indentation, ASCII
   format with a deterministic formatter and file/line/column diagnostics. The glyphs
   (`◇ □ ⊳ Δ ⊢ ? ⊥ ≈ →`) are a *rendering* only: an ASCII projection is always available and no glyph
   is ever required to parse, compile or query. This avoids a glyph cult and a determinism hazard
   (no ambiguous quoting, no generated parser, no YAML).

3. **Semctx Semantic does not do content retrieval.** The semantic slice seeds **only** from
   explicit scopes (a change id, a repository symbol/claim ref) and expands along authored
   relations under a node cap. It never ranks files for a natural-language task — that is grep /
   BM25 / embeddings / CocoIndex / a human (ADR 0005 stands). The layer *consumes* a selection; it
   does not pretend to *produce* one.

4. **Git is the source of truth; SQLite is a local index.** Authored declarations live in
   Git-versioned `.semctx/semantic/**.sem` — they diff, review and merge like code. The SQLite
   store remains a regenerable Plane-A cache (ADR 0001); the Semantic Layer persists nothing
   authoritative there in v1. Working scratch (`.semctx/working/**`) is local and git-ignored.

5. **Proof, assumption and unknown stay distinct — always.** `SemanticStatus` keeps `declared`
   (unverified), `assumed`, `tested`/`statically_verified`/`runtime_verified` (proven),
   `contradicted` and `stale` separate. The composed `change verify` verdict is **never more
   optimistic than the data**: it never turns PARTIAL into VERIFIED on its own. Because `semctx` is
   static, obtaining a proof is the agent's dynamic step (run the test, then record the evidence
   status) — the layer only tracks what has been declared/obtained, and shows the rest as unknown.

## Consequences

- The product story stays honest: `verify diff` is the impact analyzer; the semantic layer is a
  memory of authored intent; neither claims to *find* relevant code.
- `change verify` **composes** `verify diff` (via the shared `computeVerifyReport` /
  `buildVerifyReport`), it does not bypass or re-implement it. A more optimistic verdict is
  structurally impossible.
- A new `ChangeVerifyReport` is versioned (`schemaVersion 1`) like the `VerifyReport` (ADR 0008), so
  external consumers depend on the version, not internal types.
- The additive `semantic` config block is optional; pre-semantic configs keep validating. The Zod
  schema is extended so a `semantic` block is no longer silently stripped.
- Cost of the boundary: authored truth must be **written and maintained** by humans/agents; the tool
  will not invent it. That is the point — the alternative (inference) is what ADR 0005 rejected.

## Fork-local clarification: explicit test proof under incomplete analysis

- Status: accepted by the fork operator on 2026-10-09, by selecting
  **Accepter la clarification**.
- Baseline: upstream v0.4.2 / `745bac2`. This acceptance governs the fork only,
  **not upstream**; it records a decision, not observed implementation evidence.

Incomplete analysis is not evidence that tests are absent. Determine whether a
preserved invariant is touched from the actual changed-symbol/finding footprint,
using the shared typed repository-link resolver. Collect only resolved graph-node
targets, retain incoming `constrained_by` expansion, and deduplicate/sort them.
File links expand into indexed IDs; stripped paths and authored claims/evidence
are not graph footprints. Unresolved links remain stale, never guessed.

For a touched invariant affected by incomplete analysis, preservation may be
`proved` through authored evidence if and only if:

1. The invariant has an outgoing `proved_by` relation to that evidence.
2. The selected contract requires that evidence, and its semantic kind is `evidence`.
3. Its status is in the existing `PROVEN_STATUSES`: `tested`, `statically_verified`
   or `runtime_verified`.
4. Every repository link on both invariant and evidence resolves, and at least one
   evidence target is an actual indexed node of kind `test`. One good link does
   not excuse a stale/ambiguous link. Source paths, misleading names and non-test
   graph targets alone are insufficient.
5. No underlying BLOCK, contradictory invariant, blocking footprint finding,
   genuine missing-coverage finding or adverse/unknown WARN overrides this route.
   Scoped adverse/unknown WARN vetoes proof on its node footprint; unscoped
   adverse/unknown WARN vetoes proof for touched invariants.

Relevance comes from the authored relation, not an invented Python coverage edge.
Semctx tracks an obtained authored status; it does not attest execution, assertion
quality or additional freshness.

### Honesty, compatibility and delivery

- Classify findings by their actual `rule`. Missing coverage is exactly
  `invariant_touched_without_test`, `critical_contract_changed_without_test`,
  `contract_changed_without_test` or `security_surface_without_verification`.
  These keep touched preservation unproven, including advisory findings and
  otherwise valid authored proof. Critical unproven invariants still block.
- `analysis_scope_incomplete` is different. Scoped findings apply through their
  node footprint; unscoped incompleteness conservatively applies to touched
  invariants. Without admissible proof, report insufficient proof under incomplete
  analysis, not absent tests. Unknown WARN rules neither assert missing coverage
  nor authorize proof. Contradictions and other adverse findings retain their
  actual reasons.
- Embed the underlying report unchanged. WARN still floors the aggregate at
  PARTIAL; BLOCK, stale/source-binding refusal, contradictions, open unknowns,
  required evidence and superseded-decision policy remain independent. Keep
  `BLOCKED > STALE > PARTIAL > VERIFIED`. Untouched invariants remain untouched;
  genuinely covered PASS behavior remains. Python negative incompleteness and
  `negativeEvidenceEligible: false` remain; no fabricated `tested_by`/`covers`.
- This is a GOVERNED clarification under the public-contract contributor guide.
  Schema version 1 retains existing fields, enums and meanings: proved preservation
  is not aggregate completeness. Corrected outcomes/reasons can change, but no
  authored-data migration or historical-report rewrite is authorized. Any later
  incompatible meaning change requires ADR 0008 versioning/migration treatment.
- Pure policy remains in semantic-engine with the existing resolver/status/rule
  vocabulary. App-services owns coordination; CLI/MCP share its result. Verify
  does not mutate lifecycle. Close still refuses PARTIAL/BLOCKED/STALE; only fresh
  VERIFIED derives `verified`. Existing exit and `--fail-on partial` behavior stays.
- Before delivery, prove the positive route and all rejection boundaries, file
  footprint expansion, untouched meaning, current-source refusal and CLI/MCP
  verify/close parity. Regenerate canonical plugin outputs with exactly Bun 1.4.0
  and prove generated-artifact/Claude Code/Codex parity and exact-SHA CI. Never
  hand-edit generated bundles or installed caches. These are obligations, not
  claimed test/build/publication results. Reverting the correction requires
  regeneration, not rewriting authored data.
