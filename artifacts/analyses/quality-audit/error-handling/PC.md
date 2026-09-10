# Error handling — PC

## Summary
Reviewed Plane C production source only (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 52 `.ts` files). Catch sites are fail-closed: predicates return `false`, Zod `superRefine` adds issues, hash failures become typed evaluation errors or `INPUT_SCHEMA_INVALID`, and the verifier never turns a malformed capsule into `PASSED` (integrity `INVALID` or null verdicts → `FAILED`; only `ALLOW`+`ALLOW` can pass). `classifyControlFreshnessSeal`, `ControlFreshnessStatusReportSchema`, `ControlQueryEnvelopeV1Schema` (STALE/UNSEALED must `refused`+`INDEX_STALE`), and `reconcileDiff` (`INDEX_STALE` / `CONTROL_INPUTS_UNSEALED`) are consistent. Worst issue: `decideAltitudeAuthority` and `isStale` can still grant a walk or autonomous write when seals/verdict say STALE or UNSEALED, if the caller omits a seal or lies about `canRunHighRiskControl`. No spawn in this partition.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ERR-PC-01 | P1 | packages/control-engine/src/altitude-authority.ts:28 | Autonomous write is gated on caller `canRunHighRiskControl`, not on `verdict`. `AltitudeAuthorityReportV1Schema` repeats that boolean conjunction and never requires STALE/UNSEALED ⇒ `canRunHighRiskControl === false`. A report `{ verdict: "STALE", canRunHighRiskControl: true, allowsAutonomousWrite: true }` at L0/L1 is schema-valid, contradicting the comment that stale/unsealed withdraws autonomy at every altitude. Production `controlStatus()` is consistent; the engine API is not. | `const trustedInputs = input.freshness.canRunHighRiskControl;` | Derive trust from `verdict === "FRESH" \|\| verdict === "DIRTY_KNOWN"` (same rule as `ControlFreshnessStatusReportSchema:167`). Reject STALE/UNSEALED + `canRunHighRiskControl: true` in `AltitudeAuthorityReportV1Schema`. | 92 |
| ERR-PC-02 | P1 | packages/control-engine/src/traversal.ts:542 | `isStale` is true only when both seals are present and differ. `lift`/`lower` default `bounds = {}`, so omitted seals (UNSEALED) are treated as not stale and the walk proceeds. `refinementCoverage` requires both hashes in the type but still uses this predicate, so equal dummy seals also walk. Envelope schema (`refinement-schemas.ts:496`) already demands `refused`+`INDEX_STALE` for STALE/UNSEALED. | `return bounds.sourceSeal !== undefined && bounds.indexSeal !== undefined && bounds.sourceSeal !== bounds.indexSeal;` | Missing either seal → `refused` / `INDEX_STALE`. Mismatch → same. Do not default seals to absent. | 90 |
| ERR-PC-03 | P2 | packages/control-engine/src/traversal.ts:125 | `impact` and `explainWhy` take `TraversalBounds` (including `sourceSeal`/`indexSeal`) but never call `isStale`. Mismatched or omitted seals still return a full walk / explanation. Envelope wrapping in app-services is the published gate; the engine primitive does not fail closed. | `export function impact(graph, sourceIds, bounds: TraversalBounds = {})` | Call the same seal gate as `lift`/`lower`, or drop unused seal fields from these signatures so callers cannot think a check ran. | 85 |
| ERR-PC-04 | P3 | packages/control-engine/src/task-envelope.ts:473 | Five catch-rethrow sites drop `cause`. `TaskEnvelopeCompilationError` and `ChangeAuthorizationEvaluationError` only `super(message)`. `parseGraph` copies `error.message` into a new `INPUT_SCHEMA_INVALID`; four policy hash `catch {` blocks throw `CLAIM_INVALID` / `ASSERTION_INVALID` / `EVIDENCE_BUNDLE_INVALID` with no original. Fail-closed, but JCS/hash root cause is gone. | `throw new TaskEnvelopeCompilationError("INPUT_SCHEMA_INVALID", \`invalid coordinate graph: ${error instanceof Error ? error.message : "unknown error"}\`,);` | Accept `ErrorOptions` (`{ cause }`) on both error classes; pass `cause: error` from every catch-rethrow (`change-authorization-policy.ts:393,549,577,649`). | 88 |

## Metrics
- Files read: 52 scanned (all Plane C `src/**/*.ts`; tests/`dist` skipped); 22 inspected
- Findings: 4 (0 P0 / 2 P1 / 1 P2 / 1 P3)
- Catch sites: 16 (0 empty/`catch {}`; 12 bare `catch {` with no binding; 4 `catch (error)`)
- Catch → dummy success (`true` / `ALLOW` / `PASSED` / `FRESH`): 0
- Catch → fail-closed (`false`, Zod `addIssue`, typed throw, `INPUT_SCHEMA_INVALID`, verifier `fail`): 16
- Fail-open STALE/UNSEALED sites: 2 confirmed (ERR-PC-01, ERR-PC-02) + 1 missing gate (ERR-PC-03)
- Missing-`cause` rethrows: 5
- Spawn / swallowed spawn failures (`Bun.spawn` / `child_process`): 0
- Errors turned into PASS: 0 (`verify.ts:56` malformed capsule → `CAPSULE_SCHEMA_INVALID`; `precedence.ts:56` integrity `INVALID` → `FAILED`; `PASSED` only when both verdicts are `ALLOW`)
- Healthy fail-closed (not filed): `freshness.ts:49,62,73` UNSEALED/STALE classification; `schemas.ts:168` high-risk only FRESH/DIRTY_KNOWN; `refinement-schemas.ts:496` envelope STALE/UNSEALED must refuse; `reconcile-diff.ts:486-487` INDEX_STALE + CONTROL_INPUTS_UNSEALED; `task-envelope.ts:311` stale authored links throw; `policy.ts:127` `Date.parse` NaN → not fresh → DENY; `authorizeStep` invalid input → DENY (`policy.ts:45`)

## Recommendations
1. Make `canRunHighRiskControl` a function of `verdict` in `decideAltitudeAuthority` and `AltitudeAuthorityReportV1Schema`. Do not trust a caller boolean that can disagree with STALE/UNSEALED.
2. Treat missing traversal seals as UNSEALED: refuse with `INDEX_STALE`. Keep mismatch as STALE. Apply the same rule in `refinementCoverage`.
3. Either run that seal gate in `impact`/`explainWhy` or stop accepting seal fields there.
4. Thread `{ cause }` through Plane C error classes so JCS/hash failures remain diagnosable without weakening fail-closed codes.
5. Do not relax verifier precedence or capsule `safeParse` → `PASSED`. Shadow `blockingEnabled: false` is an enforcement-mode choice, not an error-handling hole.
