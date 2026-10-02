# ADR 0032 — Explicit refusal at the 0.4 boundaries

Status: accepted for the maintainer-authorized 0.4 release.

## Context and decision

Linear is authoritative for the current milestone split. HOK-662, HOK-669 and HOK-682 define
the 0.4 result: malformed, unreadable, unsafe or unsealed inputs must not become success.
The maintainer authorized this bounded release after reviewing those criteria. Provider expansion,
incremental indexing and qualification without external review remain separate future outcomes.

Preserve successful inputs, existing evidence attribution and the deliberate
`INDEX_BINDING_ADMISSIBILITY` recovery contract. Tighten boundary validation and failure reporting
without adding a service, dependency, generic executor or new authority. Keep CocoIndex optional;
retain its existing capability and bound its execution rather than removing it.

## Contracts and compatibility

- Reading an uninitialized workspace refuses without creating `.semctx`; explicit initialization
  retains ownership of creation. Existing confinement remains enforced.
- Invalid semantic source is not formatted or overwritten. Corrupt active-change and handoff
  artifacts produce a named error; missing artifacts retain their documented absent state.
- The Action refuses unusable reports and unknown failure policies with exit 2. An unreadable
  guard input refuses with exit 2 only when blocking mode is established; advisory remains advisory.
- Unsealed or stale control inputs cannot authorize autonomous writes or successful traversal.
  Keep the separate verification/recovery admissibility table unchanged.
- Analyzer I/O failures and refused external source reads are visible failed producer outcomes.
  Preserve TypeScript libraries, types, resolution, symbols, JSDoc and cross-file calls for admitted
  inputs; report unsupported boundaries rather than silently dropping capabilities.
- Optional provider execution has a named time budget. Malformed output and execution failure
  remain distinguishable from a valid empty result. An absent optional provider remains optional.
- Reconciliation validates committed artifacts through the canonical existing schema and hash
  checks. Git capture distinguishes an unborn repository from a failed observation.

These are intentional rejection changes for inputs previously accepted unsafely. The minor
release documents them once. Existing valid versioned artifact bytes and formats remain unchanged;
do not rewrite historical capsules, loosen validators or relabel old proofs. If a frozen contract
requires a format change, stop that slice and specify its versioned transition before implementing.

## Evidence and delivery

Each affected guarantee has a focused negative case and restoration, with real process coverage
for process boundaries. Reuse existing nominal and transport parity tests. Regenerate bundles
from sources, then require the full local release gate, selected multi-OS CI, a fresh independent
aggregate proof review and the trusted N-1 proof gate on the exact candidate. No changed gate may
approve itself. Preserve raw refusals and limits. Publish through the existing annotated-tag
workflow, verify the public npm artifact and both fresh host profiles, then publish the reviewed
public replay. Installation does not prove activation in an already running session.

Rollback is the previous published 0.3.9 artifact and documented explicit installation of that
version. No destructive storage migration or registry/workflow trust change is included.
