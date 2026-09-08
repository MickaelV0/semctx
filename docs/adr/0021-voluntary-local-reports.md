# ADR 0021: voluntary feedback and support reports stay local

Status: accepted for implementation by the maintainer-delegated Codex lead, 2026-09-08.
Sources: HOK-645 and HOK-644. Human pilot observation was waived by the maintainer on this date.

## Outcome and scope

A user can record why an individual suggestion helped, was ignored, was unclear or appears wrong,
review/correct/delete that feedback, and explicitly export a sanitized aggregate. A user facing a
setup/index problem can preview a small shareable diagnostic without exposing their repository.
These opt-in CLI flows reuse existing reports and read-only diagnostics. No feedback or diagnostic
is uploaded, no issue is opened, and no policy, threshold, instruction or permission adapts itself.

## Layering and contracts

Add separate version-1 report schemas without changing existing VerifyReport, doctor JSON or MCP
tools. Pure validation/projection is reusable; app-services coordinates existing health/report
services and the local feedback store; CLI validates arguments and renders the complete service
result. Store operations follow repository-store ownership. Do not place orchestration in the CLI
or migrate unrelated legacy flows. Reuse existing Zod/Bun/Node tooling, no dependencies or service.

## Feedback lifecycle

Explicit recording accepts a parsed existing VerifyReport, a selected finding, one of useful,
ignored, unclear or suspected-error, and an optional bounded reason/note. It binds the report schema
and content digest, selected rule/finding and observed source scope locally. The feedback is an
opinion, not verified correction evidence. Missing feedback is absence, never approval or rejection.
The record key derives from the same report/finding identity. Repeated identical recording is
idempotent; a conflicting answer requires an explicit update operation. Explicit exact-ID removal
deletes only that record. Querying an absent store returns no records without creating anything.

The store is a versioned ignored file confined under the chosen repository's .semctx/feedback/;
it does not initialize or rewrite Semctx configuration. Validate the complete store before updates,
use atomic replacement and reject symlink/path escape, malformed data and unexpected schemas.
Preserve existing records on failure. Persist no extra hidden copy and provide the manual removal
path. Notes are bounded local text, never part of the default public export.

An interrupted process may leave a writer lock. Record its PID/start time for local diagnosis and
document explicit recovery only after confirming no writer is active. Do not reclaim a lock by
age or guessed process identity: unsafe concurrent reclamation can admit two writers. Reads still
work while locked. Loaded record IDs must be recomputed from their report/finding identities;
a syntactically valid but inconsistent ID makes the store corrupted, not a second valid record.

## Support and export privacy

The support report contains only schema/version, observed timestamp, Semctx/Bun versions,
platform/architecture and an allowlisted projection of existing workspace/config/index health.
Health status and fixed reason codes are useful; raw check detail/error messages are not safe.
Keep unavailable diagnostics UNKNOWN rather than replacing them with a healthy default.
Default exports omit source, prompts, environment, usernames, paths (including relative paths),
remote URLs, Git identities, arbitrary config, stacks, report prose, rule text and correlation IDs.
Do not call private host APIs or upload data to collect this report.

Default CLI actions preview on stdout and write nothing. An explicit output/export path writes
the same displayed sanitized payload to a new local file; refuse an existing destination or a
symlink. Feedback public output is aggregates with explicit total/known/absent counts and coded
outcomes/reasons; known standard rules may be named, custom rule text remains private. Unknown
input fields are rejected by the governed schemas. No free-form field is copied by default.
Local feedback list/show may expose the user's own record to that user, but is labelled private.

## Compatibility, failure and validation

Existing report schemas/commands, configured gates, plugins and automatic behavior retain their
meaning. New CLI subcommands are additive. Document preview, record, list/show, update, remove and
export with actual examples, failure recovery and local retention. Raw feedback is retained until
explicitly removed; recommend reviewing it after thirty days, without an automatic deletion daemon.

Required tests: real CLI dispatch; absent store is non-mutating; valid record and exact duplicate;
conflicting update; wrong report/finding; corrupted store; exact deletion without other-record loss;
atomic/error preservation; symlink escape; preview without writes; fake secrets/private paths in
all raw input and error channels absent from exports; unknown health remains unknown; observation
and report identity drift explicit. Run existing canonical verification and generated runtime parity
after integration. No human adoption, trustworthiness or efficiency claim follows from these tests.
