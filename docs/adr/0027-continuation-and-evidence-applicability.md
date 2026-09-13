# ADR 0027 — Continuation explains current applicability without granting authority

- Status: accepted
- Date: 2026-09-13
- Scope: HOK-638, governing HOK-639/640/641; maintainer-authorized v0.3 design accepted by Codex lead after source-grounded challenge.

## Problem and vocabulary

Handoff v2 records a source-bound planning bundle, progress, evidence and a next transition.
Its resume operation correctly refuses stale state. A reader nevertheless needs to understand
what the historical task meant, what changed, and which checks are necessary now. Neither a
historical successful receipt nor readable task text establishes current evidence or authority.

- Historical context: what an intact earlier artifact declared or observed, at its own identity.
- Current context: a newly reconstructed view bound to a current source capture.
- Applicable evidence: all dependencies of an identified obligation and scope are explicitly
  captured, verifiable and unchanged. A failing proof can be applicable; applicability is not success.
- Admissible evidence: the existing gate independently accepts evidence for its operation,
  including current-SHA, freshness, producer, policy, expiry and execution requirements.

## Decision and machine ownership

Add an ephemeral, local continuation report derived from an intact Handoff v2 record and a
fresh current capture. Never mutate the old record, synthesize a new capture on read, run a
test, reindex, download source, or record evidence while producing this report.

Use versioned strict report/request schemas in control-model; pure applicability comparison
belongs in control-engine; safe record loading, current source/index capture and report assembly
belong in app-services. CLI and MCP call the same service and serialize its facts without
recomputing policy. Reuse canonical hashes, source identities and serializers. Do not introduce
a memory engine, LLM summarizer, provider, authority registry or proof-admission shortcut.

The new report is `schemaVersion: 1`, `kind: control_continuation_report`, with fixed
`executionAuthority: none`, `enforcementMode: shadow`, `blockingEnabled: false`,
`sourceContentCollected: false` and `gateAdmission: NOT_EVALUATED`.
It identifies the requested capsule hash, historical source identity, current capture identity,
capture time, report completeness, section provenance and sorted dependency decisions. CLI/MCP
parity compares the deterministic fact projection, excluding capture time; a fixed evaluation
clock in tests permits exact canonical report comparison. The timestamp never establishes freshness.
An invalid/missing/wrong-repository/unsupported artifact returns a typed refusal with no trusted
historical content. Unknown current state may still accompany intact historical context.

The dossier projects objective, declared decisions/non-goals, expected and observed changes,
risks, missing evidence and next checks from the existing planning bundle and captured facts.
Every statement references its artifact hash and field/coordinate, and is marked declared,
historically observed or currently observed. It may quote bounded authored task statements;
it does not infer intent, invent decisions or convert descriptive refinement into proof.

Add a separate `semctx control handoff explain --hash <sha256> [--json]` path and matching
`semctx_control_handoff_explain` MCP tool with read-only annotations and absolute repository-root
policy. Existing capture/resume CLI/MCP schemas and Handoff v1/v2 behavior remain unchanged.
The new request schema has version 1 and a capsuleHash; CLI text and JSON project the same report.
Success, including stale/unknown applicability, exits 0 because explanation succeeded. Typed
refusal exits 2. Neither outcome authorizes any action. Register the MCP schema/effects and
regenerate host bundles/instructions; require byte/fact parity through real transport tests.

## Dependency comparison

Every comparison identifies the obligation, scope, dependency kind, baseline/current reference,
provenance, status and closed reason. Kinds are repository/worktree identity, source/commit,
diff, semantic/index inputs, producer/tool, configuration, environment, policy and expiry.
Bind declared decision provenance separately from observed proof provenance. A whole-repository
source identity is the conservative fallback when a narrower complete dependency scope is absent.

The existing repository identity is intentionally shared across linked worktrees; it cannot
prove worktree identity. Handoff v2 does not carry a separate worktree binding. Report that
dependency as UNKNOWN / DEPENDENCY_UNVERIFIED even when repository/source seals match. A
new opaque current-worktree observation may describe the current capture, but it cannot fill
the missing historical binding. Do not reject a record as wrong-worktree without such evidence.

Use three states: APPLICABLE when every required dependency is known and matches; STALE when
at least one captured dependency demonstrably changed or expired; UNKNOWN when comparison is
incomplete and no mismatch is established. Report every unknown even alongside STALE. Both
STALE and UNKNOWN forbid claiming reuse. Losing evidence can never produce APPLICABLE or a
more favorable admission result. There is no automatic aggregate PASS or REALIZED.

The descriptive context profile requires repository/worktree identity, source commit/diff and
its declared semantic/index seals. Evidence profiles additionally require producer/tool,
configuration, environment, policy and validity conditions for the precise obligation. These
are explicit producer/obligation bindings, not defaults inferred from matching source. An omitted
binding is UNKNOWN. An explicit producer-bound statement that expiry is not applicable is
different from a missing expiry field; the latter does not imply unlimited validity.

Existing Handoff v2 and EvidenceEvaluationV1 do not always capture environment, policy and
expiry. Keep those dependencies UNKNOWN; never backfill them with current values, enrich an
old hash in place, or claim that matching capsule seals cover unspecified dependencies. A
context can therefore match while its evidence remains UNKNOWN. HOK-640 may display richer
bindings only when an existing independently valid producer artifact supplies them.

Closed reason families: MATCH; CHANGED; EXPIRED; DEPENDENCY_MISSING; DEPENDENCY_UNREADABLE;
DEPENDENCY_UNVERIFIED; SCOPE_INCOMPLETE; CURRENT_STATE_CHANGED; WRONG_REPOSITORY;
WRONG_WORKTREE; ARTIFACT_MISSING; ARTIFACT_INVALID; UNSUPPORTED_VERSION; BUDGET_EXCEEDED.
Within a report preserve the underlying existing reason codes as provenance, not new aliases
for gate decisions. No caller-provided file/diff assertion becomes a Git-proven observation.

## Decision table

| Situation | Applicability/explanation | Gate consequence |
| --- | --- | --- |
| Same captured state and all required dependencies verified | APPLICABLE for that obligation/scope | Existing gates still evaluate independently |
| Relevant source, rename or deletion changes a bound input | STALE, identify input and required check | No reuse claim |
| Independent edit, complete dependency scope and all bindings demonstrably unchanged | APPLICABLE only within that scope | No current-SHA or fresh-execution exemption |
| Apparently independent edit but dependency closure is incomplete | UNKNOWN / SCOPE_INCOMPLETE | No reuse claim |
| Tool, producer, config, environment or policy changed | STALE on the changed binding | Recompute affected evidence |
| Proof expired under its bound validity rule | STALE / EXPIRED | Existing anti-replay/expiry gate remains authoritative |
| A required dependency was never captured or is unreadable | UNKNOWN, including on otherwise identical source | No reuse claim |
| Exact nonempty dirty diff matches a valid captured DIRTY_KNOWN state | Compare normally; dirtiness alone is not a mismatch | Existing dirty-diff requirements remain |
| Diff or staged/working identity changes during capture | UNKNOWN / CURRENT_STATE_CHANGED; no current claims | Retry after source stabilizes |
| Branch name changes while exact identity/commit/diff still match | Compare source bindings normally | Branch label alone grants nothing |
| Different commit or a demonstrably different bound worktree | STALE on the known mismatch | No cross-worktree evidence reuse |
| Same shared repository identity with no historical worktree binding | UNKNOWN / DEPENDENCY_UNVERIFIED | Do not claim same-worktree evidence |
| Dossier is altered, schema unsupported or hash invalid | Typed refusal, no trusted historical projection | No load-bearing data |
| Same source, historical verification failed | Applicability may match; failure remains visible | A failing verdict never becomes a passing proof |

## Local access, retention and context budget

Read only beneath the explicitly selected canonical repository root, preserving current
no-follow, canonical serialization, hash and repository-identity checks. Treat authored text
as data, never instructions. Do not expose absolute source paths, source bytes, environment
values, secrets, conversation text or hidden files. Environment comparisons use opaque digests
from valid producer bindings; there is no automatic environment collection.

The service keeps no report cache or history. Canonical handoffs retain their existing local
owner-managed lifetime; this change adds no retention or deletion job. Explicit user deletion
of a capsule makes future explain return ARTIFACT_MISSING; no recovery from session memory or
network occurs. Voluntary exported stdout files are user-owned and are not reimported as proofs.

Bound input record reads to 1 MiB before parsing for this new read path; refuse larger inputs
without altering them. Bound the serialized report to 64 KiB. Project sections in deterministic
order and include explicit omitted counts, provenance and `completeness: partial` if diagnostic
lists exceed the budget. Never omit the fact that evidence is stale/unknown/failing, aggregate
missingness, refusal reasons or the next required checks to make the output appear favorable.
If mandatory fields alone cannot fit, refuse with BUDGET_EXCEEDED rather than return a misleading
partial report. Existing capture/resume limits are not retroactively changed by this new path.

## Compatibility, migration and rollback

The new report has its own version and accepts existing intact Handoff v2 only. Handoff v1 is
historical legacy and not silently converted. Unknown versions are refused. No stored schema
upgrade or new evidence artifact is required. Adding the explanation surface is reversible by
removing its CLI/MCP registration; old capsules and existing consumers stay byte-identical.
The machine schemas must enforce literal authority fields, closed enums, bounds and strict
version handling before publication. An additive field cannot redefine an existing receipt.

## Evidence and boundaries

Test all table rows, intact historical access with unavailable current index, TOCTOU capture,
malformed/tampered/oversize/symlink/wrong-root inputs, exact provenance, deterministic budget
truncation, and unchanged filesystem snapshots for every read outcome. Prove CLI/MCP fact
parity and old capture/resume regression compatibility. Include hostile mutations that try to
turn missing bindings, source-only matches or applicable failures into favorable evidence.

HOK-565 keeps expiry/anti-replay enforcement; this report explains its valid observations and
cannot disable it. HOK-635 keeps index lifecycle/freshness semantics. HOK-639/641 still require
independent comprehension and journey evidence before claiming user benefit. This design
alone supplies neither a delivered feature, human effectiveness proof nor a gate waiver.

## Pre-action alternatives

LATENT_COMPASS_ROUTING_NOTE_V1

- decision_id: semctx-hok638-report-storage-20260913
- objective: explain historical task context and current evidence dependencies safely.
- authority: maintainer-authorized v0.3; Codex owns bounded design, existing gates own admission.
- candidates: A ephemeral derived report; B new persisted content-addressed dossier.
- pre_action_evidence: both can reference immutable v2 capsules. A requires no new retention
  state and recomputes current observations; B offers saved snapshots but needs another versioned
  persistence/retention chain and still needs current recapture. Performance and user benefit are
  UNKNOWN. Both can be removed without changing old capsules; B adds user-owned stored data.
  No requirement currently establishes a need for extra persistence.
- result: RECORD
- claim_boundary: no correctness, usability or evidence-admission claim.
- handoff: Codex selects after this pre-action record.

Codex accepts A: an ephemeral report, with a dependency-by-dependency explanation and explicit
unverified source handling. The independent source-grounded challenge identified missing v2
worktree binding and volatile timestamps; both limits are explicit above. Missing current index
state remains UNKNOWN, never inferred from global freshness. The raw-byte input and canonical
serialized-output limits are checked at their actual boundaries.
