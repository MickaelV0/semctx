# ADR 0015 — Oh My Pi consumes the Claude plugin tree with a replaced MCP launch file

- Status: accepted
- Date: 2026-08-23
- Related: ADR 0012 (stable MCP surface), ADR 0014 (plugin delivery observation)

## Context

Oh My Pi installs Claude-compatible marketplaces but does not expand `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PROJECT_DIR}`. Pointing OMP at `plugins/claude-code/.mcp.json` therefore launches a literal unexpanded path. A third generated host (`plugins/omp/`, new `SkillHost`, duplicated `dist/`) would expand `plugin-parity` and `plugin:build` without changing MCP tool schemas.

## Decision

Oh My Pi is a **consumer of the existing Claude plugin directory** (`plugins/claude-code`), not a third generated host.

1. Repository catalog `.omp-plugin/marketplace.json` lists plugin `semctx` at `source: "./plugins/claude-code"`, marketplace name `semctx-stable`, version equal to `plugins/claude-code/.claude-plugin/plugin.json`.
2. Plugin manifest `plugins/claude-code/.omp-plugin/plugin.json` sets `"mcpServers": "./mcp-omp.json"`. OMP reads this file before `.claude-plugin/plugin.json` and **replaces** default `.mcp.json`.
3. `plugins/claude-code/mcp-omp.json` launches the committed bundle the same way Codex does, without Claude placeholders and without `SEMCTX_ROOT`:
   `command: bun`, `args: ["./dist/semctx-mcp.js"]`, `cwd: "."`. No `default_tools_approval_mode` (Codex-only).
4. Claude `.mcp.json`, Codex `.mcp.json`, `SkillHost`, generated skills, and `dist/` stay unchanged. `semctx plugin-status --host` is **not** extended (still `auto|codex|claude|all` per ADR 0014).
5. Shell fallbacks on OMP use global `semctx` / `bunx semctx@latest`. The Claude skill still mentions `${CLAUDE_PLUGIN_ROOT}`; agents must prefer connected MCP tools.

## Consequences

- `omp plugin marketplace add hoklims/semctx` then `omp plugin install semctx@semctx-stable` is the supported install.
- Cross-host `dist/` byte equality and Claude/Codex parity tests remain the SSOT; OMP adds a manifest test only.
- Guard `hooks/hooks.json` stays Claude-only. OMP does not gain a commit/push guard in this change.
