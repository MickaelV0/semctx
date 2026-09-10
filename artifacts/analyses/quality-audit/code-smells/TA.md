# Code smells — TA

## Summary
Inspected Plane A tests only (`ts-analyzer/test`, `python-analyzer/test` excluding corpus, `plane-a-internal/test`, `workspace-analyzer-internal/test`, `cocoindex-adapter/test`): 13 files / 3227 loc, 106 cases. No `beforeEach` at all; `afterEach` temp-dir cleanup stays 2–4 lines. Small units (`cocoindex-adapter` 58, `symbol-grouping` 65 with a `symbol()` helper, `python-extractor` with `extract()`) are fine and already table-drive where it matters. Worst issue: three files exceed 500 loc (`evaluation.test.ts` 665, `workspace-analyzer.test.ts` 525, `assembler.test.ts` 507) because fixtures and worker/fact builders are inlined N times instead of `it.each` / a local factory — the same files already prove they know the table-driven shape.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SMELL-TA-01 | P2 | packages/plane-a-internal/test/evaluation.test.ts:20 | God test file (665 loc). `analyzedInput` is a 69-line fixture blob; two ADR-C17 composition tests (79 + 64 loc) each build 3–5 `evaluatePlaneA` calls and lock the aggregate report. The file already table-drives gate-1 and single-gate failures (`it.each` at 220 and 366); the composition tests did not follow. A new reason code or candidate identity requires editing the helper plus both snapshot tests. | `function analyzedInput() {` | Keep `analyzedInput` / `validAnalyzedInput` / `withCandidate`; drive the two ADR-C17 tests from a table of `{ candidate, mutate, primaryReason, decisionKind }` and assert `aggregatePlaneAEvaluations` once. Split the file if it still exceeds ~400 loc after. | 95 |
| SMELL-TA-02 | P2 | packages/plane-a-internal/test/assembler.test.ts:208 | 507 loc. Document node + `contradicts` edge copied four times (208, 252, 286, 318) with only `from`/`to`/`provenance`/`metadata` changing. Rejections above that are already `it.each` (`RejectionCase` at 111); authored-edge cases were left as four near-verbatim `it`s. Later tests invent local factories (`invariant()` at 484) that the authored-edge block does not use. | `const evidence = [{ filePath: "src/a.ts", startLine: 1, sourceKind: "document" as const }];` | `node()` / `edge()` helpers (or one `it.each` over `{ from, to, provenance, metadata, expectThrow }`). Leave the existing rejection table as-is. | 95 |
| SMELL-TA-03 | P2 | packages/ts-analyzer/test/parallel-extraction.test.ts:181 | Fake `Worker` with `onmessage` getter/setter + `try { await extractTypeScriptParallel } catch { thrown }` cloned four times (181, 210, 299, 351); a fifth try/catch at 248. The file already table-drives malformed-symbol DTOs (`test.each` at 342) and preflight fallbacks (151). A DTO-contract or factory-API change must be repeated in every clone. File is 397 loc, just under 400. | `let onmessage: ((event: { data: unknown }) => void) | null = null;` | One `fakeWorker(onPostMessage)` plus `expectMalformedDto(factory)` (or fold 176/205/294 into the existing `test.each`). Keep the second-worker-unavailable case (248) separate — it is not a DTO clone. | 95 |
| SMELL-TA-04 | P2 | packages/workspace-analyzer-internal/test/workspace-analyzer.test.ts:214 | God test file (525 loc, one describe). POSIX vs Windows symlink triplets (214–246 vs 264–296) are line-for-line copies (`dir` vs `junction`). Nested-git skip tests (391 and 406) repeat the same three expects. `expectRejectedProjectionParity` (480) already extracts async/sync JSON equality for *rejections*, but the same `JSON.stringify(synchronous) === JSON.stringify(asynchronous)` is still inlined at 256, 388, 400, 416. | `await expectRejectedProjectionParity(linkedRepository, ".");` | Table `{ platform, linkType, setup }` for the six symlink/junction cases; one `expectProjectionParity(input)` used by nested-git and the Windows alternate-spelling test. Split layout-projection vs IO/symlink describes. | 92 |
| SMELL-TA-05 | P3 | packages/plane-a-internal/test/assembler.test.ts:6 | Identical `scope` object (six fields) copied into `evaluation.test.ts:9`. `if (api === null) throw new Error("internal Plane A API is unavailable")` is inlined 21 times (10 assembler + 11 evaluation). `plane-a-sidecar.test.ts` inlines `expect(internal).not.toBeNull(); if (internal === null) return;` three times (16, 28, 62). A missing-API policy change is three files. | `repositoryIdentity: "repo:fixture",` | Shared `requireInternal()` at the top of each file (throw once). Optionally one test-local `scope` module for the two plane-a-internal files — do not invent a package. | 90 |
| SMELL-TA-06 | P3 | packages/ts-analyzer/test/ambiguous-call-no-edge.test.ts:47 | Same `fixture(SOURCE)` + `analyzeRepository(createDefaultConfig(root))` + bare id `sym:function:src/collision.ts:collisionHost.twin` re-run in all three tests (47, 58, 72). `marker-divergence.test.ts:29–62` copies the two-declaration `{ tag, slug, statement, relPath, startLine }` template four times for punctuation/case/accents/truncation; sibling files already use `it.each`. | `const root = fixture(SOURCE);` | One `beforeAll`/module-level analysis for the collision graph; `it.each` over `{ rawA, rawB }` for canonical-slug divergence. | 88 |

## Metrics
- Files read: 13 (7 ts-analyzer + 2 python-analyzer + 2 plane-a-internal + 1 workspace-analyzer-internal + 1 cocoindex-adapter)
- Findings: 6 (0 P0 / 0 P1 / 4 P2 / 2 P3)
- Files >400 loc: 3
  - 665 `packages/plane-a-internal/test/evaluation.test.ts`
  - 525 `packages/workspace-analyzer-internal/test/workspace-analyzer.test.ts`
  - 507 `packages/plane-a-internal/test/assembler.test.ts`
- At-threshold (not counted): 397 `packages/ts-analyzer/test/parallel-extraction.test.ts`
- Functions / `it` bodies >80 loc: 0
  - At-threshold: 79 `locks the ADR-C17 pre-subject…` evaluation.test.ts:521
  - Largest helper: 69 `analyzedInput` evaluation.test.ts:20
- Copy-paste clusters: fake Worker ×4; authored document+edge ×4; POSIX/Windows symlink ×3 pairs; `scope` ×2 files; `api === null` ×21; collision analyze ×3
- Giant `beforeEach`: 0 (none in partition; `afterEach` temp-dir cleanup ≤4 loc)
- Healthy (largest file ≤139 loc, helpers extracted): `cocoindex-adapter/test/adapter.test.ts` (58), `symbol-grouping.test.ts` (65, `symbol()`), `analyzer.test.ts` (139, shared `sampleConfig()`), `python-extractor.test.ts` (`extract()`; goldens not counted as clone)
- Not re-filed (test-quality owns tautology / mock-echo; architecture owns nested-git skip discovery↔workspace)

## Recommendations
1. Collapse the four authored-edge fixtures in `assembler.test.ts` and the four fake-Worker DTO tests in `parallel-extraction.test.ts` first — both files already have `it.each` for a sibling case, so the shape is local.
2. Table-drive the two ADR-C17 composition tests in `evaluation.test.ts`; leave `analyzedInput` but stop duplicating `evaluatePlaneA` + `aggregatePlaneAEvaluations` by hand.
3. Extract `expectProjectionParity` next to the existing `expectRejectedProjectionParity` and table the POSIX/Windows symlink triplets in `workspace-analyzer.test.ts`.
4. Replace the 21 inlined `api === null` guards with one `requireInternal()` per plane-a-internal test file; share `scope` only if a third copy appears.
5. Do not touch `cocoindex-adapter`, `symbol-grouping`, `python-extractor`, or `analyzer.test.ts` for smell — they already extract helpers and stay well under 400 loc.
