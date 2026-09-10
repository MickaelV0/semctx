# Tech Debt — PPlug

## Summary
Reviewed plugin hosts (`plugins/claude-code`, `plugins/semctx-control`, `plugins/shared`), `scripts/`, `packages/github-action`, `packages/eval`, and `packages/test-fixtures` (authored source only; skipped tests, `dist/`, `typescript-lib`, corpus). Authored PPlug has **zero** `TODO`/`FIXME`/`HACK`/`XXX` and no deprecated-API use; plugin / CLI / MCP versions are lockstep at `0.1.20`. Health is mixed because the partition still ships generated runtimes in git, keeps two Claude plugin manifests, and retains the ADR 0005 ContextPack bench. Worst issue: the GitHub Action docs pin `@v0.1.18` while the product is `v0.1.20` and the action package.json is frozen at `0.1.0`. Not re-filed: two host `dist/` copies (architecture), god files, or security.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| DEBT-PPLUG-01 | P1 | packages/github-action/README.md:29 | Action version SSOT is split three ways. README copy-paste pin is `@v0.1.18` (tags exist through `v0.1.20`); `packages/github-action/package.json` stays `0.1.0`; plugin/CLI/MCP are `0.1.20`. Consumers following the Action README install a two-tag-old composite. | `- uses: hoklims/semctx/packages/github-action@v0.1.18` | One pin = `apps/cli` version. Bump README + `package.json` on every tag; fail `plugin-parity` (or `compatibility:check`) if the Action pin ≠ CLI version. | 95 |
| DEBT-PPLUG-02 | P2 | scripts/build-plugin-runtime.ts:666 | Generated plugin runtime is committed: each host `dist/` is ~12 MB (4 JS bundles + 100 `typescript-lib/*.d.ts`). `plugin:check` catches staleness but every TypeScript bump rewrites ~200 git paths. (Two-copy layout is ARCH-PPLUG-04 — not re-filed.) | `rmSync(dist, { recursive: true, force: true });` | Keep one portable artifact (npm tarball / single runtime dir) produced in CI; gitignore host `dist/` + `typescript-lib`; `plugin:check` against that payload. | 92 |
| DEBT-PPLUG-03 | P2 | plugins/claude-code/.omp-plugin/plugin.json:14 | Dual Claude manifests on one tree: `.claude-plugin/plugin.json` (no `mcpServers`) vs `.omp-plugin/plugin.json` (`mcpServers: ./mcp-omp.json`) plus twin launch files `.mcp.json` / `mcp-omp.json`. Versions match today only because tests assert lockstep. OMP is still labeled experimental and excluded from the `deliver` proof (HOK-456). | `"mcpServers": "./mcp-omp.json"` | Generate the OMP manifest + `mcp-omp.json` from the Claude source (or one template + host overlay). Fold OMP into the same delivery proof as Claude/Codex or drop the second surface. | 90 |
| DEBT-PPLUG-04 | P2 | packages/eval/src/spec.ts:1 | `@semantic-context/eval` is still a ContextPack retriever scorer (`prepareContextPack` × golden reads/tests). ADR 0005 rejected `task → ContextPack` as a primary retriever and demoted `context prepare` to experimental; this package (version `0.1.0`, unused `app-services` devDep) keeps the old quality gate in the Plug plane. Fixture slugs `EXPECTED.deprecatedDoc` / `decoyModule` exist for that pack, not for `verify diff`. | `/** Golden-expectation spec for measuring ContextPack effectiveness. */` | Move the pack bench to research / `benchmarks/change-impact-eval`, or delete the package once CLI `bench` is gone. Do not treat pack R@k as a product gate. | 88 |
| DEBT-PPLUG-05 | P3 | plugins/claude-code/README.md:10 | Plugin “What it installs” still lists experimental `semctx_prepare_task` as a first-class MCP bullet. Skills never mention it; ADR 0005 says the pack must not be presented as code search — the README hedges but still advertises the rejected retriever on the host surface. | `` `semctx_verify_change`, `semctx_inspect`, and the experimental `semctx_prepare_task` (not a `` | Drop the tool from the install list (keep a one-line “experimental / not shipped as search” note in docs if the MCP method must remain). | 82 |
| DEBT-PPLUG-06 | P3 | scripts/semantic-stress-test.sh:1 | Manual semantic-layer e2e (`semantic-stress-test.sh` + `.ps1` wrapper) is not in `package.json` scripts and not in CI. Root scripts wire `verify:pr`, `plugin:build`, `cli:build`, `bench:index-workers`, `compatibility:*` — not this. It can rot against CLI exit codes (script still asserts BLOCKED exit 3). | `#!/usr/bin/env bash` | Add `bun run stress:semantic` and a CI job, or delete and keep `docs/examples/semantic-layer-reservation-example.md` as the walkthrough. | 86 |

## Metrics
- Files read: 38
- Findings: 6 (P0: 0 / P1: 1 / P2: 3 / P3: 2)
- TODO/FIXME/HACK/XXX (authored PPlug, excl. `dist/` / `typescript-lib` / tests): **0**
- Deprecated symbols in authored PPlug: **0** (`@deprecated` hits are generated `typescript-lib` / bundled CLI help, skipped)
- Commented-out code blocks: **0**
- Version lockstep plugin / CLI / MCP: **aligned `0.1.20`** (`plugins/claude-code/.claude-plugin/plugin.json`, `.omp-plugin/plugin.json`, `plugins/semctx-control/.codex-plugin/plugin.json`, `apps/cli/package.json`, `packages/mcp-server/package.json`)
- Version drift in-partition: GitHub Action `package.json` `0.1.0` + README `@v0.1.18` vs current tag `v0.1.20`; private `eval` / `test-fixtures` remain `0.1.0`
- Generated git payload: 104 tracked files per host `dist/` (4 JS + 100 `lib*.d.ts`); ~12 MB × 2
- Script leftovers: `semantic-stress-test.{sh,ps1}` unwired; `packages/eval` is the ADR 0005 leftover package

## Recommendations
1. Make the GitHub Action pin a release SSOT field equal to `apps/cli` `version`; fail CI when README / `package.json` disagree.
2. Stop committing host `dist/` and `typescript-lib`; one CI-built runtime, `plugin:check` against that digest.
3. Collapse Claude `.claude-plugin` / `.omp-plugin` / `.mcp.json` / `mcp-omp.json` to one generated pair; either prove OMP in `deliver` or unship it.
4. Remove or relocate `@semantic-context/eval` (ContextPack golden scorer) so Plug tooling is not a retriever bench after ADR 0005.
5. Wire or delete `scripts/semantic-stress-test.sh`; do not leave CLI-exit e2e as an undocumented manual path.
