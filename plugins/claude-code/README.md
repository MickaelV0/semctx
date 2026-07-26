# Semctx — Claude Code plugin

Give Claude Code the same proof-honest semctx workflow as Codex: reconstruct a change across
repository facts, authored intent and migration controls, then verify the resulting diff and real
runtime behaviour. The analysis is local and deterministic; semctx itself needs no LLM or network.

## What it installs

- **Repository MCP tools** (`.mcp.json`): `semctx_verify_change`, `semctx_inspect`, and the
  experimental `semctx_prepare_task` (not a code-search retriever; ADR 0005).
- **Semantic-layer tools**: `semctx_semantic_check`, `semctx_semantic_slice`, `semctx_change_open`,
  `semctx_change_update`, `semctx_change_verify`, `semctx_semantic_inspect`, `semctx_handoff`,
  `semctx_resume` — authored intent, invariants, decisions, evidence and unknowns (Plane B).
- **Control-plane tools**: read-only `semctx_control_status`, `semctx_control_trace`, and
  `semctx_control_plan` for freshness preflight, bounded L0-L6 reconstruction, and fail-closed
  migration planning (Plane C).
- **Bundled CLI** (`dist/semctx.js`): the full Bun CLI committed next to `dist/semctx-mcp.js` so a
  plugin update keeps agent MCP and CLI in lockstep. Agent sessions get its absolute path for free:
  Claude Code substitutes the `${CLAUDE_PLUGIN_ROOT}` placeholder into the skills at load time, and
  the guard hook prints a resolved path. The variable is exported to hooks and MCP servers, **not**
  to the agent's shell. A global `semctx` (`bun install -g semctx`) remains optional for CI and
  non-plugin shells.
- **Shared skill**: `skills/semctx-control` — host-neutral workflow body is byte-identical to Codex;
  the shell CLI ladder is generated per host at `plugin:build` (Claude keeps the plugin-CLI
  placeholder; Codex documents global `semctx` only). Source template:
  `plugins/shared/skills/semctx-control/SKILL.md`.
- **Focused skills**: `skills/semctx-verify` for Plane A and `skills/semctx-semantic` for Plane B.
- **Guard hook** (`hooks/`): a `PreToolUse` guard that is **inert by default** (advisory) and, when
  the project opts into guarded mode, blocks non-isolated `git commit` / `git push` commands or an
  unverified working state. Block messages point at the plugin-bundled CLI by absolute path when
  the bundle is in reach, and at a global `semctx` otherwise. The semantic and control tools do not
  change this host-specific behaviour.

## Shared Codex/Claude contract

Both plugins now use the same `semctx-control` skill and the same MCP server identity. They follow
the same sequence: inspect normally → rehydrate intent → check freshness → trace L0-L6 → compile a plan → open a
change contract only for user-authorized writes → edit → verify impact → run runtime checks →
compose the final verdict.

The verdict namespaces stay distinct:

- Plane A: `PASS` / `WARN` / `BLOCK`;
- Plane B: `VERIFIED` / `PARTIAL` / `BLOCKED` / `STALE`;
- Plane C: `READY` / `BLOCKED`.

`READY` is never execution authority. Claude Code may edit only inside the user's write scope, and
Plane C never performs a cutover, deployment or deletion.

## Two profiles

| profile | default | behaviour |
| --- | --- | --- |
| **advisory** | ✅ yes | MCP + skill. The guard hook is present but never blocks. |
| **guarded** | opt-in | The guard requires isolated `git commit`/`git push` commands and a verified current state. |

Enable guarded mode for a project:

```jsonc
// .semctx/guard.json
{ "enabled": true }
```

Strictly disable enforcement at any time (wins over `guard.json`):

```
SEMCTX_GUARD=off
```

The guard only ever gates the two terminal git verbs — never file edits, tests, exploration, or
non-terminal git commands. It compares a hash of the working diff to the last verified hash
(ADR 0007); it runs no analysis itself.

## Requirements

- **Bun** on PATH (the bundled MCP server and CLI run under Bun; no global `semctx` / `semctx-mcp`
  link is required for agent use).
- **Node** on PATH (the guard hook runs under Node, so it works even where Bun is absent).
- The project should be initialised and indexed once:

```text
semctx setup                                # global install
bun "<plugin-root>/dist/semctx.js" setup    # plugin bundle; the skills carry the resolved path
```

  The legacy equivalent is `semctx init && semctx index`; `setup --preset github-claude` also
  installs the preset integration files.

Install from this clone:

```powershell
claude plugin marketplace add ./
claude plugin install semctx@semctx --scope user
```

Restart Claude Code after installing or updating the plugin.

If an older direct MCP registration is still present, remove it after the plugin is enabled with
`claude mcp remove semctx -s user`; otherwise Claude sees duplicate copies of the same tools.

## Notes

- Every MCP call must pass the absolute project path as `repositoryRoot`; missing or relative roots
  are rejected.
- Both host plugins ship byte-identical `dist/semctx-mcp.js` and `dist/semctx.js` artifacts built
  from the MCP server and CLI entrypoints. Claude also binds `SEMCTX_ROOT`, while the shared skill
  passes the explicit `repositoryRoot` required by the common Claude/Codex machine contract.
- Invoke the shared workflow explicitly as `semctx-control` for migrations, architecture work,
  generic demonstrations or cross-plane verification. The narrower skills remain available for
  backward compatibility.
- To remove the guard entirely (zero footprint), delete `hooks/hooks.json` from your plugin
  install, or keep advisory mode (the default) where it never blocks.

See `docs/integrations/claude-code.md` and `docs/integrations/claude-code-guarded-mode.md`.
