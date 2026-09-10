# ADR 0022: contributor checks are explicit and cannot replace verify:pr

Status: accepted for implementation by the maintainer-delegated Codex lead, 2026-09-08.
Sources: HOK-637, HOK-642, HOK-643, CONTRIBUTING.md and ADR 0013.

## Outcome

A contributor starting from a clean clone can inspect prerequisites, run an actual relevant test,
understand the scope of that result and prepare the mandatory complete verification without private
configuration or global plugins. Reuse Bun, existing Python quality tools, fixtures and verify:pr.
The maintainer waived external contributor recruitment; publish automated clean-clone evidence and
keep independent human completion/time claims NOT_MEASURED.

## Decision

Add one portable Bun entrypoint scripts/contributor.ts. Default/inspect is read-only: identify the
repository, product Bun requirement, installed JS dependencies and contributor-only Python quality
tools from existing manifests/requirements. Print precise absent/incompatible/missing-dependency/
failed-command diagnoses and the existing recovery commands. Bun must exist to run a Bun helper;
document that bootstrap prerequisite explicitly instead of claiming self-diagnosis without a runtime.
No automatic package installation, configuration replacement, Docker requirement or network call.

An explicit check operation accepts a small named scope mapped to existing real package tests.
Print the exact argv, covered scope and omitted checks before execution, propagate the actual
child status, and record monotonic durations/tool versions. No extensionless node_modules shims:
invoke maintained scripts through Bun or known JavaScript executable entrypoints. Never interpret
opening a document or an empty successful process as tool-specific proof. An unknown, cross-cutting
or uncertain scope points to the full gate; targeted success cannot be labelled complete verification.

Use one documented existing core-package regression example with a before/after test and an isolated
temporary witness. Do not mutate a contributor's sources automatically or fake a red test by throwing
an unrelated error. Keep the example bound to a real owning function/test, and report setup time,
time to first relevant result and full-gate time separately. A future speed target must be fixed
after a measured baseline and before optimization; this helper promises clarity, not an unmeasured gain.

The full operation invokes the existing canonical verify:pr unchanged. Generated plugin checks,
all required tests, source hygiene, typecheck and linters stay mandatory before a PR. No skips,
new runner, changed test semantics, global environment mutation or verification-authority change.
Optional machine output is a separate contributor_check schema version 1 with commands, scope,
statuses, finite durations, versions and explicit incomplete/full classification. It is a local
developer diagnostic, not a safe public export; use the separate support-report privacy surface
for sharing environment details.

## Evidence and failure

Test absent/incompatible tools, missing dependencies, failed and falsely successful child commands,
unknown scope, targeted omission disclosure, full-gate invocation and exact exit propagation.
Exercise a real targeted check from a fresh Windows/Linux/macOS clone via the existing CI matrix.
Preserve raw timings and identify download/setup separately. A selected test's success cannot
prove the selector is complete. Use red/green witnesses for omission and generated-drift detection
without changing the trusted verify:pr gate. The helper is additive and removable independently.
