# Run the packaged continuity demo

From this repository, with Bun >=1.4.0 and Git available:

```sh
bun install --frozen-lockfile
bun run cli:build
bun scripts/continuity-demo.ts --cli apps/cli/dist/index.js --out .tmp/continuity-demo
```

Choose a new output directory for every run. Existing directories, symlinks and junctions are
rejected. The runner creates its own Git repository under `<out>/fixture`, containing one small,
fixture-owned source file, discovers its coordinate through the packaged CLI's own public
`inspect` output, authors a tiny example goal and change contract for this fixture only (never
real-project intent), and then runs the same public command sequence a maintainer would run by
hand. The fixture and every JSON command input (under `<out>/inputs`) are retained after the run
for reproducibility and readback, alongside fixture-relative paths and byte digests for the
three base fixture files (`package.json`, `tsconfig.json`, and `src/capacity.ts`):

1. `task create` — turn a short task description into a persisted TaskFrame.
2. `control frame-task` then `control plan-change` — compile a versioned, non-authorizing
   PlanningBundle (`executionAuthority: "none"`) from the discovered coordinate.
3. `control reconcile-diff` — a real, read-only reconciliation verdict taken *before* any edit
   exists. This demo deliberately never performs the planned edit, so the honest verdict here is
   not `REALIZED` — that is a real product finding about missing work, not a bug in this demo.
4. `control handoff` — capture a Control Handoff v2 capsule of that exact state.
5. `control handoff explain --hash <capsule>` — explain the capsule's dependencies while the
   worktree still matches it (`APPLICABLE`).
6. A controlled, in-place mutation of the fixture's source file (never committed).
7. `control handoff explain --hash <capsule>` again — the same capsule, now honestly reported as
   `STALE` on its `diff` dependency.
8. `control resume-handoff <capsule>` — a real `REFUSED` resume (`HANDOFF_DIFF_STALE`, exit 3):
   resuming stale state is refused, not silently accepted.
9. The mutated source is restored to its exact original bytes, and the demo proves the immutable
   capsule record's bytes never changed across steps 4-8.

Open `.tmp/continuity-demo/report.md` for a concise summary, or `continuity-demo-manifest.json`
for the recorded machine-readable facts (coordinate id, task/change ids, capsule hash, diff
dependency summaries, recorded exit codes). Complete dependency reports remain in the raw outputs.
For a completed run, stdout/stderr for all commands sit under `raw/`. A blocked run may retain
partial command evidence after an I/O failure; final safety facts are recorded when the output
destination remains writable.

## Limitations

- `gateAdmission: NOT_EVALUATED` and `executionAuthority: none` hold throughout: no step here
  authorizes or performs an autonomous write. See ADR 0027 for the full applicability model.
- This demo proves reproducibility and honest state reporting across a real capture/mutate/resume
  cycle. `independentUserPilot: NOT_MEASURED` is a fixed fact, not a measurement: it does not
  measure independent human comprehension, adoption, or release readiness.
- The example goal and change contract are fixture-only content this demo authors for itself;
  they are not a template for real project intent.
