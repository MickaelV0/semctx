# Changelog

All notable changes to `semctx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `0.1.0` is the first tagged release;
nothing has been published to a package registry (npm) or the GitHub Marketplace.

## [Unreleased]

### Added

- **Explicit control freshness verdict**: read-only CLI `semctx status` and MCP
  `semctx_control_status` report `FRESH`, `DIRTY_KNOWN`, `STALE`, or `UNSEALED` from the persisted
  index snapshot. Trace rejects stale/unsealed inputs and migration planning returns a structured
  fail-closed blocker before consuming them.

- **Control freshness seal**: indexing atomically binds Git `HEAD`, the complete tracked/untracked
  working delta, the direct analyzer-input manifest (including Git-ignored inputs), Plane A graph,
  Plane B model, repository root, store schema and producer version.
  `semctx index --json`, CLI Plane C reports and equivalent MCP reports expose the same strict,
  domain-separated SHA-256 attestation that the separate status preflight evaluates.

- **Semantic Reconstruction Control Plane (Plane C, read-only)**:
  - `@semantic-context/control-model`: L0-L6 coordinates, explicit coverage, architecture
    snapshots/deltas, proof attestations, migration states/steps and versioned authorization reports.
  - `@semantic-context/control-engine`: deterministic lift/lower/impact/explanation traversal,
    current/target comparison, shadow-first migration planning and fail-closed step/deletion policy.
  - CLI `semctx control trace` / `control plan` and MCP `semctx_control_trace` /
    `semctx_control_plan`, backed by a strict read-only SQLite reader.
  - A bounded project intent kernel under `.semctx/semantic/project/**`; sibling local scaffold files
    remain ignored and the default full-semantic gitignore policy remains compatible.
  - Architecture contract: `docs/architecture/control-plane-v1.md`.
  - Repo-local Codex plugin `semctx-control`: MCP registration, an implicit proof-honest workflow
    skill, a local marketplace entry, and an installation/agent-usage guide.
  - Codex and Claude Code now share one byte-identical `semctx-control` workflow contract across
    Planes A/B/C, including the generic project demo objective, verdict namespaces and
    `READY`-is-not-authority rule. The Claude plugin gains a validated local marketplace manifest
    and uses the same `semctx-mcp` executable as Codex through a cache-safe launcher; its skills,
    hook and MCP server live in Claude Code's standard auto-discovery locations and validate as
    installable components.

- **Semantic layer (Plane B)** — authored intent beside the derived repository graph (ADR 0009):
  - `@semantic-context/semantic-model`: `SemanticNode` / `ChangeContract` types, statuses,
    relations, deterministic ids, Zod boundary schemas.
  - `@semantic-context/semantic-dsl`: a tolerant line/indentation `.sem` parser with file/line/column
    diagnostics, a deterministic idempotent formatter, and `symbols` / `ascii` renderers (glyphs are
    a view — never required to parse).
  - `@semantic-context/semantic-engine`: Git-versioned `.semctx/semantic/**` file store, repository
    link resolution + stale detection, a bounded deterministic **semantic slice** (explicit scopes
    only — not code search), proof-carrying **change contracts** with a composed `change verify`
    (VERIFIED / PARTIAL / BLOCKED / STALE), and `handoff` / `resume` working deltas.
  - CLI: `semctx semantic <init|check|inspect|render|format|slice|handoff|resume>` and
    `semctx change <open|update|inspect|verify|close>`. `change verify` **composes** `verify diff`
    (via the extracted `computeVerifyReport`) and is never more optimistic than the data.
  - MCP: advisory tools `semctx_semantic_slice`, `semctx_change_open`/`_update`/`_verify`,
    `semctx_semantic_inspect`, `semctx_handoff`, `semctx_resume`; a `semctx-semantic` skill. The
    first-class `semctx_verify_change` and the guarded hook are unchanged.
  - Config: optional, additive `semantic` policy block on `.semctx/config.json`.
  - `.gitignore` policy refined so `.semctx/semantic/` is tracked while the rest of `.semctx/` stays
    local (migrates a blanket `.semctx/` rule).
  - Docs: semantic-layer-v1, semantic-model, change-contracts, the Claude Code integration guide, a
    reservation walkthrough, and ADR 0009.

- **Required-altitude authority policy** (P3, [#28](https://github.com/hoklims/semctx/issues/28)):
  one canonical table turns a change's abstraction altitude into the authority it requires — L0-L1
  `autonomous`, L2 `constrained`, L3 `reviewed_plan`, L4-L6 `human_authority` — with obligations
  accumulating as a strict superset at each step. Exposed identically as CLI
  `semctx control authority` and MCP `semctx_control_authority`, so both hosts derive the regime
  from the same contract instead of restating it. Autonomy is a conjunction of the regime and a
  trusted preflight: a `STALE` or `UNSEALED` verdict withdraws autonomous write at every altitude,
  including L0. The report carries `executionAuthority: "none"`; it names the authority a change
  requires and never grants it. Host lifecycle integration, handoff v2, telemetry and shadow
  enforcement remain open on #28.

### Changed

- `SemctxConfigSchema` gains an optional `semantic` object (backward-compatible; pre-semantic configs
  still validate, and a `semantic` block is no longer silently stripped).
- `verify diff` internals: the report computation is extracted into a reusable `computeVerifyReport`
  so `change verify` composes it verbatim (no behaviour change to `verify diff`).

### Fixed

- **The freshness preflight always returns a verdict.** `semctx status` and `semctx_control_status`
  raised `CONFIG_INVALID` ("semantic model cannot be projected into Plane C") instead of reporting a
  verdict when the authored model carried error-severity diagnostics, duplicate ids, or
  error-severity lifecycle findings. Callers received an untyped transport error, so a fail-closed
  consumer could neither proceed nor prove it had to stop — and the same drift also blocks
  `semctx index`, leaving no supported way to learn what needed repairing. Two `UNSEALED`-family
  reason codes now carry the classification: `SEMANTIC_MODEL_INVALID` and
  `SEMANTIC_LIFECYCLE_INVALID`. Other Plane C operations still refuse the projection; only the
  preflight's answer changed. Existing verdicts, seals and reason ordering are unaffected, and
  `canRunHighRiskControl` stays `false` for both new reasons.

## [0.1.0] - 2026-07-04

First public release. The GitHub Action is referenced as
`hoklims/semctx/packages/github-action@v0.1.0` (no `v1` moving tag until the Action contract is
declared stable).

### Added

- `verify diff --base <ref> / --head <ref>`: analyse a real merge-base range for CI. Fails
  cleanly (`GIT_BASE_UNAVAILABLE`) when the base is not available locally; never fetches implicitly.
- `verify diff --format text|json|github`. `json` is a **stable, versioned** report
  (`schemaVersion 1`, ADR 0008); `github` emits workflow annotations.
- `verify diff --fail-on block|warn|none`, `--output <path>` (atomic write), `--dry-run`,
  `--record` (writes `.semctx/verification-state.json` for the guarded hook).
- Severity tiers `strict` (BLOCK) / `advisory` (WARN), and a `critical_contract_changed_without_test`
  rule for `critical`/`security`-tagged exported contracts.
- **GitHub Action** (`packages/github-action`): composite action + Node adapter — annotations, job
  summary, outputs, PASS/WARN/BLOCK gate. `contents: read` only, no PR comments, no secrets.
- **Claude Code plugin** (`plugins/claude-code`): MCP (`verify_change`, `inspect`), a verify skill,
  and an opt-in guarded hook (diff-hash gated, blocks only `git commit`/`git push`).
- `init --preset github-claude`: preview-first bootstrap (`.semctx/config.json`, CI workflow,
  Claude note, optional dev container). Never overwrites without `--force`.
- Contributor **dev container** (`.devcontainer`).
- Documentation: getting started, CLI and configuration references, integration guides
  (GitHub Actions, Claude Code, guarded mode), pre-commit hook.
- ADRs 0006 (Action packaging), 0007 (guarded hook), 0008 (versioned machine output).

### Changed

- Repositioned the product as a **repository change-impact analyzer** built around `verify diff`
  (ADR 0005). The `task → ContextPack` retriever is withdrawn as a primary retriever after a
  comparative evaluation (`benchmarks/change-impact-eval`); it remains in the tree as experimental.
- Ordering is byte-identical across environments (code-unit comparison; ADR context in the
  decision log).

### Security

- GitHub Action passes all user-controlled inputs through the step `env:` (no `${{ }}` template
  interpolation into run scripts) to prevent Actions injection.
