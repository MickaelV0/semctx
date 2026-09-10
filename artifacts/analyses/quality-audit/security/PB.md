# Security — PB

## Summary
Reviewed Plane B + `core` source (`packages/core`, `semantic-model`, `semantic-dsl`, `semantic-engine`; tests skipped) as an untrusted-repo surface: authored `.sem`, target JSON, handoff JSON, and FS writes under `.semctx/`. No spawn, SQL, `eval`, or network I/O in this partition — SECURITY.md’s argv/SQL/network claims are vacuously true here. Target artifacts are the hardened path (Zod + self-hash + `O_EXCL` / no-follow). Worst issue: the public `.sem` loader (`store.listSemFiles`) follows a symlinked `.semctx/semantic` root and the public writers (`writeAtomic`, `ensureSemanticGitignore`) follow planted destination/tmp/`.gitignore` symlinks, so an untrusted tree can read and overwrite files outside the repo. The reconciliation-read / target / anchor-migration paths already refuse that class of escape.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SEC-PB-01 | P0 | packages/semantic-engine/src/store.ts:24 | Untrusted-repo path escape on the public load/format path. `listSemFiles` never `lstat`s the walk root; `readdirSync` follows a directory symlink, so a planted `.semctx/semantic` (or `.semctx`) symlink makes `loadSemanticModel` / `formatSemanticFiles` read and rewrite `*.sem` outside the repo. Child `.sem` *file* symlinks are refused; the start directory is not. `reconciliation-read.ts` already refuses a symlinked walk root. `migrateAnchors` then re-checks with `realpath` (`assertWithinSemanticDir`); format/load do not. | `if (!existsSync(dir)) return [];` | Match `listSemanticFiles`: `lstat` every directory including the start, refuse all symlinks (not only `*.sem` names), `realpath`-contain under `.semctx/semantic` before read or write. | 95 |
| SEC-PB-02 | P1 | packages/semantic-engine/src/store.ts:99 | Predictable tmp + symlink-following writes. `writeAtomic` always uses `${path}.tmp` and `writeFileSync` (follows a planted tmp symlink, then `renameSync`). Same pattern in `handoff.ts`. `ensureSemanticGitignore` `writeFileSync`s `.gitignore` with no `lstat`, so a `.gitignore` symlink is overwritten through. Callsites: `writeKindFile` / `writeChangeFile` / `writeActiveChange` / `formatSemanticFiles` / `initSemanticScaffold` / `captureHandoff` / CLI `init`. Targets already use `openSync(tmp, "wx")`; migration uses `claimExclusive` (`O_EXCL`) and unguessable tmp names. | `const tmp = \`${path}.tmp\`;` | Exclusive create (`wx` / `O_EXCL` / `O_NOFOLLOW`), unguessable tmp names, `lstat` destination (and `.gitignore`) and refuse symlinks; reuse the target-artifact writer. | 93 |
| SEC-PB-03 | P2 | packages/semantic-dsl/src/parse.ts:87 | `.sem` boundary is a tolerant best-effort parser, not Zod. `parseSemanticSource` never calls `SemanticModelSchema`; invalid ids, unconstrained `file:` / unprefixed path links (`repositoryLinkFromRef`), and arbitrary `meta` keys still enter the in-memory model. `checkSemanticModel` flags bad ids only if a caller invokes it. Link resolution does **not** open those paths (index lookup only), so this is not itself a traversal. Refinement blocks *do* `RefinementRelationV1Schema.safeParse`. | `export function parseSemanticSource(text: string, file: string): ParseResult {` | After parse, `SemanticModelSchema.safeParse` (or fail-closed on `isValidSemanticId` + reject `..` / absolute `file:` refs). Keep check as a report; do not load-merge a model that failed the schema. | 78 |
| SEC-PB-04 | P2 | packages/semantic-engine/src/handoff.ts:143 | Working `handoff.json` is `JSON.parse` plus a structural guard, not Zod. `isHandoffCapsule` requires `createdAt: string` and seven Array fields; it does not check `HANDOFF_SCHEMA_VERSION`, array element types, or extra keys. SECURITY.md’s “JSON.parse + Zod at the boundary” holds for target artifacts, not this capsule. | `const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));` | Parse with a strict Zod capsule schema (version literal, `z.array(z.string())`, `.strict()`). | 88 |

## Metrics
- Files read: 36 (src) + SECURITY.md
- Findings: 4 (P0: 1 / P1: 1 / P2: 2 / P3: 0)
- Partition source files (excl. tests): 45 (`core` 11, `semantic-model` 9, `semantic-dsl` 7, `semantic-engine` 18)
- Spawn sites in src: 0
- SQL sites in src: 0
- `eval` / `Function(` / `fetch` / `child_process`: 0
- `JSON.parse` sites reviewed: 6 (`refinement.ts:66` quoted-string only; `handoff.ts:143`; `targets.ts:232` + Zod; `reconciliation-read.ts:122` + Zod; `anchor-migration.ts:619` lock pid/token; `anchor-migration.ts:713` journal + `isTransactionRecord`)
- Path/FS write APIs counted: `listSemFiles` / `writeAtomic` (store + handoff) / `ensureSemanticGitignore` / `changeFilePath`+`targetArtifactPath` / `listSemanticFiles` / `createImmutableArtifact` / anchor-migration exclusive writer
- Hash/canonicalization: `TargetArchitectureArtifactV1Schema` `superRefine` recomputes `computeTargetArtifactHash`; no bypass found in this plane
- YAML parser: none (custom `.sem` DSL). File `link:` values are not opened in Plane B

## Recommendations
1. Treat `store.ts` as the untrusted-repo FS boundary, not a simpler cousin of `reconciliation-read.ts`. One walker: refuse symlinks on the root and every child, then `realpath`-contain, used by load, format, and scaffold.
2. Delete predictable `.tmp` + following `writeFileSync`. One exclusive no-follow publisher (already exists for target artifacts and anchor migration) for kind files, change files, active-change, handoff, and `.gitignore`.
3. Fail closed on authored model load: schema (or equivalent id/link constraints) before merge/format/verify. Zod as it stands will not reject `file:../…` — add a repo-relative path rule if file links must never name a location outside the tree.
4. Keep target-artifact hashing and refinement `JSON.parse` (string-only + printable ASCII) as the pattern; do not weaken them to match `store`/`handoff`.
