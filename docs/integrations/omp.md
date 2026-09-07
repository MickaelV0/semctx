# Oh My Pi integration

**Experimental, opt-in.** OMP is a consumer of the existing Claude plugin tree (ADR 0015), not a
stable-proven delivery target: it has no `plugin-status` support and no `deliver` attestation.
Tracked in HOK-456.

`plugins/claude-code/` is an Agent-Plugins-standard plugin root: `plugin.json` (`$schema` exactly
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`) plus a schema-closed `mcp.json` at
that same root. Oh My Pi installs it through `.omp-plugin/marketplace.json`. The catalog entry
pins the plugin to `source: { source: "git-subdir", url: "https://github.com/hoklims/semctx.git", path: "plugins/claude-code", ref: "stable" }`
— the marketplace name (`semctx-stable`) is a label, not a Git pin; only `source.ref` keeps the
installed bytes off `main`. Claude `.mcp.json` placeholders are not used.

Skills and MCP are served by OMP's `agent-plugins` provider (priority 75). The commit/push guard
is served by `package.json#omp.extensions`. This works with `claude-plugins` **disabled** — the
operator standing configuration. The resulting MCP server id is `semctx:semctx`; on-wire tool
names stay `semctx_*`.

Verified on Oh My Pi **18.1.11**. Bun `>=1.3.14` on PATH.

Install is two commands, and the first is mandatory. OMP's `classifyInstallTarget` only treats
`name@marketplace` as a marketplace spec when that marketplace name is already registered
locally; otherwise it silently falls through to an npm spec and the install fails with a
confusing name error.

```bash
omp plugin marketplace add hoklims/semctx
omp plugin install semctx@semctx-stable
```

Then **restart** the session. `/reload-plugins` refreshes skills, commands and MCP but does **not**
re-import extension modules, so the guard factory will not load until a restart.

Every MCP tool call must pass an absolute `repositoryRoot`, except `semctx_control_verify_authorization`,
whose entire input is `{ request }` and which rejects `repositoryRoot`. Prefer MCP tools. For shell
fallbacks use a global CLI on the same version as the plugin (`semctx --version` / `bunx semctx@latest`).
Do not run `bun ./dist/semctx.js` from the user repository cwd.

OMP substitutes `${CLAUDE_PLUGIN_ROOT}` and its own `${OMP_PLUGIN_ROOT}` inside MCP server config
fields, but never inside skill/agent markdown body text — the Claude skill still contains a
literal, unsubstituted `${CLAUDE_PLUGIN_ROOT}` when read on OMP, so agents must prefer connected
MCP tools over that text.

## Migration from the retired B.3 mirror

The B.3 mirror `MickaelV0/semctx-plugin` (installed as package `semctx` via the git pipe) and the
marketplace install occupy the same `~/.omp/plugins/node_modules/semctx` path. This is a clobber,
not a coexistence.

1. `omp plugin uninstall semctx`
2. Verify the `"semctx"` key is gone from `~/.omp/plugins/package.json` (not just from
   `omp-plugins.lock.json`). A stale dependency key alongside a marketplace symlink is a
   half-state that `omp plugin list` / `doctor` hide.
3. `omp plugin marketplace add hoklims/semctx`
4. `omp plugin install semctx@semctx-stable`
5. Restart.

## Commit/push guard

OMP loads `plugins/claude-code/hooks/pre/semctx-guard.ts` (default export factory registering
`pi.on("tool_call")`). It calls the same ADR 0007 decision function as Claude's
`hooks/semctx-guard.mjs` — `evaluateBashGuard` — with OMP's `bash` and `hub` tool names (Claude uses
`Bash`). Advisory is the default: the hook is present but never blocks until the project opts in via
`.semctx/guard.json` `{ "enabled": true }` or `SEMCTX_GUARD=on`, which then blocks non-isolated
`git commit` / `git push` until the working state matches a recorded verification baseline.

Claude's `hooks/hooks.json` `PreToolUse` registration remains Claude-only; OMP does not read it.
`pluginCliPath` inside the shared guard resolves the bundled CLI from `OMP_PLUGIN_ROOT` (after
`CLAUDE_PLUGIN_ROOT`), then falls back to file-relative `dist/semctx.js`.

The shadow lifecycle observer in `hooks/hooks.json` stays a Claude/Codex surface (ADR 0015). OMP
loads `hooks/pre/semctx-lifecycle.ts` instead: `pi.on("tool_result")` observes Semctx MCP tools
under the minted prefix `mcp__semctx_semctx_`, and `pi.on("turn_end")` emits the same shadow
`before_completion` advisory on stderr. It never blocks.

### Coverage by execution surface

`evaluateBashGuard` returns `{ block: false }` for every tool name other than `bash` and `hub`
(`plugins/claude-code/hooks/semctx-guard.mjs`). A `hub` call is gated only when `op === "start"`;
`application` + `args` are synthesized into the same command string the bash predicates already
evaluate. Measured on a throwaway repository armed with `.semctx/guard.json`
`{ "enabled": true }`:

| Execution surface | Covered |
| --- | --- |
| `bash`, main agent, isolated `git commit` | yes — blocked with `no verification on record`, then allowed after `verify diff --record` (both directions observed) |
| `bash` issued by a subagent | yes — same block, `git log` unchanged |
| `cd <guarded repo> && git commit` from a session rooted elsewhere | yes — the `enabled` predicate also consults the session cwd, and a compound command fails isolation |
| `hub` `op: "start"` (`application` + `args` launched directly) | yes — same block and same allow path as `bash`; `cwd` is the process working directory (equivalent to a bash `cd` prefix) |
| `hub` `op: "restart"` | no — the tool_call payload is `{ op, name }` only; the retained spec lives in the broker and is not in the event. Auto-restart (`on-failure`/`always`) is broker-side of an already-admitted `start`. If `start` was blocked, nothing is retained to replay. |
| `eval` (`py` / `js` / `rb` / `jl`, e.g. `subprocess.run`) | no — commit created, exit 0 |

`eval` cannot be closed by widening a tool allowlist. Its per-call input schema is
`{ language, code }` with no `command` field (OMP's `packages/coding-agent/src/tools/eval.ts:108-112`),
so an allowlisted `eval` would reach the decision function with `command` empty and
`isTerminalGitCommand("")` false — no block, only a slower `{ block: false }`. Closing it for real
means analysing arbitrary source in four languages whose kernel state persists across calls
(`eval.ts:102-103`), which is not a predicate over a command string.

Operationally: on OMP the guard covers the shell an agent uses to commit, including its subagents,
and the `hub op:start` process launcher. It is still **not fail-closed** against `eval`. Read a
block as a real block, and the absence of one as no statement at all.

Claude carries the same bash predicate — `hooks/hooks.json` matches `"Bash"` — but exposes no code
execution kernel, so the remaining `eval` hole is theoretical there and reachable here.
