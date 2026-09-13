# ADR 0025 — Explicit index recovery records a newly computed verification

- Status: accepted
- Date: 2026-09-13
- Authority: maintainer-authorized v0.3 implementation; bounded Codex lead decision for HOK-746.

## Context

A well-formed v3 verification baseline becomes stale when source content changes. Semantic
lifecycle checking correctly rejects its use as current evidence, but indexing currently rejects
the same finding before rebuilding. Indexing has never written verification-state.json: removing
that refusal alone cannot complete recovery, and copying an old verdict onto new hashes would
violate ADR 0007.

## Decision

Ordinary indexing may proceed through EVIDENCE_BASELINE_STALE only. Malformed baselines,
semantic errors, duplicate definitions and every other lifecycle error continue to block.
The stale finding retains its error severity for semantic checks, status and evidence consumers.
Ordinary index never deletes, rewrites or records a verification baseline.

The explicit CLI command `semctx index --record [--json] [--workers auto|1..8]` coordinates
index rebuild, a newly computed working-tree verification, and atomic v3 baseline recording.
The application service owns this orchestration and the recording operation shared with
`semctx verify diff --record`. CLI handlers only validate arguments and project service results.
The existing verify recording contract, fields, refusal of untracked or hidden inputs, verdict
semantics, atomic writer and analyzed-diff stability checks remain unchanged.

The recovery operation captures recordable source state before rebuilding and compares it
after rebuilding, verification and immediately before recording. The exact analyzed source
hash must match that state. It also binds and checks the persisted index/seal identity produced
by this rebuild across verification; source/config/semantic/index drift must prevent recording.
Only the stale evidence lifecycle finding may explain a temporarily unsealed index. A second
writer, changed branch, staged state or file bytes must not attach a verdict to another index.
These checks preserve the existing cooperative filesystem race boundary; they are not an OS
transaction or a lock against malicious concurrent writers.

Successful computation records the actual PASS, WARN or BLOCK verdict, including unknowns in
the report. No verdict is copied from the old baseline and no unknown is erased to obtain PASS.
Fresh source state is not proof applicability or gate authorization. ADR 0007 continues to
govern authorization (including its existing verdict != BLOCK rule); the recovery command adds
no gate exception and never performs a terminal Git operation.

## Public contract and compatibility

The machine sources are app-services indexing/verification orchestration, CLI command handlers
and CLI help. Without --record, existing index JSON and exit behavior stay compatible.
With --record, successful JSON retains the index fields and adds `verification` containing
`recorded: true` and the complete existing verification report. It is one JSON document.
The exit status is 3 for a recorded BLOCK, otherwise 0, matching default verify behavior.
Text distinguishes rebuilding, evidence recording and the verdict, with visible unknowns.
An exception after a successful rebuild reports `indexRebuilt: true` and
`evidenceRecorded: false` in error details and names that partial outcome in the message.
Before rebuild completion, existing typed failure behavior remains in force.

No current MCP indexing tool exists; adding a new tool is outside this slice. Both plugin
hosts receive the same regenerated runtime sources and CLI recovery instructions where relevant.
The persisted evidence schema remains version 3. There is no migration, deletion or hash restamp.
Rollback removes the additive command path and restores the old indexing refusal; no data
conversion is required.

## Failure boundary and evidence

Rebuild, verification, stability or atomic-write failure leaves the old baseline byte-identical.
A successful index may remain installed after a later failure; output must expose that partial
outcome. Malformed evidence remains rejected. The guard and INDEX_BINDING_ADMISSIBILITY table
are unchanged.

Required tests: current v3 stale -> plain index with old evidence preserved; explicit recovery
-> matching new baseline and FRESH/DIRTY_KNOWN source state; clean and dirty cases; actual
verdict/unknown preservation; malformed baseline and invalid semantic/pointer refusal; rebuild
failure, record failure and deterministic source/index drift with old evidence preserved;
existing verify recording regressions; CLI single-JSON/exit/help contract; generated plugin
parity. Run the canonical pre-PR gate and an independent review before acceptance.

## Pre-action decision record

LATENT_COMPASS_ROUTING_NOTE_V1

- decision_id: semctx-hok746-recovery-20260913
- objective: recover a stale v3 baseline without reusing its verdict or losing failed-rebuild evidence.
- authority: maintainer-authorized scope; Codex owns the bounded design.
- candidates: A permit rebuild only; B explicit rebuild plus newly computed verification.
- pre_action_evidence: A preserves authority and costs one rebuild, but leaves baseline stale;
  B composes existing rebuild and recording services with added stability checks and one fresh
  verification. Both are reversible code changes; runtime/performance and implementation success
  are UNKNOWN. A verifies index repair only; B also tests the complete recovery boundary.
- result: RECORD
- claim_boundary: this record proves neither implementation correctness nor evidence authority.
- handoff: Codex selected B for the single-command recovery criterion; A remains ordinary index behavior.
