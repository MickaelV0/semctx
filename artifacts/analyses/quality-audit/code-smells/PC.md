# Code smells — PC

## Summary
Inspected Plane C production source only (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 52 `.ts` files, 16040 loc). Tests, `dist`, and excluded trees skipped. Small units (`canonical.ts` 21, `hashing.ts` 187, verifier `canonical.ts` 22) are fine; the partition is a contract-heavy Zod + hash kernel, not an executor. Health is uneven: fourteen files exceed 400 loc, eleven functions exceed 80. Worst issue is four incompatible domain-hash encodings for the same “NUL domain + canonical JSON” idea (`{domain,value}` wrap, UTF-8 string concat, binary concat, RFC 8785 JCS), so a copied helper mints a different digest. Path-normalizer split and fingerprint domain-separator gaps are owned by security, not re-filed.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SMELL-PC-01 | P2 | packages/control-model/src/task-envelope-schemas.ts:1100 | God file (1846 loc). Envelope, change-set, planning bundle, observation, evidence, architecture-delta, and reconcile-diff Zod live together. `ReconciliationAnalysisV1Schema.superRefine` is 237 lines of hash/scope/round-trip checks; `ReconcileDiffReportV1Schema.superRefine` is 131. Helpers `requireCanonicalStrings` / `requireCanonicalReasons` at the bottom are copy-paste targets for sibling schema files. | `export const ReconciliationAnalysisV1Schema = z.object(ReconciliationAnalysisV1Shape).strict()` | Split by contract (envelope, change-set, observation, reconcile-diff). One shared `zod-canonical.ts` for sorted-unique refinements. Keep each `superRefine` under ~80 lines by extracting `validateRealizedReport` / `validateDeclaredScopeBindings` (already local). | 95 |
| SMELL-PC-02 | P2 | packages/control-engine/src/change-authorization-policy.ts:263 | God function + file. `evaluateChangeAuthorizationV1` is 449 lines of sequential `safeParse` / JCS-safe / duplicate-id / hash-seal loops for providers, claims, rules, assertions, and bundles, then `deriveChangeAuthorizationDecisionV1`. File is 954 loc; `evaluateRule` is 83. Replay/monotonicity sit in the same module. | `export function evaluateChangeAuthorizationV1(` | Parse-and-seal each entity in its own function (`sealClaims`, `sealAssertions`, `sealBundles`). Keep `evaluateChangeAuthorizationV1` as orchestration + `derive*` + `evaluateRule`. Move replay/monotonicity to a sibling file. | 95 |
| SMELL-PC-03 | P2 | packages/control-engine/src/reconcile-diff.ts:60 | God file (955 loc). `reconcileDiff` is 263 lines of refusal/evidence/round-trip/target assembly; `evaluateEvidence` (~122, object return type) and `validateInputs` (96) are inlined beside hunk matching, rename detection, and advisory consolidation. | `export function reconcileDiff(input: ReconcileDiffInputV1): ReconcileDiffReportV1 {` | Split `validateInputs`, `evaluateEvidence`, `evaluateRoundTrips`, `evaluateTarget`, `buildReport`. Leave `reconcileDiff` as a fail-closed pipeline over those results. | 95 |
| SMELL-PC-04 | P2 | packages/control-model/src/task-envelope-canonical.ts:392 | Four domain-hash encodings. Envelope uses `sha256HashCanonicalJson({ domain, value })`. Handoff concatenates `DOMAIN + serializeControlReport` as UTF-8 (`control-handoff.ts:686`). Lifecycle and freshness binary-concat domain bytes with JSON (`agent-lifecycle.ts:530`, `hashing.ts:150`). Change-authorization uses RFC 8785 JCS string concat (`change-authorization-canonical.ts:55`) — that split is documented in ADR 0016; the three `serializeControlReport` variants are not. Copying the wrong template silently changes every sealed hash. | `return sha256HashCanonicalJson({ domain, value });` | One `domainHashUtf8(domain, value)` (and, if needed, one binary-framed variant) in `hashing.ts`. Call it from envelope, handoff, lifecycle, freshness. Keep JCS as the sole exception, behind `changeAuthorizationDomainHashV1`. | 90 |
| SMELL-PC-05 | P2 | packages/control-engine/src/architecture.ts:170 | Local `canonical` / `stableJson` clones `canonicalize` / `serializeControlReport` (`control-model/src/canonical.ts:2`). Fingerprint then hashes with raw `createHash` instead of `sha256HashCanonicalJson`. Security already owns the missing domain separator and `sha256:` prefix; this finding is the duplicated canonicalizer. | `function stableJson(value: unknown): string { return JSON.stringify(canonical(value)); }` | Import `serializeControlReport` (already on the reconciliation barrel). Delete `canonical` / `stableJson`. | 92 |
| SMELL-PC-06 | P2 | packages/control-model/src/task-envelope-schemas.ts:1745 | Zod canonical-order helpers copied three times (`requireCanonicalStrings` also at `change-authorization-schemas.ts:697` and `control-handoff.ts:696`). Same for `concatBytes` (`hashing.ts:179` ≡ `agent-lifecycle.ts:678`), `sortedUnique` (8 copies; `legacy-planning.ts:45` reimplements `compareCodeUnits` inline), and `digestId` (`task-envelope.ts:533` ≡ `refinement-planner.ts:527`). | `function requireCanonicalStrings(` | One `requireCanonicalStrings` / `requireCanonicalByKey` in control-model. Export `concatBytes` from `hashing.ts` (unexport from lifecycle). One `sortedUnique` next to `compareCodeUnits`. | 90 |
| SMELL-PC-07 | P2 | packages/control-engine/src/reconciliation-validation.ts:76 | Hand-rolled graph/hunk parser (349 loc of `requireRecord` / `requireExactKeys` / `requireSortedUnique`) duplicates `CoordinateGraphReportV2Schema` and observed-hunk Zod in control-model. `parseCoordinateGraphV2` is 66 lines; `parseObservedDiffHunk` re-checks identity vs `createObservedDiffHunkV1`. Drift on a new V2 field is a silent accept or a throw only on one path. | `export function parseCoordinateGraphV2(value: unknown): CoordinateGraphReportV2 {` | Parse with the existing Zod contracts; keep this module as thin `safeParse` wrappers plus `parseSha256Hash`. Delete `isObservedDiffHunk` / `parseRefinementRelationV1` if unused. | 85 |
| SMELL-PC-08 | P2 | packages/control-model/src/control-handoff.ts:348 | God file (772 loc) mixes types, reason codes, classification, Zod, and domain hashes. `ControlHandoffCapsuleV2Schema.superRefine` is 128 lines; `ControlHandoffRecordV2Schema.superRefine` is 138. Same shape as change-authorization (`change-authorization-schemas.ts` 753 loc; capsule `superRefine` 291 lines at :338) but those types already live in a `*-types.ts` / `*-canonical.ts` / `*-schemas.ts` split. | `export const ControlHandoffCapsuleV2Schema = z.object(CapsuleShape)` | Match the change-authorization layout: types, canonical hashes, schemas. Reuse SMELL-PC-06 helpers for the two `superRefine` bodies. | 90 |
| SMELL-PC-09 | P3 | packages/control-model/src/canonical.ts:6 | Dead / over-exported runtime symbols. `canonicalizeControlValue` and `canonicalizeChangeAuthorizationValueV1` have zero callers (barrel `export *` only). `isObservedDiffHunk` and `parseRefinementRelationV1` are exported from `reconciliation-validation.ts` and unused even inside control-engine (not on the package barrel). `RECONCILE_STATUS_PRECEDENCE` is exported and never read. | `export function canonicalizeControlValue(value: unknown): unknown {` | Unexport or delete the five. Do not treat unused Zod *Schema aliases as dead — they are the public contract surface. | 88 |

## Metrics
- Files read: 52 partition `src/` inventoried by loc; ~28 inspected (hash/canonical modules, god files, verifier derive/verify, barrels)
- Findings: 9 (0 P0 / 0 P1 / 8 P2 / 1 P3)
- Files >400 loc: 14
  - 1846 `packages/control-model/src/task-envelope-schemas.ts`
  - 955 `packages/control-engine/src/reconcile-diff.ts`
  - 954 `packages/control-engine/src/change-authorization-policy.ts`
  - 772 `packages/control-model/src/control-handoff.ts`
  - 753 `packages/control-model/src/change-authorization-schemas.ts`
  - 698 `packages/control-model/src/schemas.ts` (legacy public-report Zod catalog; no separate finding)
  - 686 `packages/control-model/src/agent-lifecycle.ts` (policy + schemas + eval; hash clone filed under SMELL-PC-04/06)
  - 638 `packages/control-engine/src/traversal.ts`
  - 589 `packages/control-model/src/refinement-schemas.ts` (schema catalog)
  - 585 `packages/control-model/src/types.ts` (type catalog)
  - 576 `packages/control-engine/src/observation-analysis.ts`
  - 547 `packages/control-engine/src/task-envelope.ts`
  - 540 `packages/control-engine/src/refinement-planner.ts`
  - 506 `packages/control-model/src/task-envelope-types.ts` (type catalog)
- Functions >80 loc: 11
  - 449 `evaluateChangeAuthorizationV1` change-authorization-policy.ts:263
  - 263 `reconcileDiff` reconcile-diff.ts:60
  - 192 `traverseToLevel` traversal.ts:286
  - 155 `buildObservationAnalysis` observation-analysis.ts:109
  - 151 `buildCoordinateGraph` coordinates.ts:49
  - 109 `bindExplicitAnchors` task-envelope.ts:197
  - 100 `compileSemanticChangeSet` refinement-planner.ts:177
  - 97 `evaluatePolicyRule` change-authorization-verifier/src/derive.ts:136
  - 96 `validateInputs` reconcile-diff.ts:398
  - 90 `verifyChangeAuthorizationCapsuleV1` verify.ts:47
  - 83 `evaluateRule` change-authorization-policy.ts:849
- Large `superRefine` (not counted as named functions): capsule 291 (`change-authorization-schemas.ts:338`), reconciliation analysis 237 (`task-envelope-schemas.ts:1100`), handoff record 138 (`control-handoff.ts:482`), reconcile report 131 (`task-envelope-schemas.ts:1402`), handoff capsule 128 (`control-handoff.ts:348`)
- Partition loc: control-model 9438; control-engine 5527; change-authorization-verifier 1075; total 16040
- Dead exports confirmed: `canonicalizeControlValue`, `canonicalizeChangeAuthorizationValueV1`, `isObservedDiffHunk`, `parseRefinementRelationV1`, `RECONCILE_STATUS_PRECEDENCE`
- Not re-filed (security owns): L0 vs envelope path normalizers (`SEC-PC-01`); `fingerprintCoordinateGraph` raw hex / missing domain (`SEC-PC-05`)
- Not re-filed (intentional dual impl): verifier `evaluatePolicyRule` ≅ engine `evaluateRule` (`derive.ts:4` refuses to import `control-engine`; frozen-vector tests are the lockstep)

## Recommendations
1. Land SMELL-PC-04 first: one `serializeControlReport` domain-hash helper. Envelope / handoff / lifecycle / freshness must not mint different digests for the same payload shape. Leave JCS as the documented change-authorization exception.
2. Split `task-envelope-schemas.ts` and `evaluateChangeAuthorizationV1` / `reconcileDiff` along existing function seams before adding another contract version.
3. Hoist `requireCanonicalStrings` / `concatBytes` / `sortedUnique`; point `architecture.ts` at `serializeControlReport`.
4. Replace `parseCoordinateGraphV2` with `CoordinateGraphReportV2Schema.parse`; unexport the five dead symbols.
5. Split `control-handoff.ts` the way change-authorization already is (types / canonical / schemas). Do not import `control-engine` from the verifier to DRY `evaluateRule`.
