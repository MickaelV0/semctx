# Biome and domain invariants

This repository uses **Biome** for lightweight static lint (not full formatting rewrites)
and a small **`scripts/check-invariants.ts`** for ADR / review lessons Biome cannot express.

## Commands

```bash
bun run lint              # biome lint (packages, apps, scripts, plugins ts)
bun run lint:invariants   # domain/ADR grep-style checks
bun run lint:all          # both
```

Formatter is **disabled** in `biome.json` on purpose: enabling it would reformat the whole
monorepo (tabs/spaces). Revisit later with an explicit style migration if desired.

## What maps where

### Reviews + ADRs → automation

| Lesson / rule | Source | Enforced by |
|---------------|--------|-------------|
| Empty block / empty `catch { }` (confusing swallow) | Biome docs + review fail-open catch | Biome `suspicious/noEmptyBlockStatements` (**error**). Comment-only catch is allowed. |
| Fail-open empty catch on public paths | PR #73 (preflight `catch` masking `CONFIG_INVALID`) | `check-invariants` empty-catch scan + unit/MCP tests on setup |
| No `Math.random` in package pipeline | CONTRIBUTING determinism | `check-invariants` on `packages/**` (non-test) |
| No `eval` / dangerous HTML | general security | Biome `security/noGlobalEval`, `noDangerouslySetInnerHtml` |
| Handler must not publish free-form `isError` body | ADR 0012 | Runtime `ToolRegistrar` + `mcp-2026-contract` tests (not Biome) |
| Domain refuse = structured body / agent reads `verdict` | ADR 0012 option A + #74 | Skill + schema + tests (not Biome) |
| `SETUP_READY` fail-closed vs insufficient coverage | PR #73 | `setupRepository` + schema superRefine + tests |
| Polyglot description / `reasonCode` string drift | PR #73 re-review | SSOT constants + metadata test; `check-invariants` drift heuristic when SSOT present |
| Plane A/B/C vs risk tiers naming | PR #74 | Docs only (`PUBLIC_CONTRACT` …) — not lintable without NLP |
| Confirm gate / root pin | ADR 0012 | Code + tests |

### Explicitly **not** Biome’s job

- Semantic “agent success gate” consistency (`verdict` ↔ health fields) — **Zod superRefine + tests**
- Catalogue error catalogue completeness — **tests**
- Plugin bundle parity / dist — **`plugin:check`**
- Deterministic sorting of every collection — **tests / bench**

## Recommended Biome rules (enabled)

| Rule | Level | Why |
|------|-------|-----|
| `recommended` preset | base | Sensible defaults |
| `noEmptyBlockStatements` | **error** | Empty catch/block almost always incomplete refactor or fail-open |
| `noGlobalEval` / `noDangerouslySetInnerHtml` | **error** | Security baseline |
| unused imports/vars | warn | Hygiene without blocking CI until cleaned |
| `noForEach` / cognitive complexity / `noExplicitAny` | **off** | Too noisy for current codebase |

Overrides: tests relax empty-block to warn; `plugins/**/dist`, `corpus`, `typescript-lib` ignored.

## Extending

1. Prefer a **test that would fail** if the public contract regresses (hoklims-style probes).
2. Add a **SSOT constant** for agent-facing strings; point descriptions/schema at it.
3. Only then add a Biome rule or a line in `check-invariants.ts` if the failure mode is mechanical.

## CI

Wire `bun run lint:all` next to `typecheck` when the team is ready (start non-blocking if residual warns remain).
