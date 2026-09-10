# Quality Audit Strategy — semctx

Date: 2026-09-09
Repo: `/home/mickael/projects/external_repos/semctx`
Playbook: `roxabi-plugins/playbooks/multi-agent-audit-playbook.md` v1.1
Inventory: 228 source + 142 test (excl. `dist/`, `node_modules/`, `typescript-lib/`)

## Product

Deterministic local-first change-impact analyzer. `verify diff` → PASS/WARN/BLOCK. Not a code-search retriever (ADR 0005). Runtime: Bun + TypeScript workspaces.

Planes (from `docs/architecture/overview.md`):

| Plane | Packages |
|-------|----------|
| A | `ts-analyzer`, `python-analyzer`, `plane-a-internal`, `workspace-analyzer-internal`, `cocoindex-adapter` |
| B | `semantic-model`, `semantic-dsl`, `semantic-engine` (+ `core` domain/ids/errors/Zod) |
| C | `control-model`, `control-engine`, `change-authorization-verifier` |
| App | `app-services`, `apps/cli`, `mcp-server`, `context-engine`, `repository-store` |
| Plug | `plugins/` (excl. dist), `scripts/`, `github-action`, `eval`, `test-fixtures` |

App grouping matches overview: CLI/MCP are transports over `app-services`; `app-services` owns Git/store lifetimes; `context-engine` is pack/verify assembly consumed there.

## Hard boundaries

- `ts-analyzer` parses; never persists; never ranks.
- `repository-store` persists SQLite; never parses; never ranks.
- `context-engine` ranks; never touches filesystem AST.
- CLI / MCP are thin transports over `app-services`; engines stay graph-in.
- Plane C reads A+B; never mutates; no executor.
- `core` depends on Zod only.

`package.json` suspects (confirm in code):

- `mcp-server` depends on `ts-analyzer`, `repository-store`, engines — not only `app-services`.
- `semantic-engine` depends on `repository-store` + `context-engine`.
- `context-engine` depends on `control-model`.
- `apps/cli` lists product packages as `devDependencies`.

## Domains

| Domain | Focus |
|--------|-------|
| Architecture | Layer violations, circular deps, coupling vs hard boundaries |
| Axial Drift | skipped as Wave 1 — no `.importlinter`, no `axial: true` ADR |
| Security | Path traversal, git/spawn injection, SQL, MCP input, secrets, hook bypass |
| Code Smells | God files, long functions, DRY, dead code |
| Type Safety | `any`, casts, ts-ignore, missing exhaustiveness |
| Async Patterns | missing await, SQLite/index-worker races, leaked handles |
| Error Handling | empty catch, swallowed errors, fail-open vs fail-closed |
| Test Quality | tautology, mock-only, missing fail-closed cases |
| Tech Debt | TODO/FIXME, deprecated APIs, experimental retriever leftovers |

## Partitions

### Source (5 — one per plane)

| ID | Globs (skip `**/test/**`, `**/*.test.ts`) | Role |
|----|-------------------------------------------|------|
| PA | `packages/ts-analyzer/**`, `packages/python-analyzer/src/**`, `packages/plane-a-internal/**`, `packages/workspace-analyzer-internal/**`, `packages/cocoindex-adapter/**` | Plane A analyzers |
| PB | `packages/core/**`, `packages/semantic-model/**`, `packages/semantic-dsl/**`, `packages/semantic-engine/**` | Plane B + core |
| PC | `packages/control-model/**`, `packages/control-engine/**`, `packages/change-authorization-verifier/**` | Plane C |
| PApp | `packages/app-services/**`, `apps/cli/**`, `packages/mcp-server/**`, `packages/context-engine/**`, `packages/repository-store/**` | Use cases + transports + store |
| PPlug | `plugins/**`, `scripts/**`, `packages/github-action/**`, `packages/eval/**`, `packages/test-fixtures/**` | Plugins + tooling |

### Tests (5 — same planes)

| ID | Test globs under the same packages as PA–PPlug |
|----|------------------------------------------------|
| TA | Plane A package tests (excl. `python-analyzer/test/corpus`) |
| TB | `core`, `semantic-model`, `semantic-dsl`, `semantic-engine` tests |
| TC | `control-model`, `control-engine`, `change-authorization-verifier` tests |
| TApp | `app-services`, `apps/cli`, `mcp-server`, `context-engine`, `repository-store` tests |
| TPlug | `plugins`, `scripts`, `github-action`, `eval`, `test-fixtures` tests |

## Exclude

`**/dist/**`, `**/node_modules/**`, `**/typescript-lib/**`, `.semctx/`, `.cocoindex_code/`, `packages/python-analyzer/test/corpus/**`.

## Execution

Wave size 5 (playbook 5-by-5). Wave 1 axial = N/A.

| Wave | Agents |
|------|--------|
| 1 | Axial — **skipped** (no importlinter, no `axial: true`) |
| 2 | Architecture × PA–PPlug |
| 3 | Security × PA–PPlug |
| 4 | Code smells × PA–PPlug |
| 5 | Code smells × TA–TPlug |
| 6 | Type safety × PA–PPlug |
| 7 | Async × PA–PPlug |
| 8 | Error handling × PA–PPlug |
| 9 | Test quality × TA–TPlug |
| 10 | Tech debt × PA–PPlug |
| 11 | Orchestrator `ccc` confirmation + synthesis |

Primary axis (inferred, not an ADR): semantic plane A/B/C. N×M siblings: language analyzers; CLI vs MCP; plugin hosts (claude-code vs semctx-control) besides `plugins/shared`.

## Output

`artifacts/analyses/quality-audit/{domain}/{id}.md` then `AUDIT-SUMMARY.md`.
