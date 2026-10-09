# Change contracts & composed verification

A **change contract** is a proof-carrying declaration opened before or during a modification. It
answers: *what goal does this change serve, which invariants must it preserve, which symbols/files/
claims does it touch, which proofs are required, which unknowns stay open, and what is its status?*

## Lifecycle

```
draft → active → verified
                → partial
                → blocked
                → stale
                → superseded
```

`change open` creates it (default `active`; `--draft` to stage). `change verify` computes a composite
verdict without mutating the contract. `change close` derives `verified` only after running a fresh
composed verification that returns `VERIFIED` (or records `--superseded` without making a proof
claim). Generic `change update --status` cannot assert `verified`.

## Composed verification

`change verify` **composes** `verify diff` — it never bypasses it. It reuses the exact same
`computeVerifyReport` / `buildVerifyReport` pipeline (ADR 0008) as the underlying Plane-A report,
then folds in the contract:

1. **Underlying impact** — the `VerifyReport` (impacted symbols/contracts/invariants, recommended
   tests, PASS/WARN/BLOCK), embedded verbatim under `underlying`. An underlying **BLOCK** contributes
   a `block` finding; an underlying **WARN** contributes a `warn` finding — so the composite can
   never be more optimistic than the impact analysis it composes (a WARN floors it at PARTIAL).
2. **Preserved invariants** — resolve each invariant's typed repository links with the shared
   resolver. Only actual graph-node targets form its Plane-A **footprint**, including indexed nodes
   expanded from file links and incoming `constrained_by` symbols, deduplicated and sorted.
   Unresolved links stay stale; claims and evidence records do not invent graph footprints.
   A declared contradiction → `contradicted`; an absent declaration → `missing`; an invariant
   outside the changed-symbol/finding footprint → `untouched`, even if it has authored proof.
   For a touched invariant, genuine missing coverage → `unproven`, including advisory findings.
   Missing coverage means exactly `invariant_touched_without_test`,
   `critical_contract_changed_without_test`, `contract_changed_without_test` or
   `security_surface_without_verification`, classified by rule, not severity or wording.
   Blocking findings and other adverse/unknown WARN findings also prevent automatic proof, without
   falsely claiming that tests are absent. Otherwise a covered touch → `proved`.
   Under `analysis_scope_incomplete`, use the bounded authored-test admission below instead.
   A critical-tagged `unproven` invariant still blocks even if the repository rule is advisory.
3. **Required evidence** — each `requires_evidence` id must have a *proven* status
   (`tested`/`statically_verified`/`runtime_verified`); otherwise it is a pending proof obligation.
4. **Open unknowns** — listed; non-critical contribute PARTIAL, critical (tagged) escalate. An
   unknown can be resolved only after its authored node has a `proved_by` relation to evidence in a
   proven status.
5. **Stale / dangling** — a repository link on the change or a referenced node that no longer
   resolves, or a `preserves`/`requires` id that is not declared.
6. **Superseded decisions** — a decision that `justifies` a preserved invariant and is superseded or
   contradicted.

Each contribution is a typed `SemanticFinding` with severity `block | warn | stale`. The verdict is
derived from the findings with fixed precedence, and is **never more optimistic than the data**:

```
verdict = BLOCKED  if any block finding      (underlying BLOCK, critical unproven invariant,
                                              contradicted invariant, critical open unknown,
                                              or a superseded decision when policy = block)
        | STALE    else if any stale finding  (a link no longer resolves; a ref is not declared)
        | PARTIAL  else if any warn finding    (underlying WARN, pending evidence, open non-critical
                                              unknown, non-critical unproven invariant)
        | VERIFIED otherwise
```

### Authored test proof under incomplete analysis

A scoped `analysis_scope_incomplete` finding applies through its indexed node footprint; an
unscoped one conservatively applies to every touched invariant. It does not assert missing tests
and does not authorize the covered-touch shortcut. Preservation is `proved` only if the invariant
has an outgoing `proved_by` to evidence required by the selected contract, that node has kind
`evidence` and a `PROVEN_STATUSES` status, every repository link on both nodes resolves, and at
least one evidence target is an actual indexed graph node of kind `test`.

A resolved test-file link can qualify; a source path, test-like name, non-test target or one good
link alongside a stale/ambiguous link cannot. Missing/reversed relevance, unrequired evidence or
an unproven status cannot qualify either. Without admissible proof, report insufficient proof
under incomplete analysis, not absent tests. Unknown WARN rules do not authorize proof.
Underlying BLOCK, blocking footprint findings, genuine missing coverage, contradicted invariants
and adverse/unknown WARN override admission. Scoped adverse/unknown WARN vetoes proof on its node
footprint; unscoped adverse/unknown WARN vetoes proof for touched invariants. Other independent
gates remain authoritative.

This proves authored preservation only: the underlying report stays verbatim and WARN still
floors the aggregate at PARTIAL. Python negative incompleteness remains; no `tested_by`/`covers`
edge, test runner, execution attestation or additional freshness mechanism is invented. Close
still refuses PARTIAL/BLOCKED/STALE. See the fork-local accepted clarification in
[ADR 0009](../adr/0009-semantic-layer-is-separate-from-the-repository-graph.md).

Crucially, `change verify` **never turns PARTIAL into VERIFIED on its own**. `semctx` is static; a
required proof becomes obtained only when you run the test and record the evidence node's status as
`tested`/`runtime_verified`. To resolve an unknown, its node must also declare `proved_by` to that
proven evidence. The tool tracks declared/obtained state — it does not run your tests for you.

This remains a cooperative trust boundary: versioned `.semctx/semantic/*.sem` files can be edited
directly. CLI and MCP mutations enforce the proof gates, but semctx does not provide cryptographic
attestation or prevent a repository author from forging authored state.

## Example verdict (text)

```
Δ change.stripe-webhook-retry  [active]
  underlying verify diff: PASS

preserved
  □ invariant.payment.idempotent [untouched]

proved
  (none)

partial
  ? unknown.cancellation-race

verdict: PARTIAL
WARN unproven / open: unknown.cancellation-race
```

After running the webhook test, marking `proof.test.webhook-duplicate-event` `tested`, and resolving
`unknown.cancellation-race`, the same command returns `VERIFIED`.

## Policy (`.semctx/config.json` → `semantic`)

```jsonc
"semantic": {
  "enabled": true,
  "criticalInvariantTags": ["critical", "security"],  // unproven → BLOCKED, not PARTIAL
  "openUnknownSeverity": "warn",                       // warn → PARTIAL; block → BLOCKED
  "supersededDecisionSeverity": "warn",
  "requireProofForActiveChange": true                  // active change preserving an invariant owes proof
}
```

Absent block → defaults above. The composed report (`ChangeVerifyReport`) is versioned
(`schemaVersion 1`).

## CLI & MCP

```
semctx change open   change.<slug> --preserves <inv-ids> --requires <ev-ids> --unknown <unk-ids>
semctx change update change.<slug> --resolve-unknown <unk-ids> --status <non-verified-lifecycle>
semctx change verify change.<slug> --base origin/main [--format json] [--fail-on block|partial|none]
semctx change close  change.<slug> [--superseded]
```

MCP: `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_change_close`,
`semctx_semantic_inspect` (changes authored via MCP carry `provenance: agent`). Exit codes:
BLOCKED/STALE → 3; PARTIAL/VERIFIED → 0 (unless `--fail-on partial`).
