# Working on Semctx

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Branches and delivery

- Keep independent changes in separate PRs against `main`.
- For dependent changes, follow the [stacked PR workflow](docs/contributing/stacked-prs.md).
  Use git-spice for the stack and `gh` for checks and exact-head merges.
- Give each stack one dedicated worktree and one author. Preserve unrelated work.
- Check the clone's setup before using git-spice. Run it from the worktree directory.
- Within the user's authorized task, handle branching, affected checks, draft publication,
  restacking and PR updates. These instructions do not themselves authorize merging,
  releasing or deploying.
- With merge authorization, merge from the bottom into `main`, then restack, republish and
  obtain fresh checks before the next merge. Honor authorization already given; do not ask
  again for routine steps. Never bypass branch protection or another author's ownership.
- Report the stack's PR links, current stage, check results and any blocker.
