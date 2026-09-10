# Code smells — PA

## Summary
Inspected Plane A source only (`ts-analyzer`, `python-analyzer/src`, `plane-a-internal`, `workspace-analyzer-internal`, `cocoindex-adapter`), skipping tests and excluded trees. 24 files / 5708 loc; six files exceed 400 loc and eleven functions exceed 80. Small units (`cocoindex-adapter`, `plane-a-internal` policy/sidecar/canonical, ts-analyzer docs/frontmatter/migrations) are fine. Worst issue: `workspace-analyzer-internal/src/index.ts` is a 991-line god file whose async and sync IO paths are near-verbatim clones (production uses only the sync twin).

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SMELL-PA-01 | P2 | packages/workspace-analyzer-internal/src/index.ts:99 | God file (991 loc) owns walk, manifest parse, glob, projection, and four async/sync twins. `analyzeWorkspace` is unused in product (`app-services` calls `analyzeWorkspaceSync` only); `inspectRepository` (85) and `inspectRepositorySync` (85) are line-for-line copies. `projectWorkspaceCandidates` is 162 loc of identity/parent/cycle logic in the same file. A symlink or nested-git edit that lands in one twin can miss the other. | `export function analyzeWorkspaceSync(input: AnalyzeWorkspaceInput): WorkspaceProjection {` | Inject an fs port (or `node:fs/promises` vs sync wrappers) so inspect/analyze is one function; split projection (`projectWorkspaceCandidates`) and TOML/JSON parse into their own modules. Drop or re-export async as a thin wrapper. | 95 |
| SMELL-PA-02 | P2 | packages/ts-analyzer/src/ts-symbols.ts:180 | God file (828 loc) mixes program extraction, worker pool, partition preflight, and worker DTO validation. `extractTypeScript` is 140 loc with a nested `visit` of 87 loc that records functions, classes, interfaces, types, enums, methods, namespaces, const-arrow functions, imports, and calls. Parallelism (`extractTypeScriptParallel`, `preflightParallelSafety`, `isExtractionWorkerResponse`) cannot be read without the visitor. | `export function extractTypeScript(rootAbsPaths: string[], repoRoot: string): TsExtraction {` | Keep `extractTypeScript` + `visit`/`recordSymbol` in one extract module; move worker factory, merge, and DTO guards to `index-worker.ts` (already the worker entry). | 95 |
| SMELL-PA-03 | P2 | packages/ts-analyzer/src/analyze.ts:117 | `analyze.ts` is 627 loc. `assembleRepository` (170) builds modules, grouped symbols, imports, calls, test coverage, docs, migrations, and marker divergence. `buildTypeScriptSidecar` (161) then re-reads disk and groups facts by language. Two independent pipelines in one file; sidecar construction is not extraction. | `export function assembleRepository(` | Split sidecar (`buildTypeScriptSidecar`) and marker application (`applyCodeMarkers`) out of `assembleRepository`; leave the function as graph wiring over `groupSymbols` + extraction. | 95 |
| SMELL-PA-04 | P2 | packages/plane-a-internal/src/evaluation.ts:367 | `evaluatePlaneA` is 187 loc of sequential ADR-0010 gates. `capabilityReasons` (150) is ~15 near-identical `addMismatch` rows (profile↔batch, then requirement↔profile). Adding a capability coordinate requires two edits or a gate silently skips. File is 581 loc. | `addMismatch(reasons, "CAPABILITY_MISSING", "language", profile.scope.language, batch.scope.language);` | Drive mismatches from a table of `{ code, coordinate, expected, actual }`; keep `evaluatePlaneA` as early-return gate orchestration only. | 92 |
| SMELL-PA-05 | P2 | packages/python-analyzer/src/index.ts:250 | Single 528 loc extractor: Lezer walk, `#` marker scan, import grammar, call limitations. `recordImport` is 84 loc; `extractOne` is 80. Same shape as `ts-symbols`+`markers` but not split, so import vs marker vs walk cannot change independently. | `function recordImport(` | Split `parseMarkers` / `recordImport` / `extractOne` into sibling files matching ts-analyzer (`markers.ts`, extract, index barrel). Leave tag grammar sharing to the architecture finding; this is file-shape only. | 90 |
| SMELL-PA-06 | P3 | packages/ts-analyzer/src/analyze.ts:489 | `applyCodeMarkers` copies the same `builder.node({ id, kind, name, evidence, tags: ["from-code"], statement })` + `builder.edge(...)` block for capability / invariant / contract / risk. A new statement-bearing tag, or a tags/`from-code` change, must be repeated four times (boundedContext is the only structural variant). | `builder.edge("implements_capability", symbolNodeId, id, ev);` | Table `{ tag, idOf, kind, edgeKind }` for statement-bearing markers; keep `tag` and `boundedContext` as the two special cases. | 90 |
| SMELL-PA-07 | P3 | packages/ts-analyzer/src/markers.ts:148 | Dead public exports. `summarizeMarkerCoverage` / `MarkerCoverage` have zero callers (including tests). `stripJsDoc` is only used by `parseMarkers`; `asStringArray` only by `docs.ts`. Both are re-exported from `ts-analyzer/src/index.ts` with no external importer. | `export function summarizeMarkerCoverage(` | Delete `summarizeMarkerCoverage` + `MarkerCoverage`, or stop exporting until a coverage surface exists. Unexport `stripJsDoc` and `asStringArray` from the package barrel. | 95 |

## Metrics
- Files read: 24 partition source files (10 ts-analyzer + 1 python-analyzer + 7 plane-a-internal + 1 workspace-analyzer-internal + 5 cocoindex-adapter)
- Findings: 7 (0 P0 / 0 P1 / 5 P2 / 2 P3)
- Files >400 loc: 6
  - 991 `packages/workspace-analyzer-internal/src/index.ts`
  - 828 `packages/ts-analyzer/src/ts-symbols.ts`
  - 627 `packages/ts-analyzer/src/analyze.ts`
  - 581 `packages/plane-a-internal/src/evaluation.ts`
  - 528 `packages/python-analyzer/src/index.ts`
  - 453 `packages/plane-a-internal/src/assembler.ts` (no finding: `DeterministicGraphAssembler` methods stay ≤50 loc)
- Functions >80 loc: 11
  - 187 `evaluatePlaneA` evaluation.ts:367
  - 170 `assembleRepository` analyze.ts:117
  - 162 `projectWorkspaceCandidates` workspace-analyzer-internal/src/index.ts:242
  - 161 `buildTypeScriptSidecar` analyze.ts:314
  - 150 `capabilityReasons` evaluation.ts:185
  - 140 `extractTypeScript` ts-symbols.ts:180
  - 99 `discoverRepository` discovery.ts:247
  - 87 nested `visit` ts-symbols.ts:227
  - 85 `inspectRepository` workspace-analyzer-internal/src/index.ts:405
  - 85 `inspectRepositorySync` workspace-analyzer-internal/src/index.ts:491
  - 84 `recordImport` python-analyzer/src/index.ts:250
- At-threshold (80, not counted): `extractTypeScriptParallel` ts-symbols.ts:326, `extractOne` python-analyzer/src/index.ts:425
- Healthy (largest file ≤124 loc): `cocoindex-adapter` (5 files)
- Dead exports confirmed: `summarizeMarkerCoverage`, `MarkerCoverage`; barrel-only `stripJsDoc`, `asStringArray`
- Not re-filed (architecture owns): marker regex TS↔Python (`ARCH-PA-02`), nested-git skip discovery↔workspace (`ARCH-PA-04`)

## Recommendations
1. Split `workspace-analyzer-internal` along IO vs pure projection and collapse the async/sync clones first — that is the largest drift surface, and product already has a single caller (`analyzeWorkspaceSync`).
2. Split `ts-symbols.ts` (extract vs workers) and `analyze.ts` (assemble vs sidecar) before either grows another language path.
3. Table-drive `capabilityReasons` and `applyCodeMarkers`; both are copy-paste that will miss a tag or capability coordinate.
4. Delete or unexport `summarizeMarkerCoverage` / `stripJsDoc` / `asStringArray` so the ts-analyzer barrel matches what App actually imports.
5. Leave `plane-a-internal` assembler (453) and `cocoindex-adapter` alone until the god files above move; assembler methods are already bounded.
