# Architecture — PApp

## Summary
Reviewed App-plane source (skipping tests): `app-services`, `apps/cli`, `mcp-server`, `context-engine`, `repository-store`. Hard-boundary health is mixed: `repository-store` stays persistence-only (core + SQLite; no AST, no ranking), and `context-engine` ranks on graph/diff text without `node:fs` or the TypeScript compiler. The worst issue is that CLI and MCP are not thin transports over `app-services` — they open the store, call engines, and re-orchestrate inspect/task/pack themselves. `app-services` is also a god package (~12.1k loc, 27 files) composing Plane A runtimes, plugin delivery, and reconciliation.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ARCH-PAPP-01 | P1 | packages/mcp-server/src/tools.ts:16 | MCP is not a thin transport: `semctx_prepare_task` / `semctx_inspect` load the store and call `context-engine` directly. `verifyChangeTool` correctly uses `runVerify`. | `from "@semantic-context/context-engine"` | Move prepare/inspect (and pack+seal retry) into `app-services`; MCP tools become one-liners like `control-tools.ts`. Drop runtime deps on store/engines. | 95 |
| ARCH-PAPP-02 | P1 | apps/cli/src/commands/inspect.ts:3 | CLI bypasses `app-services` for inspect/task/context/semantic/init/migrate: opens SQLite and calls engines. Contrast: `index`, `verify`, `control`, `status` already go through app-services. | `import { inspectGraph, type InspectKind } from "@semantic-context/context-engine"` | Same use-case APIs as ARCH-PAPP-01; CLI commands only parse args and render. `init` should call `setupRepository` (or a dedicated init use case), not `initWorkspace`. | 95 |
| ARCH-PAPP-03 | P1 | packages/repository-store/src/workspace.ts:81 | CLI `openStore()` mkdir's `.semctx/` and opens SQLite, skipping `openReadyRepository` (`CONFIG_NOT_FOUND` / `REPO_NOT_INDEXED`). `task create` only warns if the graph is empty. MCP inspect uses `ensureReady`. | `mkdirSync(semctxDir(root), { recursive: true });` | CLI read/write paths must use `openReadyRepository` / `openReadyRepositoryWriter`. Keep mkdir only inside init/setup. | 90 |
| ARCH-PAPP-04 | P2 | packages/mcp-server/src/tools.ts:52 | CLI `context.ts` and MCP `prepareTaskTool` duplicate provider-seal + `prepareContextPack` + retry; CLI `loadFacts` / MCP `facts()` duplicate graph+claims+evidence loads. Drift risk on the experimental pack path (ADR 0005). | `const providerCandidates = await fetchProviderCandidates(` | One `prepareTask` / `inspectRepository` / `loadRepositoryFacts` in `app-services`; both transports call it. | 90 |
| ARCH-PAPP-05 | P2 | packages/context-engine/src/observed-diff.ts:4 | Ranking engine depends on Plane C `control-model` for hunk construction (`verify-diff.ts` also imports `normalizeObservedDiffPath`). Violates “engines remain graph-in” relative to Plane C; couples pack/verify to control DTOs. | `} from "@semantic-context/control-model/reconciliation"` | Keep hunk parsing graph-in (`core` or a tiny shared DTO); `app-services` maps to Plane C types. | 85 |
| ARCH-PAPP-06 | P2 | packages/app-services/src/plugin-delivery.ts:52 | `app-services` is a god package: 27 src files, ~12.1k loc. Largest: `plugin-delivery.ts` 2093, `reconciliation-index.ts` 2039, `plane-a-runtime.ts` 918, `index-health.ts` 987. Depends on ts-analyzer, python-analyzer, plane-a-internal, workspace-analyzer-internal, both engines, both models. Composition root is expected; this surface is not. | `export const PLUGIN_DELIVERY_SCHEMA_VERSION = 2;` | Split plugin-delivery, Plane A runtime, and reconciliation into dedicated packages; `app-services` stays Git/store lifetime + use-case façade. | 90 |
| ARCH-PAPP-07 | P2 | apps/cli/src/commands/install.ts:2 | `install.ts` (1522 loc) is a second plugin-host implementation. `plugin-status.ts` already calls `pluginDeliveryStatus`; install only imports `isHostInterfaceUnsupportedFailure` and reimplements host queries. | `import { isHostInterfaceUnsupportedFailure } from "@semantic-context/app-services"` | Move install mutations behind an app-services use case (or share `plugin-delivery` probes); CLI stays argv + UX. | 85 |
| ARCH-PAPP-08 | P3 | packages/mcp-server/package.json:19 | Declared coupling not used in `src/`: MCP lists `ts-analyzer`, `semantic-dsl`, `control-engine`. CLI lists `ts-analyzer`, `cocoindex-adapter`, `control-engine` as devDependencies with no `src/` import. Confirms the STRATEGY package.json suspect as both real bypass (used store/engines) and leftover deps. | `"@semantic-context/ts-analyzer": "workspace:*"` | Delete unused workspace deps. Transports depend on `app-services` + `core`; schema-only DTO imports (control-model / semantic-model) if JSON-schema binding cannot be re-exported. | 90 |

## Metrics
- Files read: 40 (partition `src/` + 5 `package.json`; tests skipped)
- Findings: 8 (P0 0 / P1 3 / P2 4 / P3 1)
- Partition LOC (src only): app-services 12116; mcp-server 4496; context-engine 2949; repository-store 676; apps/cli 4616
- `repository-store` parse/rank: none (JSON row decode + config Zod only; `ORDER BY id` / `created_at`)
- `context-engine` FS AST: none (`node:fs` / `typescript` absent; git log spawn lives in `app-services` `verify.ts:234`)
- Runtime cycles in this plane: none (`context-engine` → `app-services` is test-only devDependency)

### Cross-layer imports (hard-boundary crossings, `src/` only)

**MCP → engines/store (bypass):**
- `packages/mcp-server/src/tools.ts:3` `@semantic-context/repository-store` (`loadConfig`)
- `packages/mcp-server/src/tools.ts:16` `@semantic-context/context-engine` (`inspectGraph`, `prepareContextPack`, …)
- `packages/mcp-server/src/setup-tools.ts:4` `@semantic-context/repository-store` (`isInitialized`, `loadConfig`)
- `packages/mcp-server/src/semantic-tools.ts:22` `@semantic-context/semantic-engine` (`sliceSemanticModel`, `inspectSemantic`, handoff, …)
- `packages/mcp-server/src/tool-output-schemas.ts:48` `@semantic-context/semantic-engine` (`TargetArchitectureArtifactV1Schema`)

**CLI → engines/store (bypass):**
- `apps/cli/src/commands/inspect.ts:2-3` store + `inspectGraph`
- `apps/cli/src/commands/task.ts:5-6` store + `defaultTaskExtractor`
- `apps/cli/src/commands/context.ts:6-7` store + `prepareContextPack`
- `apps/cli/src/commands/semantic.ts:3,18` store + `semantic-engine`
- `apps/cli/src/commands/init.ts:4-5` `initWorkspace` / `openStore` + `ensureSemanticGitignore`
- `apps/cli/src/commands/migrate.ts:15,22` store + `migrateAnchors`
- `apps/cli/src/commands/change.ts:3` `loadModelWithWorking`
- `apps/cli/src/commands/preset.ts:4-5` `toDiskConfig` + `ensureSemanticGitignore`
- `apps/cli/src/commands/setup.ts:9` `isInitialized` / `loadConfig` (setup mutation itself uses `setupRepository`)
- `apps/cli/src/commands/bench.ts:4-5` `openStore` + `@semantic-context/eval`

**MCP/CLI thin (allowed contrast):**
- `packages/mcp-server/src/control-tools.ts:27` `@semantic-context/app-services` only (plus control-model types)
- `apps/cli/src/commands/index-cmd.ts:2` `indexRepository`
- `apps/cli/src/commands/verify.ts:13` `planVerify` / `runVerify`
- `apps/cli/src/commands/status.ts:1` `controlStatus`

**Ranking → Plane C:**
- `packages/context-engine/src/observed-diff.ts:4` `control-model/reconciliation`
- `packages/context-engine/src/verify-diff.ts:2` `normalizeObservedDiffPath`

**Declared but unused in `src/`:**
- MCP `package.json:19,21,24` `ts-analyzer`, `semantic-dsl`, `control-engine`
- CLI `package.json:39,42,47` `ts-analyzer`, `cocoindex-adapter`, `control-engine`

**Intended composition (not a transport bypass):** `app-services` → `ts-analyzer` (`indexing.ts:14`, `control.ts:31`, `reconciliation-index.ts:85`, `plane-a-runtime.ts:56`), `python-analyzer` (`plane-a-runtime.ts:42`), `context-engine`, `semantic-engine`, `repository-store`. Offline `change-authorization-verifier` called from both transports is host-independent by design (no Git/store).

## Recommendations
1. Promote inspect / task-extract / context-pack / repository-facts to `app-services` and delete the duplicated orchestration in `mcp-server/src/tools.ts` and `apps/cli/src/commands/{inspect,task,context,semantic}.ts`.
2. Make `openReadyRepository*` the only non-init store entry; stop CLI from calling `openStore` (side-door `mkdirSync`).
3. Shrink transport `package.json` to `app-services` + `core` (+ schema DTOs if MCP JSON Schema cannot be re-exported). Remove unused `ts-analyzer` / `control-engine` / `semantic-dsl` / `cocoindex-adapter`.
4. Split `plugin-delivery`, Plane A runtime, and reconciliation out of `app-services`; fold `install.ts` into the delivery use case so CLI/MCP stay renderers.
5. Decouple `context-engine` from `control-model` so ranking stays graph-in; keep Plane C mapping in `app-services`.
