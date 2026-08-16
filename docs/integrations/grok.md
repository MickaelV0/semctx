# Grok integration: Claude plugin MCP without template expansion

Grok can install the same Claude Code plugin (`plugins/claude-code`) from the `semctx-stable`
marketplace. It launches the bundled stdio server (`dist/semctx-mcp.js`) and loads the shared
`semctx-control` skill.

It does **not** expand Claude Code plugin env templates. The plugin `.mcp.json` still declares:

```json
"env": { "SEMCTX_ROOT": "${CLAUDE_PROJECT_DIR}" }
```

Claude Code substitutes that value with the workspace root. Grok forwards the literal string.
Before this contract clarification, `createSemctxServer("${CLAUDE_PROJECT_DIR}")` threw
`REPOSITORY_ROOT_INVALID` during process construction, so the handshake failed with JSON-RPC
`-32603 Internal server error` and no tools were advertised.

The process-bound root policy now treats unsubstituted `${NAME}` placeholders (and empty
values) as unset. The server starts in the same pin-on-first-request mode Codex already uses.
Every tool call must still pass an absolute `repositoryRoot`. Relative paths, missing
directories, and a second distinct root remain catalogue errors.

Grok may resolve `${CLAUDE_PLUGIN_ROOT}` in the launch `args` to the installed plugin directory
even when it leaves `SEMCTX_ROOT` unexpanded. Do not remove the Claude env binding from
`.mcp.json`: Claude Code still uses it to pre-bind the workspace when substitution works.

## Agent contract

Same as Claude Code and Codex:

- pass the absolute repository root on every tool call;
- do not treat process cwd or an unexpanded env template as an implicit target;
- pin-on-first-request is connection-local, never execution authority.

See [ADR 0012](../adr/0012-mcp-2026-stable-surface.md) (repository root policy) and
[`claude-code.md`](claude-code.md).
