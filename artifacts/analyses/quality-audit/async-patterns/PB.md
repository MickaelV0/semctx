# Async Patterns — PB

## Summary
Reviewed Plane B + `core` source (`packages/core`, `semantic-model`, `semantic-dsl`, `semantic-engine`; tests skipped). The partition is entirely synchronous: no `async`/`await`/`Promise`, no `Bun.spawn`, no SQLite, no index-worker. Sync FS is the file model (`store.ts` states SQLite is not used for Plane B). Anchor migration and target artifacts already use exclusive unique temps + `O_EXCL` + fsync. Worst issue is the public mutable publisher `writeAtomic` (duplicated in `store.ts` and `handoff.ts`): a fixed `${path}.tmp` with no exclusive create, so two writers of the same dest can interleave content and the second `renameSync` throws `ENOENT`.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ASYNC-PB-01 | P1 | packages/semantic-engine/src/store.ts:99 | Shared tmp name on the mutable `.sem` / handoff publisher. `writeAtomic` always uses `${path}.tmp` then `writeFileSync` + `renameSync`, with no `O_EXCL` and no fsync. Callsites: `writeKindFile` / `writeChangeFile` / `writeActiveChange` / `formatSemanticFiles` / `initSemanticScaffold`, and the copy at `handoff.ts:87` (`captureHandoff`). Two processes writing the same dest share one tmp: writes overwrite each other; the later `renameSync` hits `ENOENT` after the first rename consumes the tmp. Targets (`targets.ts:178`, `openSync(tmp, "wx")`) and migration (`temporaryName` + `claimExclusive`) already avoid this. Not the symlink case (security owns that). | `const tmp = \`${path}.tmp\`;` | One helper: unguessable tmp, `openSync(..., "wx")`, fsync, `renameSync`. Delete the handoff duplicate. | 90 |
| ASYNC-PB-02 | P2 | packages/semantic-engine/src/store.ts:105 | Store writers ignore the migration exclusive lock. `migrateAnchors` serializes via `renameSync(candidate, …/active)` (`anchor-migration.ts:1142`) and `durableSwap` then `rename`s unique temps onto the same kind/change files `writeKindFile` / `formatSemanticFiles` publish. Those writers never look at `anchor-migration-v1/active`. Interleave: swap lands migrated bytes, `writeAtomic` renames over them, swap hash-check fails, recovery restores blobs and drops the store write (or the store write sticks and the journal is wrong). Preimage check (`:1350`) only runs before `REPLACE_STARTED`. | `writeAtomic(kindFilePath(root, kind), formatModel({ nodes, changes: [] }));` | Refuse `writeKindFile` / `writeChangeFile` / `formatSemanticFiles` while `…/anchor-migration-v1/active` exists (same owner check as `refuseLiveOwner`), or take that lock for the write. | 74 |
| ASYNC-PB-03 | P3 | packages/semantic-engine/src/targets.ts:306 | `assertSameFile` can leak the first fd. `openSync(left)` then `openSync(right)` then `try/finally` closes both. If the second open throws (ENOENT after the test hook unlinks, `O_NOFOLLOW` on a replaced symlink), `leftFd` is never closed. `stillSameFile` swallows that throw. Short-lived CLI, but the pairing is wrong; every other `openSync` in this package uses per-handle `try/finally`. | `const leftFd = openSync(leftPath, constants.O_RDONLY \| noFollow);` | Nested `try/finally` per fd (open left; try { open right; try { fstat } finally close right } finally close left). | 92 |

## Metrics
- Files read: 18 (all 45 partition sources grepped; writers + lock protocol read)
- Findings: 3 (P0: 0 / P1: 1 / P2: 1 / P3: 1)
- Partition source files (excl. tests): 45 (`core` 11, `semantic-model` 9, `semantic-dsl` 7, `semantic-engine` 18)
- Spawn sites in src: 0
- SQLite write sites in src: 0 (`store.ts:3` — “SQLite is not used for Plane B in v1”; `repository-store` import is `semctxDir` only)
- `async` / `await` / `Promise` / `.then(` / `Bun.spawn` / `setTimeout`: 0
- Missing-await suspects: 0
- `writeAtomic` definitions: 2 (`store.ts:97`, `handoff.ts:85`) — identical shared-tmp rename
- `renameSync` (src): store/handoff `writeAtomic`; migration lock/recovery/cleanup/durableSwap (`anchor-migration.ts:265`, `:988`, `:1016`, `:1059`, `:1104`, `:1142`, `:1183`)
- Exclusive publishers (good): `createImmutableArtifact` unique tmp + `wx` + `linkSync`; `durableSwap` `temporaryName` + `claimExclusive` + fsync + rename
- `openSync` sites: 10 in `anchor-migration.ts` (all closed in `try/finally` or `fillAndClose`); 3 in `targets.ts` (tmp fd closed; `assertSameFile` pairing is ASYNC-PB-03)
- Index-worker / DB handles: none in this partition

## Recommendations
1. Replace both `writeAtomic` copies with the exclusive unique-tmp publisher already used for target artifacts and anchor swaps. That removes the concurrent-writer `ENOENT` and the predictable tmp in one change.
2. Treat `…/working/anchor-migration-v1/active` as a repo-wide writer lock for `.sem` mutations, not only for a second `migrateAnchors`. Store writes should fail closed while it exists.
3. Pair every `openSync` with its own `finally closeSync`. Do not open the second fd before the first is covered.
4. Keep Plane B synchronous. Do not introduce `async` FS or SQLite here; the file model is the source of truth.
