# A contributor's first check

Start from a clean clone. Install Bun first: the helper itself runs on Bun, so it cannot diagnose
a machine with no Bun interpreter. The product minimum is declared in `apps/cli/package.json`;
use the repository's documented contributor tool versions in `CONTRIBUTING.md` for reproducible builds.
Then run `bun install --frozen-lockfile`. Python and `requirements-quality.txt` are contributor
quality prerequisites, not requirements to use the packaged Semctx CLI. Install them in a local
virtual environment and put that environment's executables on your process PATH.

```sh
bun scripts/contributor.ts inspect
bun scripts/contributor.ts check core
bun scripts/contributor.ts recipe
bun scripts/contributor.ts full
```

`inspect` is the default and only reads local prerequisites. It reports the running Bun version,
installed root development package manifests, Python's actual version response and the exact Ruff
and zizmor pins. Presence of selected packages is not proof that every installed byte matches the lockfile.
Missing, incompatible and failed probes stay visible. The helper never installs tools, calls a hosted
service, changes configuration, or requires a global plugin or Docker.

Choose `check core`, `check app-services` or `check mcp-server` to execute the corresponding existing
package tests. The helper prints the command, observed test count, duration and omitted gates. An
unknown or cross-cutting scope needs full verification. An exit code of zero with no Bun test summary
is rejected. A targeted success does not claim source coverage or replace `bun run verify:pr`.

`recipe` copies the real `symbolId` implementation and its existing scope-qualified identity test
into an owned temporary directory. It changes the scope separator from `.` to `#`, requires the
specific assertion to fail, restores the copied source, and requires that test to pass. Setup, red
and green timings are separate. Cleanup runs even when setup or execution fails. Your checkout is
never mutated by the recipe.

`full` delegates to the unchanged `scripts/verify-pr.ts`. Optional `--base REF` is passed through;
`--skip-diff` is rejected because it cannot establish complete verification. Stage intended new files
first, as the canonical gate rejects non-ignored untracked files. All required quality checks and
tests remain mandatory before opening or updating a PR.

Every mode supports `--json` for a versioned `contributor_check` record. Full-gate logs go to stderr
in that mode; stdout remains JSON. These diagnostics are local and may expose private paths or
errors. Use the dedicated `semctx support` report for sharing, and inspect any file before publishing it.
Only a successful full gate reports `verification: full`. Human completion time, ease of use and
retention are **NOT_MEASURED**; the maintainer waived external participant studies. No speed gain is claimed.
