# Tooling plan

> Decision date: 2026-09-05. Proposed tooling, not newly installed capabilities.
> Outcome: make first use, evidence publication and index maintenance reproducible with a small stack.

## Reuse before adding services

| Tool or surface | Decision | Purpose and acceptance |
| --- | --- | --- |
| Bun, TypeScript, SQLite and the existing Python quality tools | Reuse current pinned project toolchain. | Keep targeted tests, full verification and deterministic fixtures. Do not add another test runner or runtime merely for the roadmap. |
| Existing GitHub Actions release and artifact jobs | Extend the current flow. | Exact-version installation/upgrade matrix, registry-availability polling, CLI/MCP smoke and receipt read-back. Do not infer registry trust configuration from workflow permissions. |
| Existing multicore benchmark | Extend for index cost and lifecycle. | Capture process-tree peak memory, cold/warm/update time, workers actually used, disk and source/config/tool identity; retain single-worker baseline and semantic-equivalence checks. |
| Existing context-pack eval harness | Reuse mechanics selectively. | It evaluates golden fixtures; it is not the ground truth or evidence of independent impact value. Add a distinct impact-pilot suite and scorer. |
| GitHub Pages | Build a small static evidence/demo site when the public bundle exists. | No account, backend or database for readers. Deploy reviewed public output only; no private corpus or repository source upload. |
| npm trusted publishing/provenance | Preserve and verify the existing registry/workflow binding. | Check exact repository/workflow registration before proposing any configuration change; this roadmap does not prove whether registry-side configuration needs work. |
| Native LSP / optional SCIP | Reuse/evaluate by consumer need. | Definitions/references stay navigation facts. Prove indexer support on each target platform before making it a prerequisite; retain direct-source fallback. |
| SQLite FTS5/BM25 | Evaluate only in the content-first research lane. | First prove extension availability in supported Bun builds. Keep retrieval corpus/storage logically separate from authority data; compare with embeddings and dated external baselines. |
| Hosted analytics, external model APIs, universal vector service | Defer. | No requirement for normal product use. Introduce a service only for an observed need with explicit cost, data and rollback decisions. |

## Build these instruments in order

### 0.1.20: compatibility and release consistency

Create one machine-readable compatibility source for product/Bun/host/schema versions, supported
versus tested status and migration notes. Generate or check the relevant documentation against it.
Test a deliberate version mismatch to ensure the checker fails; do not rewrite past release notes.
Extend installer smoke coverage to absent/incompatible hosts, upgrade, locked cache, delayed registry
availability and recovery without configuration loss. Use supported host interfaces only.

This is tool work for a follow-up implementation ticket. No new checker or manifest is installed
by this planning change.

### 0.2: demonstration, pilot runner and evidence page

Create a small redistributable repository with three pinned changes: benign, risky and unresolved.
A tracked cross-platform runner uses a frozen packaged candidate for the pilot, then regenerates
the public example from a specified released CLI. Record both artifact identities and remeasure
behavioral changes before accepting the release. Keep CLI, JSON
and rendered examples aligned. Record terminal output rather than hand-authoring successful results.

The separate impact-pilot runner freezes its corpus manifest, protocol, labels, versions, source
digests and baseline selection. Export raw per-case JSON/CSV and a human report; reject missing cases
or mismatched identities. Include a negative scorer witness. Keep development and held-out cases
separate. Author-written fixtures remain regression tests, not independent user evidence.

Build a static report page from an explicitly public bundle. Actions artifacts support run-to-run
evidence exchange but expire; retain release evidence as versioned public data/release assets with
digests and a stated retention policy. Do not publish the old private corpus through this path.

Collect pilot consent and local aggregate events: install outcome, first understood report, advice
accepted/ignored with a reason, and second use. Export is explicit. Sanitize paths and free text;
never enable hosted telemetry or upload prompts/source automatically.

### 0.3: index lifecycle and resource matrix

Reuse the current benchmark before optimizing. Cover cold build, no-op refresh, edit/add/delete,
rename, branch switch, simultaneous worktrees, external mutation, crash/cancel and consumer reload.
Bind source/configuration, producer artifact and loaded consumer generation. Validate incremental
equivalence against a full rebuild and verify visible fallback for unsupported invalidations.

Record memory/time/disk for the process tree, not only the parent. Freeze machine/corpus budgets
before tuning. A resident service must show useful warm-path gains and release resources after
inactivity. Installation and removal should report exactly what belongs to Semctx.

### 0.4: provider conformance kit

Select one provider from the pilot's recorded unmet-context needs and manually consulted sources.
Build fixtures for present/absent/stale/degraded/unsupported
providers, source mismatch, partial language coverage and forged or irrelevant evidence. Compare
native-only and connected output on identical inputs. Reuse established interchange schemas where
they carry the required fact, and preserve Semctx's separate authority/provenance checks.

SCIP and FTS5 are experiments or adapters, not reasons to replace working LSP/CCC/Graphify tooling.
Any future replacement needs inventory, dry-run, tested backup/restore, shadow comparison, atomic
cutover and a stability window before removal.

## Maintainer ergonomics

Keep the canonical full pre-PR gate. Use its existing targeted iteration path during implementation,
then reuse unchanged exact-SHA evidence only where current repository policy permits. Measure local
verification and CI duration before adding cache/sharding complexity; performance changes must not
weaken the proof mechanism. Document a worktree inventory/cleanup preview as existing maintenance
work, never automatic recursive deletion.

No global plugin install, package upgrade, daemon activation, Pages deployment or registry settings
change is required to adopt this roadmap. Those actions belong to their scoped implementation and
delivery tickets. The project already has enough tools to prepare the plan.

## Official sources checked for these choices

- [Bun test runner](https://bun.sh/docs/test): reuse the built-in TypeScript test runner.
- [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts): preserve job outputs and digests.
- [Artifact retention](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository): artifacts are retention-bound, not permanent publication.
- [Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): static output deployment with a protected environment and scoped permissions.
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/): repository/workflow-specific trust; permissions alone do not establish registry configuration.
- [SCIP protocol](https://github.com/scip-code/scip): interoperable code-navigation facts, not Semctx policy verdicts.
- [SQLite FTS5](https://sqlite.org/fts5.html): local full-text search and BM25; actual Bun extension availability still needs a runtime test.
