# Stacked pull requests

Use a stack when a change depends on another unmerged change. Keep independent changes in
separate PRs against `main`. A small stack makes each review show only its own changes:

```text
main <- feat/parser <- feat/engine <- feat/cli
         PR 1          PR 2          PR 3
```

Semctx uses [git-spice](https://abhinav.github.io/git-spice/) for branch relationships and
restacking, and GitHub CLI (`gh`) for inspecting checks and merging an exact commit.
The setup below was exercised with git-spice **0.32.0** on Windows. It needs no additional
GitHub App or hosted stacking service. This is optional contributor tooling, not a product
dependency.

## Set up a clone

Install Git, `gh`, and git-spice from its [official installation instructions](https://abhinav.github.io/git-spice/start/install/).
Check `git-spice --version` and `gh auth status`. Run these commands inside the clone:

```sh
git-spice repo init --trunk main --remote origin
git-spice auth login
```

Choose **GitHub CLI** in the login prompt to reuse your existing `gh` session. Do not put
tokens in Git configuration or tracked files. For a fork, use the upstream and push remotes
described in the [submission guide](https://abhinav.github.io/git-spice/guide/cr/).

Apply these defaults to this clone. `--local` settings and git-spice metadata are shared by
its linked worktrees; other repositories are unaffected. A fresh clone needs its own setup.

```sh
git config --local spice.submit.draft true
git config --local spice.submit.navigationComment multiple
git config --local spice.submit.navigationCommentSync downstack
git config --local spice.submit.navigationCommentStyle.layout simple
git config --local spice.submit.navigationComment.trunkComparison top
git config --local spice.submit.skipRestackCheck never
git config --local spice.repoSync.restack none
git config --local spice.repoSync.detachWorktrees false
git config --local spice.repoSync.closedChanges ignore
git config --local spice.branchCreate.commit false
git config --local spice.commitCreate.restack none
git config --local spice.commitAmend.restack none
git-spice repo sync --restack=none
```

New PRs start as drafts. Navigation comments link the stack, including a comparison against
trunk at its top. Submission refuses a stack that needs restacking. Sync updates trunk and
stack relationships without implicitly rebasing branches or detaching other worktrees.
Commits and restacks remain separate, explicit operations.
See the [configuration reference](https://abhinav.github.io/git-spice/cli/config/).

## Give each stack one worktree and one author

Keep every branch of one stack in a dedicated worktree, switching branches there. Other
authors can work on independent stacks in other worktrees. Do not edit or restack the same
stack concurrently. A reviewer can inspect a frozen commit in a detached worktree.

From an existing clone, create a worktree for the first branch:

```sh
git fetch origin main
git worktree add --no-track -b feat/parser ../semctx-parser origin/main
cd ../semctx-parser
git-spice branch track --base main
```

`--no-track` prevents the new branch from inheriting `origin/main` as its push upstream.
If an existing topic branch already tracks `origin/main`, run `git branch --unset-upstream`
on that topic branch before submitting it. git-spice refuses to push a topic onto trunk.

Make and commit the parser change using the repository's normal commit conventions. Then
create its dependent branch:

```sh
git-spice branch create feat/engine --no-commit
```

Commit the engine change there. Repeat for another dependent branch only when needed.
For existing branches, use `git-spice branch track --base PARENT_BRANCH` with the actual
parent; do not import unrelated or historical branches into the stack.

## Check and publish

Run affected local checks on each branch. Inspect the CI plan with the immediate parent as
its base; for `feat/engine`:

```sh
SEMCTX_VERIFY_BASE=feat/parser bun scripts/ci-plan.ts
```

That environment assignment uses POSIX shell syntax. In PowerShell, set
`$env:SEMCTX_VERIFY_BASE = 'feat/parser'`, run `bun scripts/ci-plan.ts`, then
`Remove-Item Env:SEMCTX_VERIFY_BASE` (restore its previous value if one was already set).
When the complete local gate is needed under [CONTRIBUTING](../../CONTRIBUTING.md), select
the same base explicitly:

```sh
bun run verify:pr -- --base feat/parser
```

CI already runs for PRs targeting parent branches. Its planner uses the PR base SHA and
checks out the PR head. A child check covers that child against its parent; it does not
approve the whole stack for merging into `main`.

Preview before publishing:

```sh
git-spice stack submit --dry-run --fill
git-spice stack submit --fill
git-spice log short
```

Use `--fill` only when the commit messages supply a suitable PR description. Complete the
repository PR template for every PR, including its own validation and governing sources.
Each PR targets its immediate parent branch. Publish from the local authenticated session
so branch pushes trigger the existing CI normally.

## Amend, restack, and merge from the bottom

After changing a lower branch, commit the correction, then run `git-spice stack restack` in
the stack's worktree. Resolve conflicts explicitly; `git-spice rebase continue` resumes and
`git-spice rebase abort` cancels the current rebase. Recheck the changed branches before
`git-spice stack submit --update-only` pushes their new commits.

Only merge a PR whose current base is `main`. Keep dependent PRs in draft until their parent
has merged and they have been restacked. To make just the bottom PR ready, switch to it and
run `git-spice branch submit --no-draft`. Confirm its base and SHA with `gh pr view`, wait for
the selected `semctx-required` check on that SHA, and resolve review conversations.

Use the repository's chosen merge method and bind the operation to the inspected head, for
example `gh pr merge PR_NUMBER --merge --match-head-commit HEAD_SHA`. Never bypass branch
protection. The protected `main` rules remain authoritative; a green child PR is not a
reason to merge it into its unprotected parent branch.

After the bottom PR merges, switch to a remaining child in the same stack and run:

```sh
git-spice repo sync --restack=none
git-spice stack restack
```

Recheck the remaining branches, then submit with `git-spice stack submit --update-only`.
Inspect their remote bases and obtain CI on the new SHAs before merging the next bottom PR.
This also applies after squash merges. Rebased commits invalidate evidence bound to the old
SHA; preserve the distinction between local checks, CI, review, and merge.

If a stack was split across worktrees, `stack restack` skips branches checked out elsewhere
and their descendants. Coordinate with each owner and run `git-spice branch restack` inside
each owning worktree, from parent to child. Do not enable automatic worktree detachment or
force a remote update over another author's work. Inspect `git-spice log short --all` and
`git worktree list` when a branch appears to have been skipped.
