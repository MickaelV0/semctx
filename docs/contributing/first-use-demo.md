# Run the packaged first-use demo

From this repository, with Bun >=1.4.0 and Git available:

```sh
bun install --frozen-lockfile
bun run cli:build
bun scripts/first-use-demo.ts --cli apps/cli/dist/index.js --out demo-evidence
```

Choose a new output directory for every run. Existing directories, symlinks and junctions are
rejected. The runner creates a disposable Git repository containing no authored Semctx declarations,
initializes it, applies three fixed changes, refreshes its index and verifies one combined diff.
No global CLI, repository mutation, plugin installation or network request is part of this runner.

Open `demo-evidence/report.md`. It shows the actual global verdict, per-file findings, suggested
next checks and every uncertainty returned by the analyzer. A required field added to an exported
interface demonstrates a structural warning. An incorrect discount demonstrates a limit: absence
of a finding does not prove that business behavior is correct, and adding a marker alone does not
test that behavior. The comment-only change still needs the repository's ordinary review/checks.

The JSON manifest and raw command outputs sit beside the report. They are local evidence and can
contain machine paths; publish only the dedicated public projection. The manifest records the exact
CLI and support-file digests, the runtime digest, reported package version, fixed fixture identities,
Git base and working-diff digest. The raw global verdict and real exit codes are never rewritten.
A genuine BLOCK (exit 3) remains a product outcome; malformed output and unexpected exits fail the run.
`COMPLETED` also requires every frozen case expectation to match and the fixture Git HEAD to remain
complete and unchanged; mismatches retain their raw output in a blocked run.

`--expect-digest SHA256` verifies a previously selected complete runtime digest before execution.
The runner verifies the artifact again afterward. `--source LABEL` is only an unverified caller
label. A digest proves byte identity, not authorship; authenticated source remains UNKNOWN until
external release provenance is checked separately. Use the exact extracted npm `dist/index.js` to
repeat this journey after release, keeping candidate and released-artifact records separate.

The same command works in a fresh Codex or Claude Code session without a plugin. It is a scripted
reproducibility example, not a study of independent maintainers. Adoption, retention and human time
remain NOT_MEASURED under the maintainer's explicit waiver of participant studies.
