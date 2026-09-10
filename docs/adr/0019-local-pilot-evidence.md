# ADR 0019: local pilot evidence remains distinct from human adoption

Status: accepted for implementation by the maintainer-delegated Codex lead, 2026-09-08.
Sources: HOK-633, HOK-629, HOK-637 and the maintainer's latest explicit instruction.

## Authority update

The maintainer chose the complete v0.2, then explicitly declined recruiting volunteers:
"rien de prevu et on va s'en passer". Five independent maintainer sessions, two contributor
sessions and fourteen-day human follow-up are no longer v0.2 publication gates. Preserve the
historical protocol as proposed research, not a completed or failed human experiment. Do not
recruit, send invitations, schedule human follow-up or synthesize participant observations.
Adoption, retention and human time-to-next-check remain NOT_MEASURED. This changes release scope,
not P4, execution authority or the validity of an automated score.

## Decision

Provide an opt-in local Bun pilot tool with strict versioned JSON inputs and deterministic
validation/reporting, without new dependencies. A draft protocol can be prepared and inspected;
freezing requires explicit immutable package/runtime/runner/source identities, corpus identities,
selection rules, budgets and baseline definitions. Freezing emits a new immutable digest-bound
protocol file; it never rewrites one. Post-freeze changes create a new experiment identity.

The impact manifest targets at least thirty real changes in three independent redistributable
repositories. Each case binds repository identity/license/source, exact Git base/head, development
or held-out role, and expected files/risk labels where independently established. Labels can be
UNKNOWN; unknowns must never become negatives. The development demo is not independent impact
evidence. The two baselines are changed-files-only and a declared bounded import neighborhood.
Do not infer human effort from subprocess runtime.

A result bundle must name every registered case, the exact protocol/corpus/artifact/configuration
identities, commands, integer exit codes, timing and output digests for Semctx and both baselines.
Failed executions are observed failures retained in the denominator; a missing case or mismatched
identity is invalid evidence. Adjudication is independently identified and records whether the
source is human, externally published evidence, independent automated review or unknown. Automated
adjudication is never presented as a human pilot. Raw evidence and disagreements remain available.

Compute both baselines on the pristine disposable checkout before running the candidate. Bind
their algorithm, captured Git/source input and suggestion output identities. At each candidate
command boundary, require the frozen HEAD, tree, tracked bytes, index entries (stage, mode, object
ID and path), and `assume-unchanged`/`skip-worktree` flags to remain intact, apart from the exact
canonical `.gitignore` transformation. This identity deliberately excludes the `fsmonitor-valid`
cache bit and byte-for-byte equality of the raw Git index file. Permit confined Semctx metadata,
but reject foreign source additions. A persistent mismatch stays observed as `SOURCE_DRIFT`, with
no trusted verdict and with its raw invocations retained. These are process-boundary checks, not a
sandbox against changes made and fully restored within one child.

Offline validation recomputes captured stdout/stderr and baseline output digests and requires the
changed-files baseline to equal the canonical captured changed-file set. Digests establish content
coherence; they do not authenticate a wholesale rewrite of the raw bundle or independently prove
the import-neighborhood algorithm without its source inputs.

Reports distinguish EVIDENCE_MISSING, INCONCLUSIVE, NEGATIVE and POSITIVE. No score is produced for
incomplete or incoherent input. Score only applicable adjudicated cases, display all denominators,
unknowns and exclusions, and report per-repository results and critical misses. The proposed 80%
precision and no-worse critical recall criteria may be computed only with sufficient bound labels.
The proposed 20% human-time improvement, 4/5 activation and 3/5 return targets stay NOT_MEASURED in
an automated run. A no-op analyzer is an invalid success witness: a known positive fixture must
detect it before accepting the scorer. Test fixtures remain tests, not research results.

## Privacy, persistence and failure

All data stays local until an explicit export. Public summaries use an allowlist: schema/version,
aggregate counts, finite durations, bounded status/reason codes and explicitly public source
identities. Do not export arbitrary text, paths, prompts, environment, contact identities or raw
logs. Unknown fields in governed inputs are rejected. Public source links require an explicit
public corpus declaration; private corpus identity is replaced by an experiment-local alias.
The tool neither uploads nor deletes data automatically. Document manual removal and a suggested
thirty-day review of raw evidence after an experiment ends; retain approved public results with
the release. Preview performs no write. Export refuses existing destinations and unsafe paths.

## Compatibility and validation

This is additive research tooling, not a new Semctx authority or a change to CLI/MCP schemas,
policies, release workflows or supported hosts. Source/runtime and release identities remain
separate. A later behavioral change invalidates affected measurements; version-only changes need
explicit artifact comparison. No generated plugins are required for this standalone slice.

Tests must reject modified frozen input, duplicate/missing cases, wrong artifact/source/config,
boolean exit codes, malformed/non-finite times, no-op scorer/analyzer evidence, unknown-to-negative
collapse and private data in exports. Execute the real tool with synthetic data labelled as such;
then record real public corpus runs separately. The existing verify:pr and CI gates remain required.
