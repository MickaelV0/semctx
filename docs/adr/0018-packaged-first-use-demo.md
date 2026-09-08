# ADR 0018: the first-use demo runs a frozen packaged CLI

Status: accepted for implementation by the maintainer-delegated Codex lead, 2026-09-08.
Sources: HOK-632, HOK-629, ROADMAP.md and docs/product/adoption-plan.md.

## Problem and user outcome

A TypeScript maintainer needs to see a useful risk, its source, an appropriate next check and
the limits of the advice without writing authored declarations or installing agent plugins.
Existing examples use authored markers and do not provide a frozen, three-case execution record.
The first-use journey must also make failed setup and inconclusive analysis observable.

## Decision and boundary

Add a small redistributable TypeScript fixture with three fixed changes: benign, exported-contract
risk and an explicitly unsupported or otherwise unproven case. The fixture contains no authored
Semctx markers. Reuse existing CLI init/index/verify commands, analysis and policy semantics.
A tracked Bun runner invokes an explicitly selected packaged CLI from a fresh temporary Git
repository. It must not silently select a global CLI, download a package, change user repositories,
install plugins or disable configured gates. The caller explicitly chooses the output directory;
output must be new: reject every existing destination, including empty directories and symbolic
links or junctions, before writing. No force/replacement option is needed for this journey.

The demo has a separate versioned manifest/report. It records package version, executable and
support-file digests, available source/build provenance, fixed fixture content identities, Git
base/head identities, exact argument vectors, real process status and captured outputs. Missing
source provenance remains unknown; a caller-supplied source string is not a verified build binding.
Pilot packaging must freeze and verify the complete executable artifact before scored use.

A concise rendered view is derived from captured reports and explicitly labelled fixture metadata.
It explains what changed, the observed risk, the next check and uncertainty. Do not rewrite a PASS
into a product WARN or fabricate findings. An unsupported case may demonstrate a limitation even
when the current product returns PASS; the view must preserve that raw verdict and disclose the
unsupported scope. Static test links are suggestions, not coverage or successful execution.
Raw text and JSON captures stay available beside the summary.

A single combined diff may exercise all three changes if it is explicitly labelled as one analysis;
its global verdict must never be presented as three independent file verdicts. Preserve and render
the product's unknowns, including stale-index limitations, and match the exact changed-file set.
Use `setup` as the existing composed initialization/indexing entrypoint. After applying the fixed
changes, refresh the index before verification and retain any remaining uncertainty verbatim.
Digest the complete packaged runtime (including TypeScript support libraries) before and after
execution. Source authenticity stays UNKNOWN unless separately proven; a structurally valid
substitute is not authenticated by its self-reported version or a caller-supplied label.

## Compatibility, failure and authority

Existing CLI/MCP JSON schemas, exit codes, policy defaults, host support and generated plugins do
not change in this slice. The demo is a separate opt-in tool and grants no execution authority.
Failure states distinguish unavailable/incompatible package, malformed output, child failure,
unexpected verdict/fixture identity and incomplete run. No missing case is reported as success.
All temporary mutations stay in runner-created directories with checked cleanup boundaries.
The original repository and caller's existing output/configuration are preserved.

## Proof and rollout

Exercise all three cases through the real packaged CLI on supported operating systems. Tests must
reject a substituted/no-op CLI, missing or malformed reports, changed fixture/artifact identities,
nonzero unexpected child exits and unsafe output/cleanup paths. Preserve raw evidence, exact
versions and timings; distinguish setup/download from execution. Use the existing canonical
verify:pr and CI gates. No additional service or dependency is required.

Author fixtures and automated checks prove reproducibility, not independent usefulness or adoption.
HOK-633 pilots freeze their own protocol and labels before scoring and retain unsuccessful runs.
After release, rerun the demo against the exact release package and retain both identities.
Behavioral changes require new affected measurements. Rollback removes the additive demo tool;
it cannot alter an installed Semctx gate or its persisted state.
