# Grok integration: native host adapter

Grok loads [`plugins/grok`](../../plugins/grok) from `.grok-plugin/marketplace.json`, not the
Claude Code leaf. The MCP/CLI bytes and the control-skill body are generated from the same
sources as Claude and Codex (`bun run plugin:build`). See
[ADR 0015](../adr/0015-grok-is-a-third-host-adapter.md).

## Install

From a Git repository (also prepares `.semctx/` unless `--skip-setup`):

```bash
bunx semctx@latest install --host grok
```

Without the installer CLI — the plugin still ships its own MCP and CLI:

```bash
grok plugin marketplace add hoklims/semctx
grok plugin install hoklims/semctx@stable#plugins/grok --trust
grok plugin enable semctx
```

Then start a new Grok session or press `r` in the Plugins tab. Plugins stay off until enabled;
MCP stays inert until trusted.

## Launch contract

`.mcp.json` starts the bundled server and sets `SEMCTX_ROOT=${CLAUDE_PROJECT_DIR}` as a sentinel
so an inherited concrete `SEMCTX_ROOT` cannot bind the process. ADR 0012 treats that unexpanded
placeholder as unset; the first absolute `repositoryRoot` argument still pins. Grok's plugin
adapter substitutes `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` `args`. `GROK_PLUGIN_ROOT` is
documented for hooks only.

## Claude leaf leftover

If Grok still loads `plugins/claude-code` (older marketplace index), that leaf sets
`SEMCTX_ROOT=${CLAUDE_PROJECT_DIR}`. Grok forwards the literal string. Unsubstituted `${NAME}`
placeholders and empty values are treated as unset (ADR 0012), so the server starts in the same
pin-on-first-request mode. Do not remove the Claude env binding from the Claude `.mcp.json`:
Claude Code still uses it to pre-bind the workspace when substitution works.

## Bundled CLI (no global `semctx`)

Grok does not substitute a plugin-root placeholder into skill text, and those variables are not
in the agent shell. The generated Grok skill ladder therefore:

1. prefers connected MCP tools;
2. resolves `<plugin-root>` via `grok plugin list --json` (`name === "semctx"`, Semctx source,
   skip the leftover Claude leaf); use `<path>/plugins/grok` when the checkout still has that
   child, otherwise `path` when it already contains `dist/semctx.js`;
3. runs `bun "<plugin-root>/dist/semctx.js"`;
4. falls back to a same-version global `semctx` only if that file cannot be resolved.

Never run `bun ./dist/semctx.js` from the user's repository cwd.

## Agent contract

Same as Claude Code and Codex:

- pass the absolute repository root on every tool call;
- do not treat process cwd or an unexpanded env template as an implicit target;
- pin-on-first-request is connection-local, never execution authority.

See [ADR 0012](../adr/0012-mcp-2026-stable-surface.md) (repository root policy).
