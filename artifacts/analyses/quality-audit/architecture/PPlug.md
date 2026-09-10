# Architecture — PPlug

## Summary
Reviewed plugin hosts (`plugins/claude-code`, `plugins/semctx-control`, `plugins/shared`), `scripts/`, `packages/github-action`, `packages/eval`, and `packages/test-fixtures` (source only; skipped tests, `dist/`, `typescript-lib`). Health is mixed: lifecycle hooks and control skills are generated from one shared source with `plugin:check` byte-identity, and the GitHub Action adapter correctly stays off `bun:sqlite`. Worst issues are a second fail-closed Git fingerprint in the Claude guard (twin of `app-services` verification-state) and a Plug benchmark importing private Plane A plus the store instead of staying on `app-services`.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ARCH-PPLUG-01 | P1 | plugins/claude-code/hooks/semctx-guard.mjs:1561 | Claude guard reimplements `captureVerificationGitState` instead of sharing one Node-portable module with `app-services`. Same domain strings, already forked (`hiddenTrackedPaths` only on the service). Drift can false-allow or false-block guarded commit/push. Lifecycle already solved this class with a generated contract; the guard did not. | `/** Capture the same commit, content bytes, paths and modes recorded by \`semctx verify diff --record\`. */` | Extract one Node-compatible fingerprint module under `plugins/shared` (or generate it from `packages/app-services/src/verification-state.ts`) and have both the CLI recorder and the guard import it. | 92 |
| ARCH-PPLUG-02 | P1 | scripts/benchmark-multicore-index.ts:6 | Plug script reaches into private Plane A (`digestCanonical`) and `repository-store.initWorkspace` while also calling `indexRepositoryAsync`. `plane-a-internal` is not a public adapter; seal identity is already on the app-services result. | `import { digestCanonical } from "@semantic-context/plane-a-internal";` | Drop the Plane A import; compare `indexed.freshnessSeal.sealHash` (already captured at line 37). Init the fixture through the same path CLI/`app-services` own, not the store API. | 88 |
| ARCH-PPLUG-03 | P2 | packages/github-action/src/adapter.mjs:67 | GitHub Action is not a thin CLI wrapper for policy: `action.yml` forces `--fail-on none` and the Node adapter reimplements the CLI fail-on predicate plus `::error`/`::warning` rendering (`apps/cli/src/commands/verify.ts` `exitCode`/`renderGithub`). Exit contracts already differ (adapter `1` vs CLI `3`). Composite still runs `apps/cli/src/index.ts`, not the portable `dist` the plugins/npm CLI ship. | `exitCode: shouldFail ? 1 : 0` | Share one fail-on + GitHub-annotation helper; point the composite at the portable CLI bundle (`scripts/build-cli-package.ts`) instead of TS source; keep GitHub summary/outputs in the adapter only. | 86 |
| ARCH-PPLUG-04 | P2 | scripts/build-plugin-runtime.ts:23 | Two host trees each commit a full CLI+MCP+index-worker+`typescript-lib` runtime. Build writes the same bytes twice (`pluginDists` loop). Hosts should differ by manifest/hooks/skills, not by a second copy of the product. | `resolve(root, "plugins/claude-code/dist"),` | One runtime artifact directory (or npm tarball) referenced by both hosts; keep `plugin:check` digest equality against that single payload. | 90 |
| ARCH-PPLUG-05 | P2 | plugins/shared/hooks/semctx-lifecycle.mjs:362 | Shadow hook is a second Plane C `before_completion` evaluator (`evaluateBeforeCompletion` + `computeReportHash`) beside `evaluateAgentLifecycleCheckpointV1`. Contract JSON is generated from `control-model`; the decision procedure is still hand-copied. | `export function evaluateBeforeCompletion(contract, { repositoryState, recordedStageIds }) {` | Generate the evaluator from `control-model` (or bundle a tiny read-only evaluator) so the hook cannot drift from `expectedDecision`. | 84 |
| ARCH-PPLUG-06 | P2 | plugins/claude-code/skills/semctx-verify/SKILL.md:1 | Host skill surface is not shared: Claude ships `semctx-verify` + `semctx-semantic` + generated `semctx-control`; Codex (`plugins/semctx-control/skills`) ships only `semctx-control`. CLI ladders and Plane A/B loops are restated in Claude-only skills instead of host-neutral templates plus a ladder stub. | `name: semctx-verify` | Move verify/semantic skills into `plugins/shared/skills` with the same host-ladder marker used for control; Codex either gets the rendered copies or an explicit “Claude-only” contract. | 82 |
| ARCH-PPLUG-07 | P3 | scripts/build-plugin-runtime.ts:228 | Codex skill text says bundled `dist/semctx.js` is not addressable, yet `PLUGIN_RUNTIME_BUNDLES` still ships `semctx.js` on that host. Dead coupling between delivery proof and usable CLI path. | `so the bundled \`dist/semctx.js\` is not addressable via a relative path` | Either teach Codex a stable absolute CLI path, or stop advertising/shipping a shell CLI on that host and prove MCP-only delivery. | 78 |

## Metrics
- Files read: 36
- Findings: 7 (P0: 0 / P1: 2 / P2: 4 / P3: 1)
- Cross-layer imports (Plug source → other planes), `path:line`:
  - `scripts/benchmark-multicore-index.ts:4` → `core` (OK)
  - `scripts/benchmark-multicore-index.ts:5` → `app-services` (OK)
  - `scripts/benchmark-multicore-index.ts:6` → `plane-a-internal` (violation; ARCH-PPLUG-02)
  - `scripts/benchmark-multicore-index.ts:7` → `repository-store` (store bypass; ARCH-PPLUG-02)
  - `scripts/build-plugin-runtime.ts:20` → `control-model` (generate hook contract; OK)
  - `scripts/build-plugin-runtime.ts:521` virtual MCP entry → `packages/mcp-server/src/index.ts` (bundle; OK)
  - `scripts/build-plugin-runtime.ts:522` virtual CLI entry → `apps/cli/src/index.ts` (bundle; OK)
  - `scripts/prove-stable-delivery.ts:43` → `app-services` (`PLUGIN_RUNTIME_BUNDLES`; OK)
  - `packages/eval/src/run.ts:1` → `context-engine` (`prepareContextPack`; graph-in bench, not a Git/store lifetime)
  - `packages/eval/src/run.ts:2` / `scorer.ts:1` / `spec.ts:2` → `core` (OK)
  - `packages/test-fixtures/src/index.ts:3` → `core` (OK)
  - Plugin hooks and `packages/github-action/src/adapter.mjs`: no `@semantic-context/*` imports (plain Node)
- Coupling notes: lifecycle.mjs is byte-identical across shared/claude/codex (`plugin:check`). Guard exists only on Claude. `scripts/verify-pr.ts` does **not** reimplement product `verify diff` (repo hygiene only). `packages/eval` calling `prepareContextPack` is graph-in and aligned with “engines stay graph-in”; unused `app-services` on eval’s `devDependencies` is unused at runtime.

## Recommendations
1. Treat out-of-process hooks like the lifecycle path: one generated/shared body, no hand-copied fail-closed algorithms (guard fingerprint first).
2. Collapse CLI packaging to one portable bundle consumed by plugins, npm, and the GitHub Action; keep the Action adapter for summary/outputs only.
3. Forbid Plug/`scripts` imports of `plane-a-internal` and `repository-store` except through `app-services`.
4. Stop committing two plugin `dist/` trees; hosts should be manifests + hooks + skills over one runtime.
5. Generate Codex/Claude skill surfaces from `plugins/shared` so Plane A/B workflows cannot exist on only one host by accident.
