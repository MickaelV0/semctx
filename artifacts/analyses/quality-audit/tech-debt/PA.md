# Tech Debt — PA

## Summary
Reviewed Plane A source only (`packages/ts-analyzer/src`, `packages/python-analyzer/src`, `packages/plane-a-internal/src`, `packages/workspace-analyzer-internal/src`, `packages/cocoindex-adapter/src`), skipping tests and excluded trees. 24 source files plus 5 package manifests. Zero `TODO`/`FIXME`/`HACK`/`XXX` and no commented-out statements. Health is good on markers; debt is dual live APIs and unnamed constants, not abandoned comments. Worst issue: v1 discovery (`discoverFiles` / `isExcludedLegacy`) is still the analyze entry path beside v2 `discoverRepository`, while `cocoindex-adapter` still ships ADR 0004 `search()` without `attestedSearch` (the content-front-end ADR 0005 left behind `context prepare`). Plugin/cli/mcp pins are `workspace:*` and not owned here.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| DEBT-PA-01 | P2 | packages/ts-analyzer/src/analyze.ts:89 | Deprecated dual discovery: `analyzeRepository` / `analyzeRepositoryAsync` still call `discoverFiles`. v1 uses `isExcludedLegacy` (substring after stripping `*`) and reason `LEGACY_UNSUPPORTED_EXTENSION`; v2 is the ledger with include/exclude globs. `discoverFiles` forwards v2, then `discoverRepository(v1)` calls `discoverFiles` again — two public shapes kept for fingerprint stability. | `const files = discoveredFiles === undefined ? discoverFiles(config) : [...discoveredFiles];` | Make v2 `discoverRepository` the only producer; delete `isExcludedLegacy` / v1 walk once default config is v2. Stop exporting `discoverFiles`. | 92 |
| DEBT-PA-02 | P2 | packages/cocoindex-adapter/src/provider.ts:51 | Experimental retriever leftover (ADR 0004 + 0005): `attestedSearch?` is the only seal-eligible surface; neither `CocoIndexCandidateProvider` nor `NullSemanticCandidateProvider` implements it (`"attestedSearch" in provider` is false by design). Live path is unattested `search()`. Parse accepts array / `{ results }` / NDJSON and field aliases “across `ccc` versions”; missing score becomes `0.5`. No `ContextPack` / `prepare_task` in this partition. | `attestedSearch?(input: SemanticSearchInput): Promise<AttestedSemanticSearchResult>;` | Implement `attestedSearch` or drop the optional hole. Pin one `ccc` JSON shape; omit score instead of inventing `0.5`. Keep `search` only if callers stay diagnostic-only. | 90 |
| DEBT-PA-03 | P2 | packages/ts-analyzer/src/ts-symbols.ts:417 | Unnamed worker policy: auto stays 1 below 1000 files, darwin always 1 “until … evidence”, auto cap 2, explicit max 8, job timeout 300_000 ms. Same file also probes `semctx-index-worker.js` then `index-worker.ts`. | `if (fileCount < 1_000) return 1;` | Named constants (`AUTO_WORKER_FILE_THRESHOLD`, `INDEX_WORKER_TIMEOUT_MS`, …) with the benchmark cited once. Revisit the darwin gate or delete it. One worker entry. | 88 |
| DEBT-PA-04 | P3 | packages/plane-a-internal/package.json:3 | Version drift inside Plane A: `plane-a-internal` is `0.0.0-provisional` (index.ts: “Provisional … seam”); `ts-analyzer`, `python-analyzer`, `workspace-analyzer-internal`, `cocoindex-adapter` are `0.1.0`. Producer identity is a string literal, not the package version. Plugin/cli/mcp consume `workspace:*` — no extra pin drift in this glob. | `"version": "0.0.0-provisional"` / `version: "0.1.0"` at analyze.ts:75 | Ship one workspace version. Derive `TYPESCRIPT_PRODUCER.version` from package metadata. | 85 |
| DEBT-PA-05 | P3 | packages/ts-analyzer/src/ts-symbols.ts:445 | Non-public TypeScript compiler field `SourceFile.parseDiagnostics` reached via intersection cast. Pinned `typescript` 5.9.3 today; the field is not a supported API and can vanish on a compiler bump (`TYPESCRIPT_DIALECT_VERSION = ts.version`). | `(sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics` | Use `ts.getPreEmitDiagnostics(program, sf)` (or equivalent public parse diagnostics). | 80 |

## Metrics
- Files read: 24 partition source files + 5 package.json (grep all; detailed reads: discovery, analyze, ts-symbols, index-worker, markers, migrations, docs, frontmatter, symbol-grouping, python `index.ts`, plane-a `index.ts`/`sidecar.ts`, workspace `index.ts`, all five cocoindex modules)
- Findings: 5 (0 P0 / 0 P1 / 3 P2 / 2 P3)
- TODO/FIXME count: **0** (also 0 `HACK`/`XXX` in this glob)
- Deprecated / dual symbols: `discoverFiles`, `isExcludedLegacy`, `LEGACY_UNSUPPORTED_EXTENSION`, optional `attestedSearch?` with no impl, internal `parseDiagnostics`
- Commented-out code: none (`// const|let|function|return|import|export|if (` — 0 hits)
- Experimental retriever leftovers (ADR 0005): no `ContextPack` / `prepare_task` / `retriever` strings in Plane A source; leftover is cocoindex `search()` + unimplemented `attestedSearch` (ADR 0004 optional provider still in the PA glob)
- Magic numbers: `1_000`, `8`, `2`, `300_000`, score `?? 0.5`; schemaVersion `1` treated as schema, not debt
- Version drift plugin/cli/mcp: not in partition; CLI/MCP depend on Plane A via `workspace:*`. Intra-A: `0.0.0-provisional` vs `0.1.0` + hardcoded producer `0.1.0`

## Recommendations
1. Collapse discovery to v2 only: `analyzeRepository*` → `discoverRepository`; delete v1 `isExcludedLegacy` / substring excludes once config default is v2.
2. Finish or remove cocoindex attestation: either `attestedSearch` with a pinned `ccc` contract, or delete the optional method and the invented `0.5` score so diagnostic-only stays honest (ADR 0004/0005).
3. Name the index-worker thresholds and timeout; drop or re-benchmark the darwin auto=1 gate.
4. Align `plane-a-internal` with `0.1.0` (or document provisional forever) and stop hand-writing producer versions.
5. Replace `parseDiagnostics` with a public TS diagnostic API before the next `typescript` bump.
