# Oh My Pi integration

**Experimental, opt-in.** OMP is a consumer of the existing Claude plugin tree (ADR 0015), not a
stable-proven delivery target: it has no `plugin-status` support and no `deliver` attestation.
Tracked in HOK-456.

Oh My Pi installs the Claude plugin directory (`plugins/claude-code`) through `.omp-plugin/marketplace.json`. The catalog entry pins the plugin to `source: { source: "git-subdir", url: "https://github.com/hoklims/semctx.git", path: "plugins/claude-code", ref: "stable" }` — the marketplace name (`semctx-stable`) is a label, not a Git pin; only `source.ref` keeps the installed bytes off `main`. MCP launch is `plugins/claude-code/mcp-omp.json` (relative `bun ./dist/semctx-mcp.js`, `cwd: "."`). Claude `.mcp.json` placeholders are not used.

Requirements: Oh My Pi `>=17.1.8` (marketplace-capable, honors the manifest's `mcpServers` pointer), Bun `>=1.3.14` on PATH.

```bash
omp plugin marketplace add hoklims/semctx
omp plugin install semctx@semctx-stable --scope project
```

Then `/reload-plugins` or restart the session. Every MCP tool call must pass an absolute `repositoryRoot`. Prefer MCP tools. For shell fallbacks on a git/link user-scope install, run `bun "$HOME/.omp/plugins/node_modules/semctx/dist/semctx.js"` (same bundle as MCP). Do not run `bun ./dist/semctx.js` from the user repository cwd. A global `semctx` / `bunx semctx@latest` remains a last resort; keep it on the same version as the plugin.

OMP substitutes `${CLAUDE_PLUGIN_ROOT}` and its own `${OMP_PLUGIN_ROOT}` inside MCP server config fields, but never inside skill/agent markdown body text — the Claude skill still contains a literal, unsubstituted `${CLAUDE_PLUGIN_ROOT}` when read on OMP. Do not run that placeholder; use the `$HOME/.omp/plugins/…` copy above, or prefer connected MCP tools.

## Commit/push guard

OMP loads `plugins/claude-code/hooks/pre/semctx-guard.ts` (default export factory registering
`pi.on("tool_call")`). It calls the same ADR 0007 decision function as Claude's
`hooks/semctx-guard.mjs` — `evaluateBashGuard` — with OMP's `bash` tool name (Claude uses
`Bash`). Advisory is the default: the hook is present but never blocks until the project opts in via
`.semctx/guard.json` `{ "enabled": true }` or `SEMCTX_GUARD=on`, which then blocks non-isolated
`git commit` / `git push` until the working state matches a recorded verification baseline.

Claude's `hooks/hooks.json` `PreToolUse` registration remains Claude-only; OMP does not read it.
`pluginCliPath` inside the shared guard resolves the bundled CLI from `OMP_PLUGIN_ROOT` (after
`CLAUDE_PLUGIN_ROOT`), then falls back to file-relative `dist/semctx.js`.
