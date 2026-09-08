# Impact pilot (HOK-633, ADR 0019)

Local, opt-in instrumentation that measures whether `semctx verify diff` and two simple baselines
agree with independently adjudicated ground truth on real historical changes. It never recruits
volunteers, never schedules human follow-up, and never synthesizes participant observations — see
[ADR 0019](../adr/0019-local-pilot-evidence.md). Human adoption, retention and time-to-check stay
`NOT_MEASURED` and are not gates for anything this tool produces.

Entry point: `bun scripts/impact-pilot.ts <draft|freeze|collect|report> [options]`.

## Pipeline

```
draft (inspect)  ->  freeze (immutable, digest-bound)  ->  collect (real local observations)  ->  report (validate/score/render)
```

Every stage after `draft` produces a file this tool refuses to overwrite. Changing anything about
a frozen protocol means writing a new draft and freezing a new file — there is no in-place edit.

### 1. `draft --input <draft.json> [--out <normalized.json>]`

Structural validation only — no filesystem identity is resolved yet. `draft.json` shape:

```jsonc
{
  "schemaVersion": 1,
  "candidate": { "packaging": "dist" }, // or "source-dev" for local iteration only
  "config": {
    "perCaseTimeoutMs": 60000,
    "baselines": ["changed-files", "one-hop-import-neighborhood"],
    "selection": { "rule": "...", "note": "..." }
  },
  "corpus": {
    "kind": "research", // or "synthetic-smoke" for test fixtures — never mixed
    "cases": [
      {
        "caseId": "repo-a-0001",
        "repositoryAlias": "public-alias-or-private-alias",
        "synthetic": false,
        "publicSource": { "url": "https://...", "license": "MIT" }, // or null
        "baseRef": "<40-hex commit>",
        "headRef": "<40-hex commit>",
        "changedFiles": ["src/example.ts"], // exact `git diff --name-only mergeBase headRef`
        "split": "dev", // or "held-out"
        "label": { "status": "UNKNOWN" }
        // or: { "status": "LABELLED", "provenance": "published-evidence" | "automated-review" | "human",
        //       "expectedImpactedFiles": ["..."], "criticalFiles": ["..."] }
      }
    ]
  }
}
```

A `research` corpus needs at least 30 cases across at least 3 distinct `repositoryAlias` values and
every case must have `synthetic: false`. A `synthetic-smoke` corpus is for tests only: every case
must have `synthetic: true`, and its results can never be reported as research evidence (see below).

### 2. `freeze --input <draft.json> --out <frozen.json>`

Resolves and locks: the candidate CLI's exact entry file digest and package identity (from
`apps/cli/dist/index.js` for `packaging: "dist"`, or `apps/cli/src/index.ts` for `"source-dev"`
local iteration), the Bun runtime version and executable digest, this runner's entry plus every
support module under `scripts/pilot/`, the exact TypeScript parser and report-schema runtime files,
the canonical `.gitignore` helper, and the full corpus.
Mints a fresh `experimentId` and computes a canonical digest over everything but that digest field.
`--out` must not already exist.

### 3. `collect --protocol <frozen.json> --sources <sources.json> --out <raw.json>`

`sources.json` maps each `caseId` to an **explicit local repository path** — never a URL, never
resolved automatically. Nothing is downloaded.

```jsonc
{ "schemaVersion": 1, "paths": { "repo-a-0001": "C:\\path\\to\\local\\checkout" } }
```

Before touching any case, `collect` recomputes the candidate's on-disk identity and refuses to run
if it no longer matches the frozen digest (a moved target needs a new frozen experiment, not a
silently different measurement). For each case it then, inside a disposable temp workspace:

1. `git clone --local --no-hardlinks --no-checkout` the declared source path (source path is only ever a clone
   *argument*, never a `cwd` — the source repository is never mutated).
2. Checks out `headRef`, confirms the resulting `HEAD`, confirms `baseRef` resolves, computes the
   real Git merge-base, and requires the observed `mergeBase..headRef` changed-file set to exactly
   match the frozen `changedFiles` list. The raw case binds the full merge-base and the canonical
   abbreviated range reported by the candidate.
3. Computes both baselines on the pristine checkout: changed-files-only, and a declared one-hop
   local import neighborhood (relative `import`/`export`/`import()` specifiers via the TypeScript
   parser, a syntactic proxy). Each result binds its algorithm, Git/source input and output digest.
4. Runs the candidate's `init`, `index`, and `verify diff --base <baseRef> --head <headRef> --format json`
   with unchanged default semantics (no `--fail-on none`, no global `semctx` lookup — the resolved
   entry path from the frozen protocol is invoked explicitly with the Bun runtime that is running
   the collector). Every invocation receives `--root <disposable-clone>`; inherited `SEMCTX_ROOT`
   is removed. Git system/global config, external diff drivers and hooks are disabled for collection.
   Exit 3 (BLOCK) is recorded, not hidden.
   Every captured stdout/stderr pair has a revalidated output digest. After each command, checks
   the frozen HEAD, tree, tracked bytes and index. Only the exact normal `.gitignore` transformation
   and confined `.semctx` metadata may be added; foreign source additions are refused.
5. Preserves any persistent drift as `SOURCE_DRIFT`, a null verdict and retained raw invocations,
   then cleans up the temp workspace, success or failure.

A case that cannot even be cloned/checked out is `FAILED` (infrastructure failure). A case whose
candidate run exits non-zero is still `OBSERVED` — the ADR requires observed tool failures to stay
in the denominator, never to quietly become "missing evidence". No corpus package script is ever
executed and no corpus dependency is ever installed. A malformed report, a
base/head/merge-base/range/diff mismatch, or a verdict/exit mismatch remains in raw evidence with a
bounded `verificationStatus`; it carries no trusted verdict or suggestions. Candidate and runner
digests are checked around candidate execution, so an artifact that changes during collection
aborts the experiment.

### 4. `report --protocol <frozen.json> --raw <raw.json> [--out <report.json>] [--export <public.json>] [--preview]`

Re-validates the frozen protocol's own digest, checks the raw bundle's `protocolDigest`/`experimentId`
match it, and checks the case set is exactly the registered one (no missing, no duplicate, no extra).
It also checks the observed Bun version and revalidates each trusted report against the
independently collected base, head, merge-base, canonical range and changed-file identity. Any
infrastructure-failed case or any observed Semctx run whose `verificationStatus` is not `TRUSTED`
makes evidence incomplete: the verdict is `EVIDENCE_MISSING` and no score is emitted. Totals expose
`failedCases` and `untrustedCases` separately, while the local raw bundle retains the underlying
outputs and reason code.
This is a coherence check over runner-observed local evidence, not a signature or an attestation:
the offline report step cannot authenticate an adversarial rewrite of the entire raw artifact.
It also checks baseline algorithm/input/output identities and requires changed-files suggestions
to equal the captured changed-file set. Earlier unpublished candidate captures lacking these
identity fields are rejected; freeze and collect a new experiment instead of rewriting old evidence.
Scores `semctx`, `changed-files`, and `one-hop-import-neighborhood` against every `LABELLED` case only
— `UNKNOWN` cases are excluded from scoring entirely, never treated as negatives. A `synthetic-smoke`
protocol's `evidenceKind` is always `"smoke"` and its verdict is always `EVIDENCE_MISSING`, regardless
of scores, so a fixture run can never be read as research evidence.

- No flags: prints the full local report (includes failure reasons; still local, not persisted).
- `--out <path>`: writes the full local report; refuses an existing path.
- `--preview`: prints the public-safe summary only — read-only, writes nothing.
- `--export <path>`: writes the public-safe summary; refuses an existing path.

The public summary is a strict allowlist (schema/version, counts, scores, bounded per-repository
totals, finite durations) built only from already-aggregated report fields — raw stdout/stderr,
failure-reason free text, and local filesystem paths have no code path into it. Critical-miss file
paths are included only for cases whose corpus entry declares an explicit `publicSource`.

## Retention

Everything collected stays local until an explicit `--export`. This tool never uploads and never
deletes saved evidence automatically; it does remove the disposable per-case clones it owns after
each collection attempt. Review raw collection bundles (`collect --out`) and full reports
(`report --out`) manually; a 30-day review of raw evidence after an experiment ends is suggested,
not enforced by the tool.

## Known limitation

Source checks observe state at each child-process boundary. They do not detect a mutation made
and fully restored inside one child and do not impose an operating-system sandbox.

`packaging: "source-dev"` hashes only the entry file and `apps/cli/package.json`, not its transitive
workspace dependencies. It is accepted only for `synthetic-smoke`; a `research` draft must use
`packaging: "dist"` against a built `apps/cli/dist/index.js`.
