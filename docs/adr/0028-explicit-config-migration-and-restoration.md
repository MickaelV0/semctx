# ADR 0028 - Explicit configuration migration and restoration

- Status: accepted
- Date: 2026-09-13
- Scope: HOK-635; maintainer-authorized v0.3 design accepted by Codex lead after read-only architecture challenge.

## Problem

Config v1 preserves legacy discovery and does not enforce include globs. Config v2 opts into
explicit selection and language analysis. Running init over an existing config is not a migration
workflow: it offers no selection comparison, exact backup, or explicit restoration. A maintainer
must see the scope change before choosing it and must retain authored intent and verification data.

## Decision and ownership

Add CLI-only `semctx migrate config`, dry by default, using existing config validation and discovery.
The source of truth is a versioned config-migration contract in control-model, pure comparison and
state decisions in control-engine, confined persistence/mutex in repository-store, and orchestration
and complete reports in app-services. CLI parses and renders; it does not decide policy. Existing
anchor migration, MCP tools, index schema and source-selection behavior remain unchanged.

Commands:

```text
semctx migrate config --proposal <repository-relative-json> [--format text|json]
semctx migrate config --proposal <repository-relative-json> --apply --plan <sha256> [--format text|json]
semctx migrate config --restore <run-id> [--format text|json]
```

An explicit `--dry-run` may be accepted as a synonym for the default. Invalid combinations refuse
before mutation. The proposal is a complete valid v2 config under the canonical repository root,
outside config.json and config-migrations. No inferred include/languages or default conversion is
allowed. Only version, include, exclude, selectionMode and languages may change. All other policy,
including unknown fields, must be preserved; repositoryRoot is runtime-only and omitted on disk.
Validation for discovery uses the existing schema; serialization must not silently strip unknown
policy fields. Current config must be v1 for a new application.

## Plan and report

Planning performs no write, directory creation, lock acquisition, recovery or index opening.
It inventories exact v1 config bytes, the canonical candidate bytes, both existing discovery
candidate ledgers and selected paths, sorted added/removed/unchanged paths, authored semantic
`.sem` files, and presence/content digest of verification-state.json. An empty selection is shown
explicitly; it is not filled with a guessed scope. Unsupported/disabled candidates retain their
discovery reasons. Planning does not claim the new index has been built or has equivalent coverage.

A deterministic SHA256 plan binds canonical root, fixed target config path, both config digests,
the complete discovery ledgers and selection diff, and sorted authored/baseline inventory. It does
not bind incidental run IDs or history. Apply recalculates that plan under the cooperative mutex
and refuses if the caller's digest is stale. Proposal and inventory reads refuse links and invalid
types; a missing config is a refusal rather than initialization. Authored files and baseline are
never rewritten by this workflow.

JSON uses `schemaVersion: 1`, `kind: config_migration_report`, operation plan/apply/restore, a
status (PLANNED, APPLIED, RESTORED or REFUSED), canonical repositoryRoot, nullable planDigest and
runId, nullable plan details when unavailable, and structured reasons. Plan details carry both
config digests, both discovery ledgers, the selection diff and authored/baseline inventory.
Refusals carry no trusted plan when it could not be validated. Refusal reasons include invalid
input/config, policy change, stale plan, active migration, recovery required, invalid artifact and
divergent config. Abandoned preparation directories are reported as observations, never removed.
Nonzero exit denotes refusal or I/O failure; successful planning, application and restoration exit
zero. Exact field names and strict schemas live in control-model and receive contract tests.

## Cooperative mutation and crash recovery

Use a separate `.semctx/config-migrations/coordinator.db` opened directly through bundled Bun
SQLite with DELETE journaling and a bounded, fail-fast BEGIN IMMEDIATE. Do not open the index DB
or use the index store constructor. Hold the transaction across the mutation and close/rollback
in finally. No persistent PID lock is used. A real child-process test must establish killed-owner
lock release on supported hosts. All ancestors, DB and SQLite sidecars are checked for links and
canonical containment before opening, following existing repository-store boundaries.

Each new apply allocates an exclusive run ID. It exclusively writes, fsyncs and rereads exact
before/after config bytes plus manifest under `prepare-<run-id>`, then atomically renames that
directory to `runs/<run-id>` in PREPARED state. A published manifest is schema-validated and binds
root, run ID, plan and the fixed filenames/digests. No config replacement can precede publication.
Incomplete preparations remain additive and are reported. A later apply may create a different
run without reusing or deleting abandoned preparation. A published run not RESTORED requires
explicit restoration before another apply. A repeated plan after RESTORED uses a new run.

States are PREPARED -> APPLYING -> APPLIED -> RESTORING -> RESTORED. Persist APPLYING before the
config replacement and RESTORING before restoring it. Use exclusive unpredictable temporary
files, fsync, preimage digest check immediately before rename, atomic replacement and readback.
Preserve real I/O errors; directory synchronization may be unsupported on Windows as in the
existing atomic writer, so ordinary process-interruption proof is not a power-loss guarantee.

Restore requires an exact validated run ID, validates the manifest and both stored file digests,
and inspects current config bytes under the same mutex. Initial digest means finalize RESTORED
without rewriting config. Candidate digest means replace only config by the exact initial bytes
and finalize RESTORED. Any third value refuses without updating the run or config. This rule also
recovers interruption in PREPARED/APPLYING/RESTORING. A terminal RESTORED run is idempotent only
while config still has the initial digest; it must never overwrite later changes. Authored data
and baseline are inventoried before/after the operation and remain byte-identical; their later
legitimate evolution is never rolled back from a migration artifact.

## Authority, compatibility and limits

This is explicit, local, opt-in configuration migration. No automatic indexing, proof recording,
restamping, deletion, provider removal, daemon, upload, installed-host update or release occurs.
Existing v1/v2 consumers and config semantics remain compatible. After apply/restore the user
must explicitly rebuild and run the existing verification flow; an old index or proof does not
become current. Backups, runs and abandoned preparations remain available; no automatic cleanup.

The mutex coordinates only this new command family. Existing init/saveConfig and outside editors
do not acquire it. Before/after checks detect observed drift but are not a global compare-and-swap.
The supported mutation environment is a trusted local worktree with no concurrent external
writer or hostile pathname replacement. Path checks do not promise race-free O_NOFOLLOW SQLite
opening or protection from every hard-link alias. Conflicting observations fail closed.

## Required evidence and generated artifacts

Prove deterministic/no-write planning and explicit v1/v2 selection differences, preserved policy
and unknown fields, stale plan refusal, exact apply/restore with authored/baseline/index unchanged,
third-value and artifact-tamper refusal, links/sidecars refused before writes, bounded competing
processes, killed-owner recovery, and interruptions before publication, before/after config rename,
and during restore. Use real process barriers for crash claims and witness test failure under the
corresponding defect. CLI text/JSON/exit behavior must agree with the service and strict schemas.

Regenerate any affected packaged runtime using its existing generator and check byte parity;
never hand-edit bundles. Run targeted proof, affected types/lint, the canonical verify:pr gate,
fresh independent proof-integrity audit and required CI on the final candidate. This ADR is a
design decision, not evidence that implementation, portable migration or release is complete.
