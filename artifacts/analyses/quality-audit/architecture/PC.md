# Architecture — PC

## Summary
Reviewed Plane C production source only (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 52 `.ts` files). The partition honors the hard boundary: engines are graph-in, reports fix `executionAuthority: "none"`, and there is no executor, Git, SQLite, spawn, or filesystem AST. `control-model` depends on Zod only; `control-engine` reads A+B via `@semantic-context/core` types and `@semantic-context/semantic-model/reconciliation-read`; the verifier re-derives capsules from `control-model` and must not import `control-engine` at runtime. Health is strong. Worst issue is inbound coupling (Plane B/App depend on `control-model` as a shared vocabulary kernel), not a C→A/B write or a package cycle.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| _None._ | | | | | | |

## Metrics
- Files read: 31 (52 Plane C src files scanned; tests/`dist` skipped)
- Findings: 0 (P0/P1/P2/P3)
- Spawn / Git / SQLite / `node:fs` / AST-parse sites in src: 0
- Package cycles with `semantic-*` / `app-services`: none
- Node builtins in src: `node:crypto` only (`control-model/src/hashing.ts:1`, `control-engine/src/architecture.ts:1`)

Cross-layer imports (allowed direction: C reads A+B; graph-in):

| Location | Import |
|----------|--------|
| `packages/control-engine/src/coordinates.ts:1` | `import type { RepositoryEdge, RepositoryNode } from "@semantic-context/core"` |
| `packages/control-engine/src/coordinates.ts:2` | `import { compareIds } from "@semantic-context/core"` |
| `packages/control-engine/src/coordinates.ts:16-23` | value+type from `@semantic-context/semantic-model/reconciliation-read` (`buildRepositoryLinkIndex`, `resolveRepositoryLink`, `resolveRepositoryLinks`, `RepositoryFacts`, `SemanticModel`, `SemanticNode`) |
| `packages/control-engine/src/task-envelope.ts:1` | `import type { TaskFrame } from "@semantic-context/core"` |
| `packages/control-engine/src/task-envelope.ts:25-29` | `ReconciliationChangeContractSchema` + types from `@semantic-context/semantic-model/reconciliation-read` |
| `packages/control-engine/src/policy.ts:19` | `import { compareIds } from "@semantic-context/core"` |
| `packages/control-engine/src/traversal.ts:1` | `import { compareIds } from "@semantic-context/core"` |

No src imports of `@semantic-context/semantic-engine`, `semantic-dsl`, `app-services`, `repository-store`, `context-engine`, `ts-analyzer`, `python-analyzer`, or `mcp-server`.

Coupling notes (not findings; inbound / intentional):
- `control-engine` → `semantic-model` → `control-model` is acyclic. Plane B (`semantic-model/src/types.ts`, `repository-links.ts`, `reconciliation-read.ts`) and App (`app-services`) depend *on* `control-model`; `control-model/src/link-resolution.ts:4-7` documents itself as the shared reason-code kernel “all four already depend on”.
- `change-authorization-verifier` production deps: `control-model` only. `control-engine` is `devDependencies` (frozen-vector tests). `src/derive.ts:4-8` explicitly refuses to import the engine.
- `semantic-model/src/reconciliation-read.ts` is the intended C adapter, but it also re-exports `mergeModels` / `emptyModel` from `./model`. Plane C src does not call those writers.
- SQLite/Git observation described in `docs/architecture/control-plane-v1.md` lives in `app-services`, not these packages — engines stay graph-in, which matches STRATEGY.

## Recommendations
1. Keep Git, SQLite, and `.semctx/` lifetimes in `app-services`. Do not add store/FS adapters to `control-engine` even though control-plane docs mention “adapters open the SQLite index”.
2. Keep the verifier’s `control-engine` dependency dev-only; the architecture test in that package is the right lock.
3. Optional (P2-class, not blocking): if B→C type imports become a plane-purity goal, move the shared link-resolution vocabulary (and only that) into `core` so `control-model` is strictly above B. Do not do this as a drive-by; the current placement is an explicit anti-drift choice.
4. Do not import `mergeModels` / `emptyModel` through `semantic-model/reconciliation-read` from Plane C; consider narrowing that barrel on the B side so C cannot reach writers.
