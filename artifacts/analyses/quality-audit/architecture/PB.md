# Architecture — PB

## Summary
Scanned Plane B (`semantic-model`, `semantic-dsl`, `semantic-engine`) plus `core` source (tests skipped). `core` matches the hard boundary: Zod only, no other package or `node:`/`bun:` imports. `semantic-engine` does **not** persist SQLite and does **not** rank claims/packs; it also does **not** mutate Plane A graphs or Plane C control state. Worst issue is inverted layering: all three Plane B packages depend on `control-model` (Plane C), and `semantic-engine` additionally imports the App persist and ranking packages for a path helper and `GraphIndex`.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ARCH-PB-01 | P1 | packages/semantic-model/src/schemas.ts:9 | Plane B → Plane C inversion. STRATEGY: Plane C reads A+B. All three B packages depend on `@semantic-context/control-model`. `repository-links.ts` uses the `link-resolution` subpath to avoid C authority modules, but `schemas.ts` value-imports the package root, whose index re-exports `altitude-authority`, `agent-workflow`, `control-handoff`, and change-authorization. | `} from "@semantic-context/control-model";` | Lift shared vocab (authored levels, refinement schemas, link-resolution codes, hash/serialize helpers) into `core`. Plane B imports `core` only; keep C as a reader of A+B. Stop value-importing the C package root from B. | 92 |
| ARCH-PB-02 | P1 | packages/semantic-engine/src/verify.ts:11 | Confirmed `package.json` suspect: `semantic-engine` depends on `context-engine` (App ranking). Code does **not** call ranking APIs (`evaluateClaim`, `WEIGHTS`, `buildContextPack`). It only uses `GraphIndex.has` / `inEdges` over an in-memory `facts.graph`. The import is still a B→App layer hop: it loads the ranking package root. | `import { GraphIndex } from "@semantic-context/context-engine";` | Move `GraphIndex` to `core` (graph adjacency is Plane A data, not ranking). Drop `@semantic-context/context-engine` from `semantic-engine`. | 90 |
| ARCH-PB-03 | P1 | packages/semantic-engine/src/paths.ts:5 | Confirmed `package.json` suspect: `semantic-engine` depends on `repository-store` (App persist). Code does **not** call `openStore` / `SqliteRepositoryStore`. It only uses `semctxDir` to join `.semctx/semantic` and `.semctx/working`. The import still loads the persist package (`index` → `workspace.ts` imports `SqliteRepositoryStore`). Plane B `.sem` / target / handoff writes are the documented file model, not SQLite persist. | `import { semctxDir } from "@semantic-context/repository-store";` | Move `SEMCTX_DIR` / `semctxDir` to `core`. Drop `@semantic-context/repository-store` from `semantic-engine`. | 90 |

## Metrics
- Files read: 38
- Findings: 3 (P0: 0 / P1: 3 / P2: 0 / P3: 0)
- Partition source files (excl. tests): 45 (`core` 11, `semantic-model` 9, `semantic-dsl` 7, `semantic-engine` 18)
- `core` non-Zod runtime deps: 0 (`package.json` and `src/` both Zod-only)
- Plane B mutating Plane A/C: none (`GraphIndex` is read-only; `applyChangePatch` returns a new contract; FS writes stay under `.semctx/semantic` and `.semctx/working`)
- Package cycles involving this partition: none (`control-model` depends on Zod only; `context-engine` / `repository-store` do not depend on Plane B)
- Cross-layer imports (file:line):
  - B→C `packages/semantic-model/src/types.ts:13` `@semantic-context/control-model` (type)
  - B→C `packages/semantic-model/src/types.ts:14` `@semantic-context/control-model/link-resolution` (type)
  - B→C `packages/semantic-model/src/types.ts:15` `@semantic-context/control-model` (type re-export)
  - B→C `packages/semantic-model/src/schemas.ts:9` `@semantic-context/control-model` (**value**, package root)
  - B→C `packages/semantic-model/src/reconciliation-read.ts:6` `@semantic-context/control-model/link-resolution`
  - B→C `packages/semantic-model/src/repository-links.ts:12` `@semantic-context/control-model/link-resolution`
  - B→C `packages/semantic-dsl/src/refinement.ts:10` `@semantic-context/control-model/reconciliation`
  - B→C `packages/semantic-engine/src/target-architecture-artifact.ts:12` `@semantic-context/control-model/reconciliation`
  - B→C `packages/semantic-engine/src/targets.ts:25` `@semantic-context/control-model` (type)
  - B→App `packages/semantic-engine/src/verify.ts:11` `@semantic-context/context-engine`
  - B→App `packages/semantic-engine/src/paths.ts:5` `@semantic-context/repository-store`
  - B→A analyzers: none
  - `core` → non-Zod: none

## Recommendations
1. Treat `control-model` as Plane C contracts, not a second kernel. Shared tuples currently justified as “the lowest package all four already depend on” (`link-resolution.ts`) belong in `core`.
2. Delete `semantic-engine`’s `context-engine` and `repository-store` dependencies after relocating `GraphIndex` and `semctxDir`. Re-test that `verifyChangeContract` still expands `constrained_by` footprints without loading scoring/pack modules.
3. Make the subpath doctrine real: forbid Plane B value-imports of `@semantic-context/control-model` (package root). `schemas.ts:9` is the leak; `repository-links.ts:5-7` already states the rule.
4. Keep Plane B file I/O (`store.ts`, `targets.ts`, `handoff.ts`) where it is — that is the Plane B file model, not a repository-store violation.
