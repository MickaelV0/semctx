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

This workflow requires write access to the upstream repository so child PRs can target
parent branches there. With a fork and no upstream write access, submit the trunk-based PR
first, wait for it to merge, then rebase and submit the next change. git-spice's
[fork workflow](https://abhinav.github.io/git-spice/guide/cr/#fork-workflows) pushes dependent
branches but creates PRs only for branches based directly on trunk.

## Working with agents

[AGENTS.md](../../AGENTS.md) gives Codex the repository workflow at task startup;
[CLAUDE.md](../../CLAUDE.md) imports the same instructions for Claude Code. Start a fresh
session on a checkout containing these files so its instruction loader can discover them.
An existing session or worktree on an older commit does not acquire the new guidance merely
because a PR was merged elsewhere.

During an active task, the agent chooses useful dependent slices, creates and updates their
PRs, runs checks, and invokes restacking when needed. It reports the linked PRs and blockers.
If the user's request includes merging, it continues through the stack in order after each
required check; otherwise it leaves the requested reviewable result. Existing authorization
persists without another routine confirmation.

GitHub runs CI after publication. git-spice manages relationships and navigation when the
agent invokes it; installing it does not start a background worker. An idle or closed agent
session does not keep restacking or merging. The human sees smaller linked diffs, draft
children waiting for their parents, and check results for each PR. Conflicts or missing
decisions that the agent cannot resolve remain visible blockers.

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
Run git-spice from the worktree directory, including in automation. In 0.32.0, configuration
is [loaded before the `-C` directory flag is applied](https://github.com/abhinav/git-spice/blob/v0.32.0/main.go#L147),
so using `-C` from outside the repository can miss these defaults. After publishing, confirm
the draft state and base with `gh pr view PR_NUMBER --json isDraft,baseRefName,headRefOid`.

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
git-spice repo sync --restack=none
git worktree add --no-track -b feat/parser ../semctx-parser origin/main
cd ../semctx-parser
git-spice branch track --base main
```

Sync refreshes the local trunk before the new branch is tracked against it. Fetching alone
refreshes `origin/main` but can leave the local `main` branch behind.

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
run `git-spice branch submit --no-draft`. Read the current remote base and head explicitly:

```sh
gh pr view PR_NUMBER --json baseRefName,headRefOid,isDraft
```

Require `baseRefName` to be `main`, wait for the selected `semctx-required` check on that
`headRefOid`, and resolve review conversations.

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
