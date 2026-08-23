# Oh My Pi integration

Oh My Pi installs the Claude plugin directory (`plugins/claude-code`) through `.omp-plugin/marketplace.json`. MCP launch is `plugins/claude-code/mcp-omp.json` (relative `bun ./dist/semctx-mcp.js`, `cwd: "."`). Claude `.mcp.json` placeholders are not used.

Requirements: Oh My Pi with marketplace support, Bun 1.3+ on PATH.

```bash
omp plugin marketplace add hoklims/semctx
omp plugin install semctx@semctx-stable --scope project
```

Then `/reload-plugins` or restart the session. Every MCP tool call must pass an absolute `repositoryRoot`. Prefer MCP tools. For shell fallbacks use a global CLI on the same version as the plugin (`semctx --version` / `bunx semctx@latest`). Do not run `bun ./dist/semctx.js` from the user repository cwd. The Claude skill still contains `${CLAUDE_PLUGIN_ROOT}`; OMP does not substitute it.

The Claude commit/push guard hook is not loaded on OMP.
