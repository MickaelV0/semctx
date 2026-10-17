# ADR 0031 — Select verification by the changed guarantee

- Status: accepted by the maintainer for the September 2026 gate reduction.
- Supersedes the fixed PR matrix and mandatory local full-gate clauses of ADR 0013 and ADR 0022.
- Keeps the release-source verification and publication authority of ADR 0013.
- The 2026-10-16 amendment below replaces the affected cross-OS suites and Ubuntu shard count;
  ADR 0037 owns their Rust execution and receipt admission.

## Context

PR #200 at `2267cbe8` completed its required CI in about 1 hour 55 minutes. Its final
Windows job spent about 32 minutes in `verify:pr`, then about 83 minutes in the repeated
24-by-100 worker benchmark. Ubuntu and macOS repeated the same full gate and benchmark.
The benchmark is observational: ADR 0026 applies no performance threshold and does not claim
that its measurements are comparable across hosts. Repeating it for every unrelated PR adds
latency without deciding an affected guarantee.

## Decision

`semctx-required` remains the single stable required result. An immutable, full-depth base-to-head
diff selects a matrix before verification. The matrix always contains an Ubuntu contract lane:
diff hygiene, compatibility and documentation checks, static quality, and CI-routing regressions.

- Markdown-only changes use the contract lane. Changes confined to the CI selector/runner also
  run its routing tests on Windows and macOS, without replaying the product suite.
- Product changes run the canonical complete `verify:pr` gate on Ubuntu. Windows and macOS run
  the test suites of each changed package, app or plugin. Generated plugin parity is checked
  again on these hosts when plugins change.
- Worker/indexing changes additionally run a real, small three-OS equivalence smoke using the
  existing benchmark protocol with dimensions 4 by 2. The full repeated 24-by-100 benchmark
  stays available on demand for performance claims and investigations; it is no longer a
  universal PR prerequisite.
- Unknown paths, new packages, missing test roots, invalid paths, empty or unavailable diffs,
  toolchain changes and release-workflow changes select the full three-OS gate plus the small
  equivalence smoke. A failed planner or matrix cannot produce a successful required result.

The matrix is built only from static lane names and test roots. A focused lane refuses an unknown
or absent target. `semctx-required` requires both the planner and every selected gate job to
finish with `success`; `skipped`, `cancelled`, and failed results are refusals. The selected profile
and each step's elapsed time appear in CI logs so routing and cost can be checked against a
particular SHA.

The local `verify:pr` command remains the complete oracle and the release workflow still runs it
on the tagged source before packaging. Contributors may use targeted local checks and the
required adaptive CI for ordinary PRs. A release, unknown impact, uncovered obligation or failed
targeted check calls for the full gate. Changed proof mechanisms also require a fresh independent
aggregate audit and relevant negative witnesses; the candidate's new selector cannot approve
itself.

## Validation and limits

Routing tests cover documentation, selector-only changes, product packages, workers, renames,
unknown paths, absent bases and missing test roots. Governance tests reject a missing planner
dependency, a skipped-gate acceptance and a disabled always-run aggregate. The release gate is
independent and unchanged. These tests establish routing behavior, not unexecuted runtime or
release efficacy. Measure the first candidate CI against PR #200 before claiming a speedup.

## Amendment — suite sharding and documentation figures (2026-10-11)

On 2026-10-11 the Windows full lane spent 1 812 s of its 34 minutes in one serial `bun test` run
(Ubuntu 652 s, macOS 617 s), and PR #321, which adds about fifty test files, exceeded the
60-minute job limit on Windows. Its pushes were cancelled before any run finished. PR #323, which
only touched the READMEs, their SVG figures and the landing page, still selected the full
three-OS gate because `README.fr.md` and `docs/assets/` were unclassified.

- `README.fr.md`, and SVG files under `docs/assets/`, are documentation. Other non-Markdown files
  under `docs/` (for example the pilot JSON data) remain unclassified and select the full gate.
- Every lane that runs the product suite (full lanes and affected focused lanes) is split by test
  file across a fixed number of runners per OS: Ubuntu 2, Windows 4, macOS 2. Each shard runs the
  lane's other commands unchanged and `bun test --shard=i/N` over its slice. Bun sorts the
  discovered files and assigns each to exactly one shard, so the shard set of one OS covers the
  same files as the unsharded command. `semctx-required` still requires every selected job.
- Shards balance by recorded duration (`--timings=scripts/ci-test-timings.json`, seeded from the
  Windows lane of run 38115625061). Round-robin by file count left the slowest Windows shard at
  767 s against 454 s when balanced by time. A file missing from the record counts as the median
  duration, so a stale record only unbalances the runners; it never drops a file. Refresh it
  with `bun test --timings=scripts/ci-test-timings.json --update-timings packages apps plugins scripts`.
- Files stay serial inside a runner. In-runner parallelism (`bun test --parallel`) was rejected:
  on Windows several guard tests already take 13–15 s of a 30 s budget and an MCP test 36 s of
  60 s, and a local four-worker run timed out four tests. Sharding keeps each test's host and
  timing margin as before.
- Routing-only focused lanes and the contract lane are not sharded.

The local `verify:pr` and the release gate still run every test file in one process. A
`--test-shard i/N` option narrows only their test step and is used only by CI lanes. Routing tests
pin complete shard sets for every planned suite lane, and the gate refuses a malformed shard or a
count other than its host's. The speedup is measured on the first candidate CI run, not assumed.

## Amendment — native OS boundaries and four Linux shards (2026-10-16)

Accepted through the maintainer's request to implement option C as a child of
[PR #383](https://github.com/hoklims/semctx/pull/383). The earlier OS selection and Ubuntu
shard counts above describe the previous policy.

For classifiable product changes, the Rust planner selects the complete Bun suite on four
Ubuntu shards and the explicitly configured OS-boundary files on two Windows shards and one
macOS shard. The contract lane remains separate. The list in
[`tools/gates/src/os_boundaries.rs`](../../tools/gates/src/os_boundaries.rs) contains 44 existing
files for filesystem paths and links, SQLite, Git/process lifecycle, workers, installation and
CLI/MCP/plugin transports. It is a maintained selection, not an exhaustive discovery of every
OS-sensitive behavior. The planner does not add future OS-sensitive tests automatically.
The complete semantic suite remains a Linux obligation; exhaustive semantic replay on Windows
and macOS is no longer an obligation for these classifiable changes.

Unknown impact, dependency manifests, toolchain changes, empty diffs, missing consumer targets,
and missing/non-file boundary targets retain the full fallback: four Ubuntu, four Windows and
two macOS shards. Shared plugin helpers still have consumers outside the manifest graph, so
changes under `plugins/` retain that fallback. No new source-path classifier is inferred from
test filenames. Documentation-only changes retain the contract lane.

Runtime integration checks and worker equivalence remain required once per OS. The independent
three-OS Rust tests and CLI/MCP qualification from ADR 0037 remain required. A shortened or
substituted boundary target list, missing shard receipt or failed selected test cannot satisfy
the existing aggregate. The local and release full commands retain the entire suite.

Ubuntu is configured to use `scripts/ci-test-timings-linux.json`; Windows and macOS retain
`scripts/ci-test-timings.json`. The Linux seed contains 369 whole-file durations from the Ubuntu
jobs of [run 38745549059](https://github.com/hoklims/semctx/actions/runs/38745549059), at
`0023d4b0862b5cde314dc2d977462d930ec0eafd` on 2026-10-15, Ubuntu 24.04.5 and Bun 1.4.3.
Durations were reconstructed between timestamped file headers and the final Bun summary;
each shard's sum differs from its reported test duration by less than 0.1 second. These are
historical scheduling weights, not timings measured on the Rust-gate candidate. Missing entries
retain [Bun's documented median estimate](https://bun.com/docs/test/parallel#balancing-with---timings)
and do not remove files. All shards of one OS read the same
committed timing file; no test-result cache or mutable in-flight timing update is introduced.

Validation uses the existing Rust planner/receipt tests and a real Bun subprocess witness:
configured test files execute, an intentionally failing package-boundary test refuses, and
restoration passes. Required CI must still run on the exact candidate. The earlier runtime
simulation predates PR #383's additional Rust build and qualification jobs; it is not a measured
latency guarantee for this stack or for fallback changes.
