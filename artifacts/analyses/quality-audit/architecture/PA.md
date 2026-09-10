# Architecture — PA

## Summary
Inspected Plane A source only (`ts-analyzer`, `python-analyzer/src`, `plane-a-internal`, `workspace-analyzer-internal`, `cocoindex-adapter`), skipping tests and excluded trees. Parsers do not persist (no SQLite/`writeFile`; sidecar is an in-memory `WeakMap`) and do not import Plane B/C, `repository-store`, `context-engine`, or `app-services`. Load-bearing ADR 0010 gates live once in `plane-a-internal`; `python-analyzer` does **not** copy them. Worst issues: `cocoindex-adapter` implements retrieval scoring inside the Plane A inventory, and the Python vertical forks the TS marker grammar while remaining extract-only (graph/sidecar composition is outside this partition).

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ARCH-PA-01 | P2 | packages/cocoindex-adapter/src/provider.ts:25 | Plane A package ranks: `SemanticCandidate` carries a relevance `score` and `CocoIndexCandidateProvider.search` runs retrieval (`ccc search`), not parse. Hard boundary puts ranking in `context-engine`; this adapter is inventoried as Plane A and never touches AST. | `score: pickNumber(obj, ["score", "similarity", "relevance"]) ?? 0.5,` at cocoindex-provider.ts:95 | Keep the provider next to ranking (context-engine / retrieval adapter), or drop scores from the Plane A inventory so A stays parse/assemble-only. | 90 |
| ARCH-PA-02 | P2 | packages/python-analyzer/src/index.ts:86 | python-analyzer copies the ts-analyzer marker contract (same tag union + nearly the same `@capability|…` regex), not the gates. `evaluatePlaneA` / `admissibleFor` stay in plane-a-internal only. Coupling: two language extractors own the same grammar; a tag change can drift. | `const MARKER_RE = /@(capability|invariant|contract|risk|boundedcontext|tag)[ \t]+…` vs ts-analyzer/src/markers.ts:28 | Share tag union + regex in `plane-a-internal` (or core); leave only comment-shape scanners (JSDoc vs `#`) in each extractor. | 95 |
| ARCH-PA-03 | P2 | packages/python-analyzer/package.json:17 | Uneven producer seam: ts-analyzer parses **and** assembles (`assembleRepository` + sidecar). python-analyzer depends only on `@lezer/python` and exports `extractPython` — no `plane-a-internal`, no `FactBatchV1`. Gates were not copied (good); Python graph assembly therefore cannot live in this partition. | `"@lezer/python": "1.1.19"` (sole dependency); extractPython at python-analyzer/src/index.ts:506 | Emit Plane A facts/batches from a Python assembler that uses `plane-a-internal`, matching the TS sidecar path, so App is not the second-language graph producer. | 90 |
| ARCH-PA-04 | P3 | packages/ts-analyzer/src/discovery.ts:136 | Intra-plane FS containment is duplicated: discovery and workspace-analyzer each implement `isNestedGitWorktree` (file-or-symlink `.git` skip) plus their own walks. Not a cross-plane leak; two Plane A walkers can diverge on nested worktrees. | `function isNestedGitWorktree(directory: string, root: string): boolean {` vs workspace-analyzer-internal/src/index.ts:969 | One private Plane A helper for nested-git / symlink skip; both walkers call it. | 85 |

## Metrics
- Files read: 24 partition source files (10 ts-analyzer + 1 python-analyzer + 7 plane-a-internal + 1 workspace-analyzer-internal + 5 cocoindex-adapter) plus 5 package manifests
- Findings: 4 (0 P0 / 0 P1 / 3 P2 / 1 P3)
- Persist in analyzers: none (assembler is in-memory `Map`s at plane-a-internal/src/assembler.ts:128; sidecar `WeakMap` at sidecar.ts:4)
- python-analyzer copies ts-analyzer **gates**: no (`evaluatePlaneA` at plane-a-internal/src/evaluation.ts:367; `admissibleFor` at policy.ts:20; zero call sites in python-analyzer)
- Coupling notes:
  - Marker grammar forked TS ↔ Python (ARCH-PA-02)
  - Python extractor isolated from `plane-a-internal` (ARCH-PA-03)
  - Nested-git skip forked discovery ↔ workspace-analyzer (ARCH-PA-04)
  - `cocoindex-adapter` is a retrieval plugin sitting in the Plane A glob (ARCH-PA-01)
- Cross-layer imports (workspace packages only; `file:line`):

  Allowed (`@semantic-context/core` — shared kernel, not B/C):
  - packages/ts-analyzer/src/analyze.ts:18
  - packages/ts-analyzer/src/discovery.ts:3
  - packages/ts-analyzer/src/docs.ts:1
  - packages/ts-analyzer/src/markers.ts:15
  - packages/ts-analyzer/src/migrations.ts:1
  - packages/ts-analyzer/src/symbol-grouping.ts:10
  - packages/ts-analyzer/src/ts-symbols.ts:4
  - packages/plane-a-internal/src/assembler.ts:12
  - packages/plane-a-internal/src/model.ts:6
  - packages/cocoindex-adapter/src/cocoindex-provider.ts:1

  Intra-A:
  - packages/ts-analyzer/src/analyze.ts:40 → `@semantic-context/plane-a-internal`
  - packages/ts-analyzer/src/markers.ts:17 → `@semantic-context/plane-a-internal`

  Upward / other planes (`repository-store`, `context-engine`, `semantic-model`, `semantic-engine`, `semantic-dsl`, `control-model`, `control-engine`, `app-services`, `mcp-server`): **none**.
  - python-analyzer: no `@semantic-context/*` imports
  - workspace-analyzer-internal: no `@semantic-context/*` imports

## Recommendations
1. Treat `cocoindex-adapter` as ranking/retrieval, not Plane A parse: move the package (or at least `score` + `search`) next to `context-engine`, or stop listing it as an analyzer.
2. Deduplicate the marker tag union and regex in `plane-a-internal`; do not let a third language copy `MARKER_RE` again.
3. Give python-analyzer a Plane A assembler path (`FactBatchV1` / sidecar via `plane-a-internal`) so language N×M stays extractor-local and gates remain singular.
4. Keep ts-analyzer / plane-a-internal as they are on persist and rank: graph-in-memory, gates in one package, no store/engine imports.
