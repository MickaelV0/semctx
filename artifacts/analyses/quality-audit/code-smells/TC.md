# Code smells — TC

## Summary
Inspected Plane C tests only (`packages/control-model/test`, `packages/control-engine/test`, `packages/change-authorization-verifier/test`; 28 `.ts` files, 11846 loc, ~335 cases). `dist`, `node_modules`, and product `src` skipped. Small files (`policy.test.ts` 79, `link-resolution-contract.test.ts` 49, `frozen-vector.test.ts` 34, `timestamp-contract.test.ts` 43) and the verifier’s extracted `fixtures.ts` are fine. Zero `beforeEach`/`beforeAll`. No individual test reaches 500 loc. Health is uneven: eleven files exceed 400 loc, four helpers exceed 80, seven tests exceed 80. Worst issue is a sealed envelope → change-set → bundle → capsuleV2 fixture stack copied almost byte-for-byte across three packages (plus a fourth near-clone in handoff), so a schema field change has to be restated in every preamble.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SMELL-TC-01 | P2 | packages/change-authorization-verifier/test/fixtures.ts:172 | Copy-paste sealed-planning fixtures. `capsuleV2` is 61 loc and byte-identical (after id-prefix rename) in three packages: this file, `control-engine/test/change-authorization-policy.test.ts:175`, `control-model/test/change-authorization-contract.test.ts:174`. Same for `progress` / `provider` / `taskFrame` / `trustPolicyDescriptor`. `envelope` is identical between engine and verifier (40 loc); `changeSet` Jaccard 0.95. Engine policy preamble is 353 loc vs verifier `fixtures.ts` 351 loc — the engine file never imported the extracted module. | `function capsuleV2(bundleValue: PlanningBundleV1, terminalStatus: "REALIZED" \| "VIOLATED" \| "UNPROVEN" = "REALIZED") {` | Parameterize id prefix + hashes in `packages/control-model/test/fixtures/sealed-planning.ts`. Import from model, engine, and verifier tests. Keep `baseInput` / `testsPassRule` in one authorization fixture. Does not import `control-engine` from verifier `src`. | 98 |
| SMELL-TC-02 | P2 | packages/control-model/test/task-envelope-contract.test.ts:486 | God test files. Five files ≥900 loc. This one is 1558 loc with a 485-line factory preamble (`reconciliationAnalysis` 156 loc at :320, `report` 68, `envelope` 56) before the first `describe`. Sisters: `reconcile-diff.test.ts` 1480, `control-handoff-v2.test.ts` 1099 (319-line preamble), `change-authorization-contract.test.ts` 995 (496-line preamble / 20 helpers), `change-authorization-policy.test.ts` 901. | `describe("issue #27 public exports and authority boundary", () => {` | Split along existing `describe` seams (paths, hashes, change-set, reconciliation). Move factories to `test/fixtures/`. Do not keep a 1500-line file as a “contract catalog”. | 95 |
| SMELL-TC-03 | P2 | packages/control-engine/test/reconcile-diff.test.ts:861 | God factory. `makeInput` is 247 loc of envelope + change-set + observation + hunk-binding + evidence + architecture-delta + sealed analysis + capture. Callers then mutate nested fields (`input.planningBundle.taskEnvelope.envelopeHash`). Sibling helpers: `sealEnvelope` 80 loc at :1109, `sealChangeSet` 39, `certifiedRoundTrip` 56, `makeCandidateGraph` 45. File is 16 helpers after a single 800-line `describe`. | `function makeInput(options: FactoryOptions = {}): ReconcileDiffInputV1 {` | Split `sealPlanningBundle` / `sealObservation` / `sealAnalysis` / `makeCapture`. Keep `makeInput` as composition. Table-drive the refusal-order tests instead of repeating nested spreads. | 95 |
| SMELL-TC-04 | P2 | packages/change-authorization-verifier/test/architecture.test.ts:147 | Product-shaped compiler in the test tree. `findRestrictedRuntimeReferences` is 169 loc of TypeScript lexical-scope walking (function/block/loop/catch/class). `inspectRuntimeSourceTree` + `findArchitectureViolations` sit in the same 338-line preamble. The mutation-witness `it` at :355 is 199 loc of `writeFileSync` mutants — longest test in the partition (no test is 500+). File 554 loc for four cases. | `function findRestrictedRuntimeReferences(runtimeContent: string, sourcePath: string): readonly string[] {` | Move the oracle to `test/architecture-oracle.ts`. Table-drive mutants (`[file, source, kind, detail]`). Keep the four `it` bodies under ~30 lines. | 92 |
| SMELL-TC-05 | P2 | packages/control-model/test/control-handoff-v2.test.ts:811 | Helper inlined N times. `requiredFunction("computeControlHandoffCapsuleV2Hash")` is restated ~20 times; progress-hash the same way ~8 times. The descriptive-step `it` is 155 loc of strip-hash / rehash / `safeParse` copy-paste. `task-envelope-contract.test.ts` already extracted `rehashEnvelope` / `rehashChangeSet` / `rehashBundle` / `rehashReport`; this file did not. Fourth near-clone of `envelope`/`changeSet`/`progress`/`capsule` lives at :30–:300 (Jaccard 0.89 vs the authorization `envelope`). | `it("rejects descriptive steps as completed progress and requires explicit completion evidence", () => {` | Add `rehashCapsule` / `rehashProgress` (or import SMELL-TC-01 factories). Collapse skip/completion cases to `test.each`. Delete the local envelope stack once sealed-planning fixtures exist. | 92 |
| SMELL-TC-06 | P3 | packages/control-model/test/change-authorization-contract.test.ts:25 | Dummy digest constants copied six times (`hashA`/`hashB`/`hashC` here, contract-v2, handoff, task-envelope-contract, engine policy, verifier fixtures) plus `HASH_A`..`D` in `task-envelope.test.ts:18` and a one-line `hash(character)` in both `reconcile-diff.test.ts:1431` and `refinement-planner.test.ts:686`. | `const hashA = \`sha256:${"a".repeat(64)}\` as const;` | One `sha256Repeat(ch)` next to SMELL-TC-01 fixtures. Delete the six copies. | 90 |

## Metrics
- Files read: 28 partition `test/` inventoried by loc; ~18 inspected (fixture preambles, god files, architecture oracle, engine factories)
- Findings: 6 (0 P0 / 0 P1 / 5 P2 / 1 P3)
- Files >400 loc: 11
  - 1558 `packages/control-model/test/task-envelope-contract.test.ts`
  - 1480 `packages/control-engine/test/reconcile-diff.test.ts`
  - 1099 `packages/control-model/test/control-handoff-v2.test.ts`
  - 995 `packages/control-model/test/change-authorization-contract.test.ts`
  - 901 `packages/control-engine/test/change-authorization-policy.test.ts`
  - 688 `packages/control-engine/test/refinement-planner.test.ts`
  - 554 `packages/change-authorization-verifier/test/architecture.test.ts`
  - 488 `packages/control-engine/test/task-envelope.test.ts`
  - 464 `packages/control-model/test/contract-v2.test.ts`
  - 450 `packages/control-engine/test/observation-analysis.test.ts`
  - 411 `packages/control-engine/test/coordinates.test.ts`
- Functions >80 loc: 4
  - 247 `makeInput` reconcile-diff.test.ts:861
  - 169 `findRestrictedRuntimeReferences` architecture.test.ts:147
  - 156 `reconciliationAnalysis` task-envelope-contract.test.ts:320
  - 80 `sealEnvelope` reconcile-diff.test.ts:1109
- Tests >80 loc: 7 (none ≥500)
  - 199 architecture.test.ts:355 mutation witness
  - 155 control-handoff-v2.test.ts:811 descriptive-step completion
  - 114 agent-workflow.test.ts:35 workflow dump
  - 113 control-handoff-v2.test.ts:986 request/result matrix
  - 91 control-handoff-v2.test.ts:547 record binding
  - 89 refinement-planner.test.ts:370 five-template compile
  - 82 architecture-migration.test.ts:55 v2 snapshot relations
- `beforeEach` / `beforeAll`: 0
- Copy-paste fixture stacks: 3 exact `capsuleV2` clones + 1 handoff near-clone; 6 `hashA` copies
- Partition loc: control-model 5185; control-engine 5192; change-authorization-verifier 1469; total 11846
- Cases (approx): 335
- Healthy (no finding): `observation-analysis.test.ts` (`test.each` + small `change`/`hunk`/`node` helpers); verifier `verify.test.ts` imports `./fixtures`; tiny contracts (`link-resolution`, `reconciliation-migration`, `frozen-vector`, `timestamp-contract`, `policy.test.ts`)
- Not re-filed (test-quality wave owns): tautology / mock-echo / missing fail-closed cases
- Not re-filed (type-safety owns): `requiredFunction(...): any` in control-handoff-v2.test.ts:314
- Not re-filed (architecture owns): verifier `src` isolation from `control-engine` — test fixture sharing does not cross that boundary

## Recommendations
1. Land SMELL-TC-01 first: one sealed-planning fixture module. Engine policy tests should import it the way `verify.test.ts` already imports `./fixtures`. That removes ~700 duplicated loc before any file split.
2. Split `task-envelope-contract.test.ts` and `reconcile-diff.test.ts` along existing `describe` / factory seams. `makeInput` becomes composition of four sealers.
3. Hoist `rehashCapsule` / `rehashProgress` (SMELL-TC-05) to match the `rehash*` helpers already in the envelope contract tests.
4. Move the architecture AST oracle out of the test file; table-drive the mutation witness.
5. Do not add `beforeEach` to “fix” preamble size — factories with overrides are the existing (good) pattern. Do not import `control-engine` from verifier `src` to DRY tests.
