# Type safety — PA

## Summary
Scanned Plane A source only (`ts-analyzer`, `python-analyzer/src`, `plane-a-internal`, `workspace-analyzer-internal`, `cocoindex-adapter`), skipping tests and excluded trees. 24 files. Health is good on the headline metrics: zero `any` / `as any` / `as unknown as`, zero `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`. Worker DTOs and `package.json` parse use `unknown` plus field guards. Worst issue: `CocoIndexCandidateProvider.parse` does unvalidated `JSON.parse` then an unsafe `{ results }` cast, so JSON `null` throws instead of degrading to zero candidates.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| TYPE-PA-01 | P1 | packages/cocoindex-adapter/src/cocoindex-provider.ts:67 | Unvalidated `JSON.parse` then `raw as { results?: unknown[] }` with no null/object guard. The `try` only wraps parse; JSON `null`/`true`/`0` take the object branch and `null.results` throws, contradicting the class’s degrade-to-empty contract. `parseLines` (line 79) is safer because it feeds `toCandidate`. | `: Array.isArray((raw as { results?: unknown[] }).results)` | After parse, require `raw !== null && typeof raw === "object"` (or a Zod schema); reuse `toCandidate` only. Never property-access the parse result until then. | 92 |
| TYPE-PA-02 | P2 | packages/ts-analyzer/src/markers.ts:34 | `normalizeTag` returns `lower as MarkerTag`. The regex is the only runtime constraint; the function accepts any `string`. Sibling: `packages/python-analyzer/src/index.ts:207` (`lower as PythonMarkerTag`). Regex ↔ union drift silently invents tags. | `return lower as MarkerTag;` | Lookup in `satisfies Record<MarkerTag, true>` / a `Set` of the six tags; return `undefined` or skip the match when unknown. Share the table with Python. | 85 |
| TYPE-PA-03 | P2 | packages/ts-analyzer/src/analyze.ts:541 | `applyCodeMarkers` is a six-arm `if`/`else if` on `MarkerTag` with no `else` / `never`. A seventh tag compiles and is dropped. Related: `NODE_ID_PREFIX` is `Partial<Record<MarkerTag, string>>` (`markers.ts:168`); unknown statement-bearing tags skip divergence degradation (`prefix === undefined continue`). | `} else if (marker.tag === "boundedContext") {` | `switch (marker.tag)` with `const _exhaustive: never = marker.tag`. Make `NODE_ID_PREFIX` a full `Record` (or `Omit<MarkerTag, "tag" \| "boundedContext">`) so a new statement-bearing tag fails the typecheck. | 88 |
| TYPE-PA-04 | P2 | packages/plane-a-internal/src/evaluation.ts:475 | `currentFreshness` (`FRESH` \| `DIRTY_KNOWN` \| `UNSEALED` \| `STALE`) and `bindingAttestation` (`absent` \| `valid` \| `invalid`, line 464) are handled by open `if`/`else if`. Unlisted members (today `FRESH`/`DIRTY_KNOWN`/`valid`) fall through as pass; a new union member would too, with no `never` error. | `} else if (input.currentFreshness === "STALE") {` | `switch` + `never` on both unions. Keep today’s pass cases as explicit arms. | 80 |
| TYPE-PA-05 | P2 | packages/ts-analyzer/src/ts-symbols.ts:445 | Parallel preflight reads a non-public `parseDiagnostics` field via intersection cast, defaulting to `[]` when absent. If the compiler stops populating that field, parse-error files look safe and enter the worker partition. | `const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];` | Use `program.getSyntacticDiagnostics(sf)` (public). Treat a missing API as `safe: false`, not empty. | 86 |
| TYPE-PA-06 | P3 | packages/plane-a-internal/src/evaluation.ts:27 | `terminalReason` is `Partial<Record<AnalysisOutcome, PlaneAReasonCode>>` and omits `not_applicable` / `analyzed`. A new outcome other than `analyzed` compiles and becomes `TypeError` at line 411. Fail-closed at runtime, not at compile time. | `const terminalReason: Partial<Record<AnalysisOutcome, PlaneAReasonCode>> = {` | `satisfies Record<Exclude<AnalysisOutcome, "analyzed">, PlaneAReasonCode>`. | 90 |

## Metrics
- Files read: 24 partition source files (10 ts-analyzer + 1 python-analyzer + 7 plane-a-internal + 1 workspace-analyzer-internal + 5 cocoindex-adapter)
- Findings: 6 (0 P0 / 1 P1 / 4 P2 / 1 P3)
- `any` / `as any` / `as unknown as`: 0 in src (test-only `as unknown as Worker` in `ts-analyzer/test/parallel-extraction.test.ts`, out of scope)
- `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`: 0
- `JSON.parse` sites: 3
  - unvalidated: 2 (`cocoindex-provider.ts:61`, `:79`)
  - guarded without Zod: 1 (`workspace-analyzer-internal/src/index.ts:622` `as unknown` + `isRecord` + string-array `workspaces`)
- Non-null `!`: 27 (14 ts-analyzer, 5 plane-a-internal, 8 workspace-analyzer-internal). All sit behind a length/`while`/filter; none filed.
- `switch`: 0 (all unions are `if`/`else if`)
- Zod in this partition: 0 (config Zod lives in `core`, Plane B)
- Narrowing casts after `typeof`/`isRecord` (not filed): `as Record<string, unknown>` in worker guards, `canonical.ts:19`, `toCandidate`; redundant `as string` in `docs.ts:30-34`

## Recommendations
1. Fix `CocoIndexCandidateProvider.parse` first: null/object guard (or Zod) before `.results`, so malformed `ccc` stdout cannot throw.
2. Replace `as MarkerTag` / `as PythonMarkerTag` with one shared tag table; drive `applyCodeMarkers` and `NODE_ID_PREFIX` from the same table with `never`.
3. Exhaust `bindingAttestation` and `currentFreshness` in `evaluatePlaneA`; make `terminalReason` a complete `Record` minus `analyzed`.
4. Drop the `parseDiagnostics` intersection; use `getSyntacticDiagnostics`.
5. Leave the 27 locally-proven `!` and the `package.json` manual parse alone until `noUncheckedIndexedAccess` is on — then the bangs become the compiler’s job.
