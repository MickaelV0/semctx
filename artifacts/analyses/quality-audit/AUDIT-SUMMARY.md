# Code Quality Audit Summary

Date: 2026-09-09  
Repo: `hoklims/semctx`
Scope: 228 source + 142 test files (excl. `dist/`, `node_modules/`, `typescript-lib/`). 50 domain agents + synthesis. Wave 1 axial skipped (no `.importlinter`, no `axial: true` ADR).  
`ccc` was **not** used as a severity gate (index after Wave 2 echoes these reports; see `axial-drift/cocoindex-confirmations.md`). P0/P1 product confirmation is grep on source. No finding was invented or downgraded for a missing `ccc` hit.

Dedup rule: same location + same issue across domains → keep highest severity, cite both IDs. Exec totals below are after that merge. The metrics table keeps **raw** per-domain counts from the reports.

| | P0 | P1 | P2 | P3 | Total |
|--|----|----|----|----|-------|
| Raw (sum of reports) | 3 | 61 | 176 | 54 | 294 |
| After dedup | 3 | 59 | 171 | 52 | 285 |

Deduped pairs: `SEC-PB-02`+`ASYNC-PB-01`; `ERR-PC-01`+`SEC-PC-02`; `ERR-PC-02`+`SEC-PC-03`; `ERR-PPLUG-02`+`TYPE-PPLUG-01`+`TYPE-PPLUG-02`; `TYPE-PC-01`+`SMELL-PC-07`; `SMELL-PPLUG-07`+`ERR-PPLUG-04`; `TYPE-PA-05`+`DEBT-PA-05`; `ASYNC-PAPP-09`+`ERR-PAPP-08`.

---

## Executive Summary

The product’s Plane C engines and several hard boundaries (`ts-analyzer` does not persist, `repository-store` does not parse/rank, `core` is Zod-only) are in better shape than the App/Plug surface that actually runs on untrusted checkouts. Security posture is **not** ready for “clone untrusted repo / auto-start MCP / run the composite Action”: three confirmed P0s are bunfig `preload` RCE on MCP and GitHub Action, plus a `.sem` vault walk that follows a directory symlink. Fail-closed is real on **Plane C parsers**. The Action adapter, the Claude guard, Plane A v1 discovery, and altitude/traversal still fail open on malformed input. **`runVerify` is a different contract:** `INDEX_BINDING_ADMISSIBILITY` marks `SEMANTIC_LIFECYCLE_INVALID` / `SEMANTIC_MODEL_INVALID` **admissible on purpose** (`verify.ts:389-393`) so `verify diff --record` can repair a stale evidence baseline while `semctx index` refuses to run against one. Line 488 is `withUnknown`, not a missing BLOCK. Key debt is N×M duplication (CLI vs MCP vs `app-services`; plugin hosts) and the withdrawn retriever still shipped.

- **Health:** Plane C architecture/async reports are clean (0 findings). App+Plug transports, Plane B FS, and tests are the load-bearing risk.
- **Security:** 3 P0 (confirmed in product source). Untrusted-repo symlink writes, `ccc` option injection, and git filter/`GIT_*` env gaps sit at P1/P2.
- **Tests:** 22 P1 holes, concentrated on P0/P1 gates (bunfig, `listSemFiles` root symlink, guard stdin, adapter unknown verdict). Do **not** invert TEST-TAPP-01 — it pins the admissibility table (quote below).
- **Debt:** Experimental `ContextPack` / `prepare_task` still shipped; Action/preset pins at `v0.1.18` while CLI is `0.1.20`; dual Zod majors at MCP; committed ~12 MB plugin `dist/` trees ×2 hosts.

---

## Critical Issues (P0)

All three kept after source confirmation (`axial-drift/cocoindex-confirmations.md`).

| ID | Location | Issue | Source report |
|----|----------|-------|---------------|
| SEC-PB-01 | `packages/semantic-engine/src/store.ts:24` | `listSemFiles` never `lstat`s the walk root; `readdirSync`+`entry.isDirectory()` follows a planted `.semctx/semantic` (or `.semctx`) **directory** symlink, so `loadSemanticModel` / `formatSemanticFiles` read and rewrite `*.sem` outside the repo. Child `*.sem` *file* symlinks throw; the start directory does not. `reconciliation-read.ts` already refuses a symlinked walk root. | `security/PB.md` |
| SEC-PPLUG-01 | `plugins/claude-code/mcp-omp.json:6` | MCP launch is `command: bun` + `"cwd": "."`. Bun loads `$cwd/bunfig.toml` and runs `preload` before `dist/semctx-mcp.js`. A cloned untrusted repo RCEs the user when the plugin auto-starts. Same: `plugins/semctx-control/.mcp.json:6`; `plugins/claude-code/.mcp.json` has `command: bun` and no cwd (host default = project). `.env` in cwd also injects unset vars (`GIT_DIR`, `NODE_OPTIONS`). | `security/PPlug.md` |
| SEC-PPLUG-02 | `packages/github-action/action.yml:73–90` | Verify step sets `working-directory` to the consumer/PR checkout then `bun "$SEMCTX_CLI" init/index/verify --root .`. Same bunfig `preload` RCE as SEC-PPLUG-01. Contradicts SECURITY.md “does not execute arbitrary PR scripts.” `${{ }}` in `run:` is clean; this is cwd/runtime config. | `security/PPlug.md` |

---

## High Priority (P1)

| ID | Location | Issue | Source report |
|----|----------|-------|---------------|
| ARCH-PAPP-01 | `packages/mcp-server/src/tools.ts:16` | MCP is not a thin transport: `semctx_prepare_task` / `semctx_inspect` open the store and call `context-engine` directly. | `architecture/PApp.md` |
| ARCH-PAPP-02 | `apps/cli/src/commands/inspect.ts:3` | CLI inspect/task/context/semantic/init/migrate bypass `app-services` (open SQLite + engines). `index`/`verify`/`control`/`status` already go through it. | `architecture/PApp.md` |
| ARCH-PAPP-03 | `packages/repository-store/src/workspace.ts:81` | CLI `openStore()` `mkdirSync(.semctx)` and opens SQLite, skipping `openReadyRepository` (`CONFIG_NOT_FOUND` / `REPO_NOT_INDEXED`). | `architecture/PApp.md` |
| ARCH-PB-01 | `packages/semantic-model/src/schemas.ts:9` | Plane B→C inversion: all three B packages depend on `@semantic-context/control-model`; `schemas.ts` value-imports the package root (authority modules re-exported). | `architecture/PB.md` |
| ARCH-PB-02 | `packages/semantic-engine/src/verify.ts:11` | `semantic-engine` depends on `context-engine` for `GraphIndex` (B→App hop; no ranking APIs used). | `architecture/PB.md` |
| ARCH-PB-03 | `packages/semantic-engine/src/paths.ts:5` | `semantic-engine` depends on `repository-store` only for `semctxDir`, but still loads the persist package. | `architecture/PB.md` |
| ARCH-PPLUG-01 | `plugins/claude-code/hooks/semctx-guard.mjs:1561` | Guard reimplements `captureVerificationGitState` instead of sharing with `app-services`; already drifted (`hiddenTrackedPaths` only on the service). | `architecture/PPlug.md` |
| ARCH-PPLUG-02 | `scripts/benchmark-multicore-index.ts:6` | Plug script imports private `plane-a-internal` `digestCanonical` and `initWorkspace`. | `architecture/PPlug.md` |
| SEC-PA-01 | `packages/cocoindex-adapter/src/cocoindex-provider.ts:46` | `ccc search` interpolates `input.query` as a raw argv token with no `--`; flag-shaped queries are option injection. | `security/PA.md` |
| SEC-PA-02 | `packages/ts-analyzer/src/ts-symbols.ts:181` | Default sync `createProgram` / `ts.sys` follows relative imports and `/// <reference path>` outside `repoRoot` (reads escaped files). | `security/PA.md` |
| SEC-PAPP-01 | `packages/repository-store/src/workspace.ts:81` | Untrusted repo can redirect `.semctx` writes via a committed directory or `semctx.db` symlink (`mkdirSync`/`open` follow links). Same line as ARCH-PAPP-03, different issue. | `security/PApp.md` |
| SEC-PB-02 (ASYNC-PB-01) | `packages/semantic-engine/src/store.ts:99` | `writeAtomic` uses predictable `${path}.tmp` + `writeFileSync` (follows a planted tmp symlink) then `renameSync`; two processes share one tmp. Copy at `handoff.ts:87`. Contrast: `anchor-migration` exclusive temps. | `security/PB.md`, `async-patterns/PB.md` |
| SMELL-PAPP-01 | `apps/cli/src/commands/install.ts:991` | Copied `normalizeGitSource` / `isSemctxSource` omit the userinfo strip at `plugin-delivery.ts:565` — credentialed marketplace URLs disagree between status and install. | `code-smells/PApp.md` |
| TYPE-PA-01 | `packages/cocoindex-adapter/src/cocoindex-provider.ts:67` | **Overstated.** `JSON.parse` is `:61`; `:67` is `as { results?: unknown[] }` then `toCandidate` filters rows. Unvalidated parse is real; “JSON `null` throws, contradicting degrade-to-empty” is the overstated part. | `type-safety/PA.md` |
| TYPE-PAPP-01 | `packages/repository-store/src/store.ts:452` | `loadGraph` / `loadClaims` cast `kind` unions and `JSON.parse` evidence with no `NodeKind`/`ClaimKind` check; a bad row is a typed `RepositoryGraph`. | `type-safety/PApp.md` |
| TYPE-PAPP-02 | `packages/app-services/src/reconciliation-index.ts:1852` | Attested-commit “proposal contained” `JSON.parse`s as `TargetArchitectureArtifactV1` and compares three fields; `target-review.ts` already uses `parseArtifact`. | `type-safety/PApp.md` |
| TYPE-PB-01 | `packages/semantic-engine/src/handoff.ts:131` | `isHandoffCapsule` is a lying type predicate over unvalidated `JSON.parse` (no `version === 1`, no element types). | `type-safety/PB.md` |
| TYPE-PC-01 (SMELL-PC-07) | `packages/control-engine/src/reconciliation-validation.ts:140` | Graph/hunk/relation parsers skip existing Zod (`CoordinateGraphReportV2Schema`, hunk schemas) and assert the domain type. | `type-safety/PC.md`, `code-smells/PC.md` |
| ASYNC-PA-01 | `packages/cocoindex-adapter/src/cocoindex-provider.ts:45` | `search` / `version` wrap `Bun.spawnSync` with no `timeout`/`kill`; a hung `ccc` never yields (blocks worker timers). | `async-patterns/PA.md` |
| ASYNC-PAPP-01 | `apps/cli/src/commands/context.ts:18` | WAL writer opened then `await fetchProviderCandidates` with no `try/finally`; leftover sidecars make readers throw. | `async-patterns/PApp.md` |
| ASYNC-PAPP-02 | `packages/app-services/src/verify.ts:104` | Core git helpers are `Bun.spawnSync` with no `timeout`/`maxBuffer` (`freshness.ts:220`, `verification-state.ts:23`, …). Plugin-delivery already uses 5s + kill. | `async-patterns/PApp.md` |
| ASYNC-PAPP-03 | `apps/cli/src/commands/install.ts:323` | Two `Bun.spawn` Codex cleanup paths are `detached: true` + `unref()` with no kill; inner scripts poll up to 12h. | `async-patterns/PApp.md` |
| ASYNC-PAPP-04 | `packages/repository-store/src/store.ts:184` | WAL writer has no `busy_timeout`; `wal_checkpoint(TRUNCATE)` on `busy !== 0` still closes then throws — sidecars remain; readers refuse WAL. | `async-patterns/PApp.md` |
| ASYNC-PPLUG-01 | `plugins/claude-code/hooks/semctx-guard.mjs:1638` | PreToolUse is a sync host-wait hook that walks every path with `readFileSync` + unbounded `execFileSync`/`spawnSync`. | `async-patterns/PPlug.md` |
| ERR-PA-01 | `packages/ts-analyzer/src/discovery.ts:231` | v1 `discoverFiles` empty-catches `readFileSync` and omits the file; v1 then labels it `LEGACY_UNSUPPORTED_EXTENSION`, not `READ_FAILED`. | `error-handling/PA.md` |
| ERR-PA-02 | `packages/ts-analyzer/src/discovery.ts:161` | `walk(..., strict=false)` swallows `readdirSync`/`lstatSync`; unreadable dirs vanish (empty analysis, no `IO_ERROR`). | `error-handling/PA.md` |
| ERR-PA-03 | `packages/ts-analyzer/src/analyze.ts:446` | `buildTypeScriptSidecar` always writes `analysisOutcome: "analyzed"` / `status: "completed"` even after discovery dropped every file. | `error-handling/PA.md` |
| ERR-PAPP-01 | `packages/app-services/src/verify.ts:488` | **Footnote, not a missing BLOCK.** After breaking reasons already `refuseImpact`, `!canRunHighRiskControl` calls `withUnknown` and leaves `analyzeDiff`’s verdict. That is the designed annotate-not-block path. `SEMANTIC_LIFECYCLE_INVALID` / `SEMANTIC_MODEL_INVALID` are `"admissible"` at `:389-393` so index and `--record` cannot deadlock. Unknowns still do not change CLI `exitCode` (`apps/cli/src/commands/verify.ts:62`). | `error-handling/PApp.md` |
| ERR-PAPP-02 | `packages/app-services/src/freshness.ts:242` | Non-zero `rev-parse HEAD` inside a Git repo returns `new Uint8Array()` (unborn **or** corrupt/lock hashed as a clean tracked diff). | `error-handling/PApp.md` |
| ERR-PB-01 | `packages/semantic-engine/src/store.ts:152` | `formatSemanticFiles` always `formatModel` + `writeAtomic`; never `hasErrors`. A file with one good node and one broken block is rewritten as only the good node. | `error-handling/PB.md` |
| ERR-PB-02 | `packages/semantic-engine/src/store.ts:80` | Invalid active-change pointer is collapsed to “none”; `loadModelWithWorking` overlays nothing and drops pointer diagnostics. | `error-handling/PB.md` |
| ERR-PB-03 | `packages/semantic-engine/src/targets.ts:219` | Catch-all recodes `CONTROL_INPUTS_UNSAFE` / `CONFIG_INVALID` as `IO_ERROR` and stringifies `cause`. | `error-handling/PB.md` |
| ERR-PC-01 (SEC-PC-02) | `packages/control-engine/src/altitude-authority.ts:28` | Autonomous write is gated on caller `canRunHighRiskControl`, not `verdict`. `{ verdict: "STALE", canRunHighRiskControl: true, allowsAutonomousWrite: true }` is schema-valid. | `error-handling/PC.md`, `security/PC.md` |
| ERR-PC-02 (SEC-PC-03) | `packages/control-engine/src/traversal.ts:542` | `isStale` is true only when both seals are present and differ. Default `bounds = {}` (UNSEALED) is treated as not stale; `lift`/`lower` walk. | `error-handling/PC.md`, `security/PC.md` |
| ERR-PPLUG-01 | `plugins/claude-code/hooks/semctx-guard.mjs:1611` | Blocking PreToolUse `JSON.parse` failure calls `process.exit(0)` before enablement / git-verb checks — truncated stdin allows `git commit`/`push`. | `error-handling/PPlug.md` |
| ERR-PPLUG-02 (TYPE-PPLUG-01, TYPE-PPLUG-02) | `packages/github-action/src/adapter.mjs:80` | Adapter is the job gate after `--fail-on none`. Missing/`STALE`/`UNSEALED`/unknown `verdict`, and any `fail-on` other than `block`/`warn`, exit 0. Report is `JSON.parse`d with no schema. | `error-handling/PPlug.md`, `type-safety/PPlug.md` |
| TQ-TA-01 | `packages/ts-analyzer/test/discovery-selection.test.ts:195` | No `READ_FAILED` / unreadable-file case; v1 silent skip stays green. | `test-quality/TA.md` |
| TQ-TA-02 | `packages/ts-analyzer/test/plane-a-sidecar.test.ts:44` | Sidecar test locks `status: "completed"`; no path from parse-error / omitted roots to `PRODUCER_FAILED`. | `test-quality/TA.md` |
| TQ-TA-03 | `packages/plane-a-internal/test/evaluation.test.ts:378` | Isolated freshness table covers `STALE` only; `UNSEALED` / `DIRTY_KNOWN` never set. | `test-quality/TA.md` |
| TQ-TA-04 | `packages/ts-analyzer/test/discovery-selection.test.ts:99` | Containment tests skip nested-git only (`symlinkSync` at `:99`); no `.semctx` tree, `.semctx` symlink, or source-file symlink. | `test-quality/TA.md` |
| TEST-TAPP-01 | `packages/app-services/test/verify-index-binding.test.ts:497` | Pins the **admissibility table**, not a hole to invert. Test name: `"records an unknown but never blocks on a reason that preserves coordinates"`. Comment at `:472-475`: a reason that does not invalidate a line range must never block, or `semctx index` (refuses a stale evidence baseline) and `verify diff --record` deadlock. Asserts `verdict.not.toBe("BLOCK")`, no `index_binding_stale`, and `unknowns` contain `"index binding"`. | `test-quality/TApp.md` |
| TEST-TAPP-02 | `apps/cli/test/verify-cli.test.ts:18` | CLI/MCP integration spawn `bun` with `cwd` = analyzed repo; zero tests plant `bunfig.toml` `preload`. | `test-quality/TApp.md` |
| TEST-TAPP-03 | `packages/repository-store/test/workspace.test.ts:13` | `openStore` mkdir / `.semctx` symlink refusal untested. | `test-quality/TApp.md` |
| TEST-TAPP-04 | `packages/mcp-server/test/mcp-2026-contract.test.ts:676` | “Oversized input” is 1_000 objects under the 50_000/100_000 ceilings; no depth/node/string-byte budget test. | `test-quality/TApp.md` |
| TEST-TAPP-05 | `packages/app-services/test/plugin-delivery.test.ts:1357` | Spawn timeout is mock-echo on hosts; product git `spawnSync` timeout untested. | `test-quality/TApp.md` |
| TEST-TB-01 | `packages/semantic-engine/test/path-safety.test.ts:5` | P0 `listSemFiles` directory-symlink root untested (only unsafe change ids). | `test-quality/TB.md` |
| TEST-TB-02 | `packages/semantic-engine/src/store.ts:99` | `writeAtomic` / `formatSemanticFiles(..., true)` / `captureHandoff` untested. | `test-quality/TB.md` |
| TEST-TB-03 | `packages/semantic-engine/test/anchor-doctrine.test.ts:57` | `checkSemanticModel` STALE→`ok` when `graphIndexed` is false untested (helpers hard-code `true`). | `test-quality/TB.md` |
| TEST-TB-04 | `packages/semantic-engine/test/handoff-robust.test.ts:21` | Invalid JSON/`null`/partial all `toBeUndefined()` — tests lock `readHandoff` fail-open. | `test-quality/TB.md` |
| TEST-TB-05 | `packages/semantic-engine/src/store.ts:80` | Corrupt `working/active-change.sem` / `readActiveChangePointer` untested. | `test-quality/TB.md` |
| TQ-TC-01 | `packages/control-engine/test/coordinates.test.ts:202` | Omitted seals asserted as a successful walk (`COORDINATE_UNKNOWN`); suite would fail if UNSEALED refused. | `test-quality/TC.md` |
| TQ-TC-02 | `packages/control-engine/test/altitude-authority.test.ts:14` | Fixtures only consistent pairs; never `{ verdict: "STALE", canRunHighRiskControl: true }`. | `test-quality/TC.md` |
| TQ-TC-03 | `packages/control-model/test/control-model.test.ts:232` | `classifyControlFreshnessSeal` has zero test imports; STALE/UNSEALED classifier table missing. | `test-quality/TC.md` |
| TQ-TC-04 | `packages/control-model/test/contract-v2.test.ts:365` | Envelope STALE/UNSEALED → `refused`+`INDEX_STALE` rule untested (every case is `FRESH`). | `test-quality/TC.md` |
| TEST-TPLUG-01 | `plugins/plugin-parity.test.ts:423` | Parity/OMP freeze the P0 launch (`command: bun`, `cwd: "."`); no test that consumer `bunfig.toml` `preload` does not run. | `test-quality/TPlug.md` |
| TEST-TPLUG-02 | `plugins/claude-code/test/guard.test.ts:586` | Every guard spawn sends well-formed JSON; no inverted malformed-stdin case (lifecycle has it, and expects exit 0 because that hook is advisory). | `test-quality/TPlug.md` |
| TEST-TPLUG-03 | `packages/github-action/test/adapter.test.ts:76` | Adapter tests only well-typed `PASS`/`WARN`/`BLOCK`; missing verdict / `STALE` / unreadable JSON / unknown `fail-on` untested. | `test-quality/TPlug.md` |
| TEST-TPLUG-04 | `scripts/test/prove-stable-delivery.test.ts:746` | MCP smoke archives freshness “not judged”; `UNSEALED` + `ok: true` is the live handshake expect. | `test-quality/TPlug.md` |
| DEBT-PPLUG-01 | `packages/github-action/README.md:29` | Action pin SSOT split: README `@v0.1.18` (tags through `v0.1.20`); `packages/github-action/package.json` stays `0.1.0`; CLI/plugins are `0.1.20`. | `tech-debt/PPlug.md` |

---

## Medium Priority (P2)

171 remaining after dedup. Not dumped; clustered.

**God files / god functions (~30 product, ~25 test).** Product exemplars: `packages/app-services/src/plugin-delivery.ts` 2093 loc (`SMELL-PAPP-02`, `ARCH-PAPP-06`); `packages/app-services/src/reconciliation-index.ts:239` 2039 (`SMELL-PAPP-03`); `packages/control-model/src/task-envelope-schemas.ts:1100` 1846 (`SMELL-PC-01`); `packages/semantic-engine/src/anchor-migration.ts:1` 1536 (`SMELL-PB-01`); `apps/cli/src/commands/install.ts:1006` 1522 (`SMELL-PAPP-04`, `ARCH-PAPP-07`); `scripts/prove-stable-delivery.ts:1` 2551 (`SMELL-PPLUG-01`); `plugins/claude-code/hooks/semctx-guard.mjs:1` 1667 (`SMELL-PPLUG-04`). Test exemplars: `scripts/test/prove-stable-delivery.test.ts` 2725 (`SMELL-TPLUG-01`); `packages/app-services/test/plugin-delivery.test.ts` 2117 (`SMELL-TAPP-01`); `packages/control-model/test/task-envelope-contract.test.ts:486` 1558 (`SMELL-TC-02`).

**JSON.parse / asserted unions without Zod (~25).** Store task/pack payloads (`TYPE-PAPP-03` `store.ts:248`); freshness snapshot (`TYPE-PAPP-05`); index-health double-cast (`TYPE-PAPP-06`); install `parseJsonArray<T>` (`TYPE-PAPP-07`); `.sem` parser not `SemanticModelSchema` (`SEC-PB-03` `parse.ts:87`); handoff capsule (`SEC-PB-04` `handoff.ts:143`); cocoindex stdout (`SEC-PA-03`); Action `loc.line` into workflow commands (`SEC-PPLUG-04`); Plane C `ZodTypeAny` / `as T` after parse (`TYPE-PC-02`–`05`); journal `as TransactionRecord` (`TYPE-PB-02`).

**Duplicated CLI vs MCP orchestration (~6).** Provider-seal + `prepareContextPack` retry copied (`ARCH-PAPP-04` `tools.ts:52` ≈ CLI `context.ts`); semantic slice/inspect/handoff copied (`SMELL-PAPP-06` `semantic-tools.ts:50`); CLI vs MCP target fixtures copied seven times (`SMELL-TAPP-03`).

**Duplicated parsers / walkers / canonicalizers / fixtures (~20).** Two unified-diff state machines (`SMELL-PAPP-07` `verify-diff.ts:59`); `.sem` link tokenizer mirrored in `anchor-link-locator.ts` (`SMELL-PB-06`); `listSemFiles` copied in `reconciliation-read.ts` with a different `lstat` (`SMELL-PB-08`); change-contract Zod restated (`SMELL-PB-07`); four domain-hash encodings (`SMELL-PC-04`); local `stableJson` clone (`SMELL-PC-05` `architecture.ts:170`); sealed-planning fixtures byte-identical across three packages (`SMELL-TC-01`); TS vs Python marker regex (`ARCH-PA-02` `python-analyzer/src/index.ts:86`); nested-git skip duplicated in discovery vs workspace (`ARCH-PA-04`).

**Unbounded spawn / missing cancellation (~12).** Host install `spawnSync` vs delivery’s 5s budget (`ASYNC-PAPP-07` `install.ts:221`); CLI `openStore` without `finally` (`ASYNC-PAPP-05`); provider fetch no `AbortSignal` (`ASYNC-PAPP-06` `engine.ts:100`); MCP stdio no SIGINT drain (`ASYNC-PAPP-08`); `verify-pr` / bench `Bun.spawn` no timeout (`ASYNC-PPLUG-03`, `ASYNC-PPLUG-04`); cocoindex cwd=untrusted + PATH `ccc` (`SEC-PA-04`); core git inherits `GIT_*` (`SEC-PAPP-03` `freshness.ts:220`).

**Fail-open / swallowed errors (~15).** Sync extraction has no parse diagnostics (`ERR-PA-04`); cocoindex `search` crash ≡ `[]` (`ERR-PA-05`); `git log` failure → `[]` co-changes (`ERR-PAPP-03` `verify.ts:234`); provider `catch { return [] }` (`ERR-PAPP-04`); `checkSemanticModel` `ok: true` when links cannot be observed (`ERR-PB-05` `check.ts:112`); `readHandoff` empty-catch ≡ missing file (`ERR-PB-06`); `impact`/`explainWhy` never call `isStale` (`ERR-PC-03`); delivery smoke accepts STALE/UNSEALED as `ok: true` (`ERR-PPLUG-03` `prove-stable-delivery.ts:1985`); empty eval suite is a perfect PASS (`SMELL-PPLUG-07` `eval/src/run.ts:20`); MCP public budget skips primitive string bytes (`SEC-PAPP-04`).

**Experimental retriever / ADR 0005 leftovers (~8).** Cocoindex adapter inventoried as Plane A but ranks (`ARCH-PA-01` `provider.ts:25`); `attestedSearch` unimplemented (`DEBT-PA-02`); default post-index funnel still advertises `task`/`context prepare` (`DEBT-PAPP-01` `index-cmd.ts:72`); pack path still `resolveProvider`s CocoIndex (`DEBT-PAPP-02` `engine.ts:1`); core config still first-classes `semanticProvider: "cocoindex"` (`DEBT-PB-03`); `ContextPack` still a retriever type (`DEBT-PB-04`); `@semantic-context/eval` still scores packs (`DEBT-PPLUG-04`).

**Version pins / dual-live contracts (~8).** Pack generator frozen at `semctx@0.1.0` (`DEBT-PAPP-03`); `init --preset github-claude` pins Action `@v0.1.18` (`DEBT-PAPP-04` `preset.ts:47`); `@deprecated` `prepareTaskEnvelope` still the live CLI/MCP transport (`DEBT-PAPP-05`); V1/V2 control contracts dual-live with no `@deprecated` (`DEBT-PC-01`); schemaVersion 1 bags keep growing optionals (`DEBT-PC-02`); committed plugin `dist/` ×2 hosts (`DEBT-PPLUG-02`, `ARCH-PPLUG-04`); dual Claude `.mcp.json` / `mcp-omp.json` (`DEBT-PPLUG-03`).

**Plugin / GH Action policy forks (~5).** Action reimplements fail-on + exit 1 vs CLI 3 (`ARCH-PPLUG-03` `adapter.mjs:67`); shadow lifecycle evaluator hand-copied (`ARCH-PPLUG-05`); Claude-only verify/semantic skills (`ARCH-PPLUG-06`); guard `process.exit` vs lifecycle stderr-flush (`ASYNC-PPLUG-02` `semctx-guard.mjs:1661`); guard ancestor `.semctx/guard.json` walk that lifecycle refuses (`SEC-PPLUG-03` `:1182`).

**Test tautology / mock-echo / skip-green (~12).** Any-enum verdict (`TEST-TAPP-06` `tools.test.ts:231`); `symlinkSync` `catch { return }` (`TEST-TAPP-07`); opaque plane-A hash golden (`TEST-TAPP-08`); `runVerify` field-copy seals (`TEST-TAPP-09`); provider mock-echo (`TEST-TAPP-10`); cocoindex tests pin `search() === []` on missing binary (`TQ-TA-05`); mixed-case `expect(true)` (`TQ-TA-06`); pluggy JSON hash (`TQ-TA-07`); frozen-vector self-oracle (`TQ-TC-05`).

---

## Low Priority (P3)

52 remaining after dedup. Clustered.

**Dead / over-exported symbols (~12).** `summarizeMarkerCoverage` (`SMELL-PA-07` `markers.ts:148`); `isLocalFilesystemPath` (`SMELL-PAPP-10` `plugin-delivery.ts:581`); `applyLocatedReplacements` (`SMELL-PB-10`); unused public constants (`SMELL-PB-11`, `SMELL-PC-09`); eval `scoreCase` and guard `pluginCliPath` (`SMELL-PPLUG-08`); Plane A `0.0.0-provisional` vs `0.1.0` (`DEBT-PA-04`).

**Missing `Error.cause` / stringified details (~6).** Strict-walk `SemctxError` puts `cause` as a message string (`ERR-PA-06`); `SemctxError` never `super(message, { cause })` (`ERR-PB-04` `errors.ts:27`); Plane C catch-rethrow drops cause (`ERR-PC-04`); `verify-pr` logs `error.message` only (`ERR-PPLUG-05`). Observer swallows merged as `ASYNC-PAPP-09` (`tool-contract.ts:297`).

**Exhaustiveness / nits (~15).** Marker `if`/`else if` no `never` (`TYPE-PA-03` is P2; P3 sibling `TYPE-PA-06`); `PathKind` two `if`s (`TYPE-PAPP-12`); postfix `!` clusters (`TYPE-PB-08`, `TYPE-PC-08`); worker `onmessageerror` missing (`ASYNC-PA-05`); `assertSameFile` fd leak (`ASYNC-PB-03`); worker path filter weaker than parent (`SEC-PA-06`); fingerprint SHA-256 with no domain separator (`SEC-PC-05` `architecture.ts:42`).

**Hardening leftovers (~8).** Discovery unbounded `readFileSync` (`SEC-PA-05`); working-tree `readFileSync` follows symlinks (`SEC-PAPP-05`); `init --preset` `curl | bash` (`SEC-PAPP-06` `preset.ts:77`); guard `hash-object --path` re-enables filters (`SEC-PPLUG-05` `semctx-guard.mjs:1407`); unnamed pack/slug caps (`DEBT-PAPP-07`, `DEBT-PB-05`); `requires:` silent alias (`DEBT-PB-06`); plugin README still lists `semctx_prepare_task` (`DEBT-PPLUG-05`); unused MCP/CLI workspace deps (`ARCH-PAPP-08` `mcp-server/package.json:19`).

**Tautological tests (~4).** Assembler “exists behind private package” (`TQ-TA-08`); L1–L6 empty closures (`TEST-TB-07`); export `toBeDefined` lists (`TQ-TC-07`); `renderSharedLifecycleContract()` compared to itself (`TEST-TPLUG-07`).

---

## Axial Drift Summary

Wave 1 skipped: no `.importlinter` (`axial-drift/importlinter-report.md`), no ADR with `axial: true` (`axial-drift/axial-adr-review.md`). Inferred primary axis (not an ADR): semantic plane A / B / C.

N×M filed on the non-primary axis (architecture + siblings):

| Sibling axis | Drift | Exemplars |
|--------------|-------|-----------|
| Transports (CLI vs MCP vs `app-services`) | CLI/MCP are not thin over `app-services` for inspect/task/context/semantic; pack and semantic orchestration copied; install reimplements plugin-delivery. | `ARCH-PAPP-01`, `ARCH-PAPP-02`, `ARCH-PAPP-04`, `SMELL-PAPP-01`, `SMELL-PAPP-06` |
| Plugin hosts (Claude vs Codex vs `plugins/shared`) | Guard (Claude-only) forks verification fingerprint; skills not shared; two committed runtimes; dual `.mcp.json` / `mcp-omp.json`; lifecycle evaluator hand-copied. | `ARCH-PPLUG-01`, `ARCH-PPLUG-04`, `ARCH-PPLUG-05`, `ARCH-PPLUG-06`, `DEBT-PPLUG-03` |
| Language analyzers (ts-analyzer vs python-analyzer) | Shared marker grammar copied, not gates; Python emits extract-only (no `FactBatchV1`); discovery/workspace nested-git twins. | `ARCH-PA-02`, `ARCH-PA-03`, `ARCH-PA-04`, `SMELL-PA-05` |
| GH Action vs CLI policy | Action forces `--fail-on none` then reimplements the predicate; exit 1 vs CLI 3; composite runs `apps/cli/src/index.ts` not portable `dist`. | `ARCH-PPLUG-03` |

Layer leaks along the *primary* axis (not N×M, but the missing import-linter would have caught them): B→C (`ARCH-PB-01`), B→App (`ARCH-PB-02`, `ARCH-PB-03`), ranking engine → Plane C DTOs (`ARCH-PAPP-05`), cocoindex ranking parked in Plane A (`ARCH-PA-01`). Plane C itself does not import App/FS/spawn.

---

## Metrics Dashboard

Raw per-domain counts from the report Metrics sections (not re-weighted by dedup). Axial Wave 1 produced no finding table.

| Domain | P0 | P1 | P2 | P3 | Total |
|--------|----|----|----|----|-------|
| Architecture | 0 | 8 | 11 | 3 | 22 |
| Security | 3 | 4 | 15 | 4 | 26 |
| Code smells | 0 | 1 | 69 | 15 | 85 |
| Type safety | 0 | 6 | 25 | 9 | 40 |
| Async patterns | 0 | 7 | 12 | 3 | 22 |
| Error handling | 0 | 12 | 13 | 5 | 30 |
| Test quality | 0 | 22 | 13 | 4 | 39 |
| Tech debt | 0 | 1 | 18 | 11 | 30 |
| Axial drift | — | — | — | — | skipped |
| **Raw total** | **3** | **61** | **176** | **54** | **294** |
| **After dedup (exec)** | **3** | **59** | **171** | **52** | **285** |

Clean partitions: architecture/PC (0), async-patterns/PC (0). Heaviest: code-smells (85), type-safety (40), test-quality (39).

---

## Recommended Actions

Prioritized. Effort S/M/L.

| # | Action | Effort | Why |
|---|--------|--------|-----|
| 1 | Kill bunfig `preload` on MCP + Action: trusted cwd or `bun --config=/dev/null` / absolute `BUN_CONFIG`, never consumer tree as Bun cwd. Flip TEST-TPLUG-01 / TEST-TAPP-02 to red until it holds. | S | P0 RCE (SEC-PPLUG-01, SEC-PPLUG-02) |
| 2 | `listSemFiles`: `lstat`/`O_NOFOLLOW` the walk root (copy `reconciliation-read`). Add TEST-TB-01. | S | P0 vault escape (SEC-PB-01) |
| 3 | Adapter unknown verdict → exit 2; altitude schema: STALE/UNSEALED ⇒ `canRunHighRiskControl === false`; `isStale` on omitted seals. **Do not** `refuseImpact` on `!canRunHighRiskControl` and **do not** invert TEST-TAPP-01 — quote `INDEX_BINDING_ADMISSIBILITY` (`verify.ts:368-397`) and the test at `:472-501`. Optional: surface `unknowns` on CLI exit without flipping that table. | M | ERR-PPLUG-02, ERR-PC-01, ERR-PC-02; ERR-PAPP-01 footnote |
| 4 | Guard stdin: refuse (exit 2) on parse/envelope failure; match lifecycle `normalizeHookEnvelope`. | S | ERR-PPLUG-01 |
| 5 | `writeAtomic`: unique tmp + `O_EXCL`/`O_NOFOLLOW` (migration already has the pattern). Same for `handoff.ts`. | S | SEC-PB-02 / ASYNC-PB-01 |
| 6 | Confine `.semctx` opens: `lstat` + `openReadyRepository` on CLI read/write; no `mkdir` except init. | S | SEC-PAPP-01, ARCH-PAPP-03 |
| 7 | Timeouts: git/`ccc`/host spawn get the plugin-delivery 5s+kill (or a named budget); WAL `busy_timeout`; `withStore` finally. | M | ASYNC-PA-01, ASYNC-PAPP-02/04, ASYNC-PPLUG-01 |
| 8 | Collapse CLI/MCP onto `app-services` use cases (inspect/prepare/semantic/init). Delete leftover transport workspace deps. | L | ARCH-PAPP-01/02/04, SMELL-PAPP-06 |
| 9 | One Node-portable `captureVerificationGitState`; generate guard/lifecycle evaluators from `control-model`. | M | ARCH-PPLUG-01, ARCH-PPLUG-05 |
| 10 | Zod (or existing schemas) at store/handoff/adapter/cocoindex JSON boundaries; `ccc search -- json --limit -- query`. | M | TYPE-PAPP-01, TYPE-PB-01, SEC-PA-01, ERR-PPLUG-02 |
| 11 | Producer-failure path: unreadable file / parse error → sidecar `failed` → `evaluatePlaneA` `PRODUCER_FAILED`, never PASS. | M | ERR-PA-01/02/03, TQ-TA-01/02 |
| 12 | Lockstep Action/preset/README to CLI version; drop ADR 0005 retriever from shipped catalogue (`prepare_task`, `semanticProvider`, eval pack scorer). | M | DEBT-PPLUG-01, DEBT-PAPP-01/02/04, DEBT-PB-03/04 |
| 13 | Split god files along existing seams (delivery, reconciliation, install, envelope schemas, guard, prove-stable). Do not start here. | L | SMELL-PAPP-02/03/04, SMELL-PC-01, SMELL-PPLUG-01/04 |

---

## Technical Debt Score

Scale 0–100 (100 = pristine). Weights used for this run: P0 −12, P1 −4, P2 −1, P3 −0.25. Floor 0. Deduped totals:

```
100 − (3 × 12) − (59 × 4) − (171 × 1) − (52 × 0.25)
  = 100 − 36 − 236 − 171 − 13
  = 100 − 456
  = −356  →  floor 0
```

**Score: 0** (floor). The formula saturates at ~20 P1s; P1 volume (including missing tests) is what zeros it, not the three P0s. No second scale.

---

## Top 10 Quick Wins

High impact, low effort. Each is a local edit plus a negative test.

| # | Win | Where |
|---|-----|-------|
| 1 | Launch MCP with a trusted cwd / `bun --config=/dev/null` (not `cwd: "."`) | `plugins/claude-code/mcp-omp.json:6` (and `plugins/semctx-control/.mcp.json:6`, Claude `.mcp.json`) |
| 2 | Run Action `bun` from `github.action_path`, not consumer `working-directory` | `packages/github-action/action.yml:84` |
| 3 | `lstat` the `listSemFiles` walk root; refuse directory symlinks | `packages/semantic-engine/src/store.ts:24` |
| 4 | Unique tmp + nofollow `writeAtomic` | `packages/semantic-engine/src/store.ts:99` |
| 5 | Guard: `process.exit(2)` on stdin parse/envelope failure | `plugins/claude-code/hooks/semctx-guard.mjs:1611` |
| 6 | CLI: unknowns already recorded at `verify.ts:488` do not change `exitCode` — surface them without flipping `INDEX_BINDING_ADMISSIBILITY` | `apps/cli/src/commands/verify.ts:62` |
| 7 | Adapter: missing/unknown `verdict` or `fail-on` → exit 2; Zod-parse report | `packages/github-action/src/adapter.mjs:80` |
| 8 | `ccc search --json --limit N -- query` (terminator before user token) | `packages/cocoindex-adapter/src/cocoindex-provider.ts:46` |
| 9 | Bump Action README + `package.json` pin to CLI `0.1.20` | `packages/github-action/README.md:29` |
| 10 | `PRAGMA busy_timeout` on WAL writers | `packages/repository-store/src/store.ts:184` |

---

## Validation (2026-09-09, before share)

**Scope of this pass:** every ID in **Critical (P0)** and **High Priority (P1)** — 3 + 59 rows. Each primary `path:line` was opened in product/test source. **171 P2s were not re-read.** This is not a validation of the whole audit.

Dashboard vs each domain report’s Metrics line (all 45 files parsed):

| Domain | Metrics sum | Dashboard |
|--------|-------------|-----------|
| architecture | 0/8/11/3 = 22 | same |
| security | 3/4/15/4 = 26 | same |
| code-smells | 0/1/69/15 = 85 | same |
| type-safety | 0/6/25/9 = 40 | same |
| async-patterns | 0/7/12/3 = 22 | same |
| error-handling | 0/12/13/5 = 30 | same |
| test-quality | 0/22/13/4 = 39 | same |
| tech-debt | 0/1/18/11 = 30 | same |
| **raw total** | **3/61/176/54 = 294** | **same** |

P0/P1 source open (62 rows; secondary backticks resolved to full paths):

| Result | IDs |
|--------|-----|
| File:line exists and snippet matches the claim | All 3 P0s; 58/59 P1s |
| OVERSTATED | TYPE-PA-01 — parse at `:61`, `as` at `:67`, `toCandidate` filters |
| Designed, not a missing BLOCK | ERR-PAPP-01 (`:488` if / `:490` `withUnknown`); TEST-TAPP-01 pins `INDEX_BINDING_ADMISSIBILITY` |
| Secondary cite line | SMELL-PAPP-01 strip is `plugin-delivery.ts:565` (not `:571`); `isSemctxSource` call is `:571` |
| ±1–2 line | ERR-PAPP-02 empty bytes `:243`; TEST-TAPP-04 `Array.from({length:1000})` is `:677` |

Share the P0s. Do not claim P2 clusters or the rest of the 294 were source-checked.
