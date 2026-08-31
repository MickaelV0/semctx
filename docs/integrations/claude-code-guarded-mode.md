# Claude Code — guarded mode

Guarded mode makes the plugin's `PreToolUse` hook **block** `git commit` / `git push` until the
current analyzed content has been verified. It is **opt-in**; advisory is the default.

## How it works (ADR 0007)

```
you run:   semctx verify diff --record
             → analyses the diff, records { HEAD, analyzed-diff hash, content hash,
               repository-state hash, verdict } to
               .semctx/verification-state.json  (git-ignored, written atomically)

hook on `git commit` / `git push`:
   recapture paths + modes + bytes + canonical Git objects + HEAD tree
   ALLOW commit if the v3 content baseline matches AND recorded verdict != BLOCK
   ALLOW push only if HEAD also materializes that exact recorded repository state and the push
              source resolves to that verified HEAD only
   BLOCK  otherwise, printing the exact command to re-verify
           (an absolute `bun /…/dist/semctx.js …` when the plugin bundle is in reach,
            resolved by the hook — never a shell variable the agent would have to expand)
```

The hook does a **hash comparison, not an analysis** — it is fast and never re-runs the engine.
It parses the Bash command **structurally** (segments + tokens, never a shell eval) and gates
**only** the two terminal git verbs. It never blocks file edits, tests, exploration, or
non-terminal git commands.

## Enable

Create `.semctx/guard.json` in the project (see `plugins/claude-code/examples/guard.json`):

```json
{ "enabled": true }
```

## The loop

```bash
# ... make changes ...
semctx verify diff --record     # PASS/WARN → exact content may be committed; BLOCK → resolve first
git commit -m "..."             # the SHA may move when the resulting tree is exactly the verified state
git push                         # reuses that proof; a partial commit or later drift is blocked
```

Inside a Claude Code session the agent should prefer the plugin-bundled CLI (same release as MCP)
rather than a global install. It gets the absolute path two ways, both already resolved for it: the
`${CLAUDE_PLUGIN_ROOT}` placeholder that Claude Code substitutes into the skills at load time, and
the path the guard prints when it blocks. `CLAUDE_PLUGIN_ROOT` itself is exported to hook and MCP
processes only — it is **not** set in the agent's shell, so it must never appear unexpanded in a
command.

An exact commit is the expected HEAD movement and does not invalidate the baseline. Any byte, path,
mode, symlink target, partial commit, or non-ignored untracked change blocks the terminal operation
until you re-run `semctx verify diff --record` (or the plugin-CLI equivalent the guard prints).
Run `git commit` and `git push` as isolated commands in guarded mode. Compound commands,
redirections, and shell substitutions are rejected because they could mutate repository bytes
after the hook's pre-check. Cwd prefixes must use literal paths: unexpanded `$VAR`, `${VAR}`, `~`,
and globs in `cd` or `git -C` are rejected. Git repository retargeting is also outside the contract,
including `GIT_DIR` / `GIT_WORK_TREE` and related index, object, common-dir, namespace, or config
environment; `--git-dir`, `--work-tree`, `--namespace`, `--bare`; and `-c core.worktree` /
`-c core.bare`. Use a plain literal `cd <repo> && git commit`, `git -C <repo> commit`, or the
equivalent `push`. Direct `env` wrappers are parsed too: non-retargeting forms such as
`env GIT_AUTHOR_NAME=name git commit` remain in contract, while retargeting assignments,
environment clearing (`-i`), repository-affecting `-u` / `--unset`, `env -C` / `--chdir`, and
`env -S` / `--split-string` are rejected.
For push, use the current branch/HEAD only. Deletions, `--all`, `--mirror`, tag-wide pushes,
wildcards, multiple refspecs, configured remote push refspecs, and any source that does not resolve
to the verified HEAD are rejected.

## Disable

- **Strictly, at any time** (wins over `guard.json`): `SEMCTX_GUARD=off` in the environment.
- **Per project**: set `.semctx/guard.json` to `{ "enabled": false }`, or delete it.
- **Entirely**: remove the hook from the plugin install; advisory mode never blocks.

## Workflow guarantees and non-goals

- `BLOCK` is honoured: a recorded BLOCK verdict never satisfies the gate, even if the diff is
  unchanged.
- No false positive can block editing or testing — only command lines containing `git commit` /
  `git push` are gated, and guarded mode requires those operations to be isolated.
- The state file `.semctx/verification-state.json` is git-ignored and written atomically.
- Legacy version 1 and commit-bound version 2 baselines are non-authorizing and must be recreated
  with `--record`.

This is a cooperative soft gate, not a sandbox or hostile-agent boundary. The same local principal
can edit `verification-state.json`, set `SEMCTX_GUARD=off`, invoke Git outside Claude Code, or use a
command shape/tool the hook does not recognize. Detection covers direct Bash invocations plus common
quoted/path/`command` forms; compound commands and recognized `bash -c`, PowerShell, and `cmd /c`
wrappers are detected but rejected in guarded mode. Aliases, shell functions, and arbitrary
nesting remain outside the contract. Within recognized direct invocations, guarded isolation is
fail-closed for ambiguous cwd expansion and Git repository retargeting. A syntactically valid state
is still an authored assertion.
