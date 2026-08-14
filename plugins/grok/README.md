# Semctx — Grok plugin

Give Grok the same proof-honest semctx workflow as Claude Code and Codex: reconstruct a change
across repository facts, authored intent and migration controls, then verify the resulting diff
and real runtime behaviour. The analysis is local and deterministic; semctx itself needs no LLM
or network.

This leaf is a **host adapter**. The MCP/CLI runtime and the control skill body are generated
from the same sources as the Claude and Codex plugins (`bun run plugin:build`). Do not edit
`dist/` or `skills/semctx-control/SKILL.md` by hand.

## What it installs

- **Repository MCP tools** (`.mcp.json`): the same stdio server as the other hosts, launched from
  the bundled `dist/semctx-mcp.js`. `SEMCTX_ROOT` is not set; the server pins on the first
  absolute `repositoryRoot` argument.
- **Bundled CLI** (`dist/semctx.js`): lockstep with the MCP runtime. The skill tells the agent
  how to resolve this path via `grok plugin list --json` / `grok plugin details semctx`. A global
  `semctx` is optional.
- **Shared skill**: `skills/semctx-control` — host-neutral workflow body is byte-identical to
  Claude and Codex after the generated CLI ladder is stripped.

## Install

From a Git repository (also prepares `.semctx/` unless `--skip-setup`):

```bash
bunx semctx@latest install --host grok
```

Or Grok-native, without the installer CLI:

```bash
grok plugin marketplace add hoklims/semctx
grok plugin install hoklims/semctx@stable#plugins/grok --trust
grok plugin enable semctx
```

Then start a new Grok session (or press `r` in the Plugins tab). Plugins stay off until enabled;
MCP stays inert until trusted.

Every tool call must pass an absolute `repositoryRoot`. See
[`docs/integrations/grok.md`](../../docs/integrations/grok.md) and
[ADR 0015](../../docs/adr/0015-grok-is-a-third-host-adapter.md).
