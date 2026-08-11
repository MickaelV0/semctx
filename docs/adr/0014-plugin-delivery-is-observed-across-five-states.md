# ADR 0014 — Plugin delivery is observed across five distinct states

- Status: accepted
- Date: 2026-08-10
- Issue: [#89](https://github.com/hoklims/semctx/issues/89)

## Context

Semctx ships a CLI and two host plugins in lockstep, but they reach a user through different
channels. `main` is the development branch. The tag workflow publishes npm, advances the
automation-owned `stable` branch to that exact commit, then creates the GitHub Release
(`docs/publishing.md`). Both installers register their marketplace against `stable`, never `main`.

Nothing exposed the resulting gap. `semctx install` already treats the marketplace snapshot, the
installed cache, and the version a running session loaded as three distinct states (#91), but the
two channel-level states above it were invisible, so "merged on `main`" could be read as "installed
and active".

The failure is not hypothetical and it is not detectable by a version number. Measured on
2026-08-10: `main` was at `1acf1f14…` and `stable` at `0173f893…` while **both declared `0.1.17`**.
A comparison on SemVer alone reports convergence; a comparison on commit does not.

Three constraints bound any solution.

The first is that the diagnostic must not mutate user plugin state (issue #89 non-goals).

The second is that no network call may happen behind a user's back. The rule Semctx holds — README
"Determinism & honesty", ADR 0001, ADR 0002, ADR 0004, ADR 0012 — is that a command performs no
network access *unless the user asked for it by name*. The default of this command therefore
resolves the release from already-fetched local evidence or reports it as unknown, and performs
zero network egress; `--attest` is the single, named opt-in that leaves the machine. Stating the
rule this way is what lets the exception exist without contradicting it: the invariant is "never
implicitly", not "never".

The third is that whatever answers "what is the public release" must be an authority a consumer
project cannot impersonate. This is the constraint that decides the design. The inspected project
is untrusted input in every other layer of this report — its host CLIs, its reported paths, its
strings — and it is no more trustworthy about the release. Its `origin` is a local name, its
`url.*.insteadOf` rewrites where that name resolves, its object store can hold forged or replaced
objects, and its promisor can answer a local read from a remote of its choosing. An attestation
built on any of those proves only that the machine agrees with itself. It must also work at all
from a user's own project, which is not a semctx clone and holds none of the release's objects.

## Decision

Add one read-only, versioned report — `semctx plugin-status [--json]`, built by
`pluginDeliveryStatus` in `packages/app-services` — that names five states and never conflates them:

| state | evidence | authority |
| --- | --- | --- |
| repository checkout | `git rev-parse HEAD` in the working root | informative only |
| public `stable` release | a canonical authority's commit and version plus per-host immutable bundle digests, all from that one commit | the only channel that licenses `UP_TO_DATE` |
| marketplace snapshot | `.codex-marketplace-install.json`, else the snapshot checkout's `HEAD` | the approved source |
| installed cache | the versioned entry each host executes | what the next session resolves |
| session | only when a host exposes it | what a running session already loaded |

Rules:

- `schemaVersion` is an integer and `kind` is `plugin_delivery_status`. Within a major version,
  changes are additive only, per ADR 0008.
- **`UP_TO_DATE` requires the executed cache to be proven equal to the public `stable` release.**
  Repository state contributes nothing; `repository.conveysDelivery` is the literal `false` so the
  invariant is part of the contract rather than a comment.
- **A version string is not proof of content.** The cache manifest carries only a version, and a
  locked entry keeps its old bytes under an unchanged version-keyed directory — the exact state
  `semctx install` had to defend against in #92. The snapshot and cache are therefore compared by
  SHA-256 of every runtime bundle against an immutable witness from the attested release commit;
  comparing cache only to a mutable snapshot would let jointly altered bytes impersonate stable.
  Missing proof stays unknown and differing proof is update available.
- **Host-reported paths are untrusted input.** They are accepted only when local and confined to
  that host's own canonical home. UNC/device paths and symlink or junction escapes are refused
  before payload reads:
  reading `\\host\share` would open an SMB connection — network egress from a product path, a
  multi-second stall, and an NTLM authentication attempt — which ADR 0001/0002 forbid. Host strings
  are stripped of control characters and URL userinfo before entering the report, so a hostile host
  cannot repaint a terminal verdict and a private marketplace's token cannot leak into `--json`.
- `verdict` and `delivery` are separate dimensions and neither upgrades the other, the way index
  health keeps freshness separate from coverage. `delivery` answers "is the right code on disk";
  `verdict` additionally requires a proven session. Exit status follows `delivery` — `0`, `2`, `3`
  — because that is the dimension a caller can act on.
- The session version is **never inferred from the cache**. No supported host exposes it today, so
  it is reported as `unknown` with the host's activation action. An unproven session gap keeps
  `verdict` at `UNKNOWN` forever rather than letting it claim convergence.
- **Activation is its own dimension and the delivery authority cannot suppress it.** How a running
  session picks up what is already on disk is a different question from whether `stable` could be
  attested, so an unproven session keeps its exact action — a new Codex task, or `/reload-plugins`
  — even when delivery is `UNKNOWN`. Uncertainty still proposes nothing to *install*: `convergence`
  is emitted only for a proven divergence, and a host that failed before the session layer was
  reached proposes neither.
- Every unavailable, malformed, ambiguous, or partial input yields an explicit `UNKNOWN` with a
  canonical reason code. A requested but undetected host participates in that aggregate; only a
  host omitted from the request is excluded. There is no optimistic default anywhere.
- **Provenance is typed, not inferred from a string.** `publicRelease.authority` is one of
  `attested-release`, `local-mirror` or `absent`, and only `attested-release` can license
  `UP_TO_DATE`. A value this build does not recognise is reported as `unrecognised` and fails
  closed with `PUBLIC_RELEASE_AUTHORITY_UNKNOWN`; a probe that claims attestation while naming a
  mirror is self-contradictory and is refused as well.
- **Two provenances, and the caller chooses.** The default probe performs **zero network egress**:
  it reports the local `origin/stable` commit and version as `local-mirror` — useful evidence, but
  `unknown`, because a mirror cannot attest that no newer public release exists. It stops at commit
  and version deliberately: bundle witnesses could never license anything on this path, so reading
  megabytes of Git objects to compute digests that are then discarded would be cost without
  evidence.
- **The attestation's trust root is canonical, and it is a constant of the build.** `--attest`
  resolves `https://github.com/hoklims/semctx.git` — not `origin`, which is a name the inspected
  project controls. It runs in a throwaway bare repository created outside that project, with the
  ambient Git configuration *removed* rather than overridden: system, global and injected
  `GIT_CONFIG_*` are all severed, transport is pinned to `https`, and alternate object directories,
  replacement-ref bases and inherited Git directories are cleared. No `insteadOf` rewrite, forged
  object, replacement ref, promisor remote or consumer repository can therefore decide what the
  public release is. The inspected project contributes no release fact to this path; its root is
  passed only to keep the scratch directory outside the inspected tree.
- **Inherited environment is dropped as a namespace, not patched name by name.** Every Git
  subprocess runs with the whole `GIT_*` (and `GCM_*`) namespace removed from the inherited
  environment, after which each lane reintroduces only what it needs. Enumerating dangerous names
  was tried and was wrong: `GIT_CONFIG_PARAMETERS` alone re-injected an `insteadOf` rewrite that
  redirected a real `--attest`, and `GIT_SSL_NO_VERIFY`, `GIT_COMMON_DIR`, `GIT_EXEC_PATH`, the
  object/alternates variables and the `GIT_TRACE*` family — `GIT_TRACE_PACKFILE` writes a file to a
  caller-chosen path — each redirect configuration, transport, object lookup, helper resolution or
  output. The set grows with Git; the allowlist does not. Proxy routing remains available, but
  caller-selected CA bundles, TLS backends and TLS/QLOG output targets are removed: they can replace
  the trust root or write secrets outside the scratch directory.
- **What remains outside the boundary is named, not claimed away**: the `git` binary `PATH`
  resolves, the operating system, and the system certificate store that decides whether the
  canonical host is trusted.
- **The scratch location is validated before anything is created.** `os.tmpdir()` is whatever
  `TEMP`/`TMP` say, so the caller's environment chooses where this command writes. A relative base,
  a UNC or device path, or a base inside the inspected project or a host's own tree is refused
  up front with `PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED` — before the first directory exists,
  rather than cleaned up after. Both lexical and canonical targets are compared, so a symlink or
  Windows junction cannot alias a forbidden tree; creation uses the canonical base after the check.
  The inspected root reaches this check for that exclusion only; it never contributes to what the
  public release is.
- **Cleanup is performed, retried and then verified.** Removal is retried within a bounded window,
  because Windows can hold a just-exited Git process's handles, and the answer comes from looking
  for the directory rather than from the absence of an exception. Unexpected internal failures are
  normalized before that cleanup, so they cannot bypass it. A store that survives is a leaked copy
  of the release on disk, so it fails closed with `PUBLIC_RELEASE_SCRATCH_NOT_REMOVED` instead of
  returning a silently healthy attestation. No path appears in any reason.
- **The attestation transfers the release, because nothing weaker can prove it.** One
  `git fetch --depth=1` brings exactly one commit of the canonical repository into that scratch
  store; the version and every bundle witness are then read from those immutable objects with
  `cat-file`, which streams stored bytes with no filter and no end-of-line translation. A ref
  lookup alone would name a commit without proving its contents, and reading the contents from the
  consumer's own object store is precisely the trust the previous constraint forbids — so a
  self-contained proof requires the bytes.
- **That fetch is bounded by deadline, depth, process output and an acceptance ceiling — not by
  transferred bytes.** No Git transport option caps a pack, and `--depth=1` bounds ancestry rather
  than size: one commit carrying enormous blobs is still an unbounded download. What is bounded is
  acceptance — the store is measured after the fetch and refused with
  `PUBLIC_RELEASE_STORE_TOO_LARGE` before a single witness is read from it, and the cleanup runs.
  Calling this "byte-bounded" would be false. A server-side blob filter would be defence in depth,
  not a total-size proof, and is not claimed as one. Measured 2026-08-11, a real `stable` store is
  about 2.9 MB; that is a measurement with a date, not an invariant.
  Offline, timed out, malformed or unreachable attestation degrades to `absent` — never to a mirror
  silently wearing an attested label.
- **Witnesses are per host, and their agreement is proven rather than assumed.** Both plugins ship
  the same split runtime, but each ships its own copy: the release is read separately at
  `plugins/semctx-control/` and `plugins/claude-code/`, each plugin must declare the released
  version, and the two bundle records must be equal. Reading one and applying it to the other host
  would manufacture the cross-host equality the witnesses exist to establish; a release whose two
  payloads disagree is not one artifact and fails closed with
  `PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED`.
- **Artifact reads are bounded per artifact.** A host cache is untrusted input, so a local manifest
  or bundle past its ceiling is refused on the metadata of the very entry the confinement walk
  reached, not read and then judged. Release manifests and bundle blobs are checked against the same
  1 MiB and 16 MiB ceilings before they can become witnesses. Reads inside the inspected project
  ignore replacement objects, and a partial clone is refused outright rather than allowed to answer
  a "local" read with a silent promisor fetch.
- **Every probe is bounded, while it runs, and the output ceiling is a real total.** Each host and
  Git invocation carries a deterministic time budget and an output budget, enforced during
  execution so a flooding probe is killed at the limit rather than buffered whole and judged
  afterwards. The underlying spawn applies its ceiling to stdout and stderr *separately* — measured,
  not assumed: 3 MiB on each survives a 4 MiB `maxBuffer` — so the declared budget is halved per
  stream, which makes the total a bound by construction instead of a claim a two-stream flood
  refutes. Which limit fired is read from the reported cause, not guessed from the signal: both
  kills arrive as `SIGTERM`, so inferring would report every oversized probe as a timeout. A probe
  that exceeds either budget is refused whole rather than parsed as a prefix, and maps to the stable
  reasons `HOST_QUERY_TIMEOUT` and `HOST_OUTPUT_TOO_LARGE`.
- **A local artifact is read through one descriptor.** The confinement walk proves the path holds
  no link and stays inside the root, but its `stat` describes an object a later `open` is not
  guaranteed to reach. Each artifact is therefore opened once, and regular-file, size and read
  length are all decided from `fstat` on that descriptor and the bytes it yields, with one byte
  more than the ceiling requested so a file that grew is refused rather than hashed as a prefix.
  Residual limit, stated rather than promised away: this does not open with
  `FILE_FLAG_OPEN_REPARSE_POINT`, so a reparse point swapped in between the walk and the open is
  not portably detectable; the walk's link refusals and canonical confinement remain the defence
  against that.
- **Scope is explicit.** `--host auto|codex|claude|all`. `auto` asks what is installed on this
  machine, so a host that is absent is not part of the question and is omitted. Naming a host makes
  its absence part of the answer, keeping the aggregate `UNKNOWN`.
- **The read-only claim is scoped to delivery state and Semctx-owned writes.** The command never
  adds, updates, upgrades, removes, enables or promotes anything, never advances `stable`, and
  Semctx itself writes neither the inspected project nor host trees. It does invoke official host
  inventory commands; a host may maintain operational bookkeeping while answering them (Claude
  currently creates `.in_use` markers). Its default mode performs no network operation whatsoever
  — host inventory queries and local reads only. `--attest` does fetch, into a throwaway store
  outside the project. "Never fetches" and "the host tree stays byte-identical" are therefore not
  claimed; what holds is that nothing is fetched implicitly and no plugin state is mutated.
- Guidance emits the exact supported convergence path, identical to what `semctx install` performs:
  Codex `marketplace upgrade` then `plugin add`; Claude `marketplace update` then `plugin update
  --scope user`; then a new Codex task or `/reload-plugins`.

## Consequences

- "Merged on `main`" can no longer be mistaken for "delivered", and a same-SemVer divergence
  between `main` and `stable` is visible because commits are compared, not version strings.
- Without `--attest` the report says `UNKNOWN` even when snapshot and cache match the local mirror.
  That is the intended trade: an honest gap beats a false green. The local five-layer inventory
  remains available and names the missing authority, and `next` points at the flag that closes it.
- Attestation is the only network access this command can perform, and it happens only when asked
  for by name. The default remains zero-egress, so the "no implicit network call" rule is intact;
  the exception is a user-requested, non-mutating transfer into a scratch store, and it is named in
  the report's provenance.
- `--attest` costs one shallow transfer of the canonical repository and a scratch directory for the
  length of the command. The transfer is deadline-bounded but not byte-bounded; the completed store
  is capped at 256 MiB before witnesses are accepted. That is the price of a proof that stands on
  its own: cheaper attestations were available, and each one bought its cheapness by trusting
  something the inspected machine controls.
- A hermetic end-to-end test of the attested channel is no longer possible, and that is the point.
  Making a local repository able to answer as the canonical authority through production code is
  the defect this removes, so the suite proves the negative — that `insteadOf`, replacement refs,
  promisors, forged objects and foreign repositories cannot produce an attested release — while the
  positive is covered by the resolver's own decisions being asserted at the process seam, and by a
  real-network smoke.
- The session row stays `unknown` until a host exposes a loaded-plugin version. Adding that later
  is an additive change: the field and its reason code already exist.
- `main` does not become a release channel and `stable` still advances only through the verified
  tag workflow. This ADR adds observation, not delivery.
