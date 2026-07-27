# Getting started

`semctx` verifies the semantic blast radius of a change: it maps a diff to affected symbols,
exported contracts, declared invariants and relevant tests, and returns a PASS/WARN/BLOCK verdict.
It is local-first, deterministic, and needs no LLM, network, or service.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (the engine runs under Bun).
- A git repository with TypeScript sources.
- Optional: Codex and/or Claude Code with plugin support. `semctx install` detects whichever hosts
  are already available; it never installs the host applications themselves.

## 1. One-command agent onboarding

Run this from the target Git repository:

```bash
bunx semctx@latest install
```

The command installs or updates every detected Semctx agent plugin, prepares the repository, and
returns a final readiness report. It can be safely re-run. Preview with `--dry-run`, select a host
with `--host codex|claude|all`, or update only the machine plugins with `--skip-setup`.

After a successful run, open a new Codex task and/or restart Claude Code as reported.
If Windows has the legacy Codex cache locked in an active task, the install still succeeds after
verifying the replacement and completes that legacy cleanup automatically in the background.

## 2. CLI-only bootstrap

```bash
bunx semctx@latest setup
```

This combines configuration, semantic scaffold, indexing and validation. It is idempotent and does
not overwrite existing configuration or authored `.sem` files. Use
`semctx setup --preset github-claude` when the CI workflow and Claude note are also wanted.

The lower-level `init` and `index` commands remain available for custom flows:

```bash
semctx init --preset github-claude --dry-run
semctx init --preset github-claude
semctx index
```

## 3. Verify a change

```bash
semctx verify diff                             # working tree vs HEAD
semctx verify diff --base origin/main          # a branch range (real merge-base)
```

Read the verdict:

- **PASS** — nothing gated.
- **WARN** — attention, not failure (e.g. a plain exported contract changed without a direct test).
- **BLOCK** — an invariant, or a `critical`/`security`-tagged contract, changed with no covering
  test. Resolve it, or disable the rule in `.semctx/config.json`.

Run the tests listed under *recommended tests*.

## 4. Make it strict (optional): semantic markers

Without markers, `verify diff` still reports impacted symbols, exported contracts and tests.
Markers tell semctx which changes must be **proven**:

```ts
/**
 * @capability reservation-confirmation
 * @tag critical
 * @invariant  confirmed-never-exceeds-capacity: confirming must never overbook a slot
 */
export function confirmReservation(/* ... */) { /* ... */ }
```

Now a change to `confirmReservation` without a covering test is a strict-tier `BLOCK`.
Use `@tag critical` for an exported contract that must keep test coverage, or `@tag security` for a
security-sensitive symbol. These blocking rules arm only from explicit tags; semctx never guesses
criticality from a symbol or file name.

## 5. Gate it

- **Locally**: a [pre-commit hook](examples/pre-commit-hook.md) running `verify diff --staged`.
- **In CI**: the [GitHub Action](integrations/github-actions.md).
- **In an agent**: the Codex and Claude Code plugins share the same `semctx-control` workflow;
  choose the matching guide under [`docs/integrations`](integrations/claude-code.md).

## Next

- [CLI reference](reference/cli.md)
- [Configuration reference](reference/configuration.md)
- [Why the retriever was withdrawn (ADR 0005)](adr/0005-context-retrieval-pipeline-rejected.md)
