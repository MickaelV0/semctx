# Async patterns — PC

## Summary
Reviewed Plane C production source only (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 52 `.ts` files). The partition is graph-in and fully synchronous: no `async`/`await`/`Promise`, no dynamic `import()`, no timers, no `Bun.spawn`, no SQLite, no filesystem, no fetch/workers, and no `Date.now()`. Clocks and Git/index observations are injected as already-captured strings and hashes; engines classify them in memory. Health is strong. The only Node builtin is sync `createHash("sha256")` (CPU, not I/O) in `hashing.ts` and `architecture.ts`.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| _None._ | | | | | | |

## Metrics
- Files read: 52 scanned (all Plane C `src/**/*.ts`; tests/`dist` skipped); 14 inspected
- Findings: 0 (P0/P1/P2/P3)
- Spawn sites (`Bun.spawn` / `child_process` / `node:child_process`): 0
- SQLite write sites: 0
- Missing-await / floating-promise suspects (`async`, `await`, `Promise`, `.then(`, `.catch(`, `void` fire-and-forget, `import()`): 0
- `setTimeout` / `setInterval` / `queueMicrotask` / `setImmediate`: 0
- `node:fs` / `Bun.file` / `fetch` / `Worker` / index-worker: 0
- `Date.now()` / `performance.now()` / `Math.random` / `crypto.subtle`: 0
- Unclosed DB/file handles: N/A (no handles opened)
- Sync SHA-256 (`createHash`): 2 files — `packages/control-model/src/hashing.ts:19`, `packages/control-engine/src/architecture.ts:42` (in-memory digest; not I/O)
- Injected-timestamp `Date.parse` (caller ISO, not wall clock): `change-authorization-schemas.ts:105,168`, `refinement-schemas.ts:368`, `schemas.ts:406,651`, `change-authorization-policy.ts:911,918`, `observation-analysis.ts:117`, `policy.ts:127`, `derive.ts:200,216`, `schemas.ts:106,195` (verifier)
- Public APIs: `export function` returning values; `verifyChangeAuthorizationCapsuleV1` (`verify.ts:47`) and `buildObservationAnalysis` (`observation-analysis.ts:109`) are sync by contract
- Cross-package IO at the C→B read adapter: `semantic-model/src/reconciliation-read.ts` and `repository-links.ts` have no `async`/`fs`/`spawn`/`sqlite`

## Recommendations
1. Keep Plane C APIs synchronous. Do not add `Promise` return types, `crypto.subtle.digest`, or async Zod refinements; purity here is the fail-closed property App/Plug rely on.
2. Keep Git, SQLite, spawn, and `.semctx/` lifetimes in `app-services`. Do not open adapters from `control-engine` even if control-plane docs mention index files.
3. Keep `evaluatedAt` / `verifiedAt` / `capturedAt` as injected ISO strings. Never sample `Date.now()` inside C (that would make capsules non-replayable).
4. Optional (not a defect): route `fingerprintCoordinateGraph` through `sha256HashUtf8` so `node:crypto` lives only in `hashing.ts`. Leave hashing sync; WebCrypto would introduce hidden promises.
