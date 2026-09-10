# Agent prompts — semctx quality audit

Read `artifacts/analyses/quality-audit/STRATEGY.md` before analyzing.

You write **exactly one** markdown file (path in your task). Do not edit product source. Do not spawn agents. Do not run formatters, linters, or the full test suite. Skip excluded paths in STRATEGY.

## Shared output format

```markdown
# {Domain} — {Partition}

## Summary
{2–5 sentences. What you looked at. Health. Worst issue.}

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| {DOM}-{PART}-01 | P1 | packages/foo/src/bar.ts:12 | … | … | … | 85 |

## Metrics
- Files read: N
- Findings: N (P0/P1/P2/P3)
- {domain-specific metric}

## Recommendations
1. …
```

Rules:

- No finding without `path:line`. If clean, keep the table header and write `_None._`
- Sev: P0 vuln / data-loss / fail-closed bypass; P1 bug or confirmed layer/N×M; P2 refactor; P3 nit
- Confidence integer 0–100. Speculative → ≤40 and P3 or drop
- Do not restate another domain's job (security agent owns injection; architecture owns layers)
- Quote 1 line of evidence max per finding; do not dump files

## Domain focus

### Architecture

Layer violations vs STRATEGY hard boundaries. Circular imports. God packages. CLI/MCP bypassing `app-services`. Engines touching FS/AST. Plane C mutation or execution. `core` growing non-Zod deps.

Metric: coupling notes, list of cross-layer imports with file:line.

### Axial drift

Wrong-axis duplication (N×M). Same concern copied across language analyzers, CLI vs MCP, or plugin hosts. Retry/authz/freshness/capability gates implemented in siblings instead of one plane.

Metric: N×M traps (confirmed ≥3 sibling copies or 2 copies + shared contract drift).

### Security

OWASP on a local untrusted-repo tool: path traversal, `git`/spawn argv vs shell strings, SQL concatenation, MCP tool input, secret/token handling, hook/guard bypass, prototype pollution on JSON, zip/path writes. SECURITY.md claims are hypotheses — verify in code.

Metric: injection sites reviewed, spawn/SQL/path APIs counted.

### Code smells

Functions >80 lines, files >400 lines, duplicated blocks, god objects, dead exports, boolean soup, feature envy.

Metric: files >400 loc, functions >80 loc (approx).

### Type safety

`any`, `as any`, `as unknown as`, `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` without justification, `!` non-null, missing discriminated-union exhaustiveness, `zod` parse skipped, `JSON.parse` unvalidated.

Metric: `any` count, ignore-comment count, unvalidated parse count.

### Async patterns

Missing `await`, floating promises, `Bun.spawn` without timeout/kill, SQLite concurrent write races, index-worker races, `setTimeout` as sync, blocking sync I/O on hot paths, unclosed DB/file handles.

Metric: spawn sites, sqlite write sites, missing-await suspects.

### Error handling

Empty `catch`, catch that returns dummy success, missing `cause`, errors turned into PASS, fail-open on STALE/UNSEALED, swallowed spawn failures.

Metric: bare/empty catch count, fail-open sites.

### Test quality

Asserts on implementation (field copies, source text, mock echoes). Tests that cannot fail. Missing BLOCK/fail-closed cases. Time/FS flakiness. Snapshot without contract. Coverage holes on P0/P1 paths.

Metric: tautology suspects, missing negative tests on gates.

### Tech debt

`TODO`/`FIXME`/`HACK`/`XXX`, deprecated APIs, experimental retriever leftovers (ADR 0005), magic numbers, commented-out code, version drift between plugin/cli/mcp.

Metric: TODO/FIXME count, deprecated symbols.
