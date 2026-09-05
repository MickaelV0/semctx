# ADR 0015 — Oh My Pi consumes the Claude plugin tree as an Agent-Plugins-standard plugin root

- Status: accepted
- Date: 2026-08-23
- Related: ADR 0012 (stable MCP surface), ADR 0014 (plugin delivery observation)
- Scope: **experimental, opt-in.** OMP is a consumer of the Claude plugin tree, not a stable-proven
  delivery target; the gap with Codex/Claude `deliver` attestation is tracked in HOK-456.

## Context

Oh My Pi substitutes `${CLAUDE_PLUGIN_ROOT}` and its own `${OMP_PLUGIN_ROOT}` inside the MCP server
config it launches, but never `${CLAUDE_PROJECT_DIR}`, the token Claude's `.mcp.json` uses to bind
`SEMCTX_ROOT`. Pointing OMP straight at `plugins/claude-code/.mcp.json` would therefore hand it a
`SEMCTX_ROOT` value it can never resolve. Config substitution and skill-body substitution are
separate: OMP does not substitute `${CLAUDE_PLUGIN_ROOT}` inside skill/agent markdown content, only
inside the MCP server config fields. A third generated host (`plugins/omp/`, new `SkillHost`,
duplicated `dist/`) would expand `plugin-parity` and `plugin:build` without changing MCP tool
schemas.

The 2026-08-23 decision therefore consumed the existing Claude tree via a replaced MCP launch file:
`plugins/claude-code/.omp-plugin/plugin.json` with `"mcpServers": "./mcp-omp.json"`, and
`plugins/claude-code/mcp-omp.json` launching `bun ./dist/semctx-mcp.js` with `cwd: "."`. That pair
is dead for the operator standing configuration (`claude-plugins` disabled): only `claude-plugins`
ever read `.omp-plugin/plugin.json` / `mcp-omp.json`. With `claude-plugins` off, a Claude-format
marketplace install left skills and MCP dark.

OMP 18.1.11 `classifyUncached` reads only `<root>/plugin.json`. `$schema` exactly
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` yields `kind:"standard"`, which moves
skills+MCP to the `agent-plugins` provider (`legacyProviderAllowed` false for those surfaces) and
leaves the guard on `package.json#omp.extensions`. A malformed `plugin.json` yields `kind:"invalid"`,
which withholds **every** surface — strictly worse than having no `plugin.json` at all. The nested
root is the marketplace cache root, so `skills/` and `dist/` stay siblings and the in-skill CLI
ladder is unchanged. This supersedes both the launch-file pair above and the "four files at the
monorepo root" plan in upstream issue #140. The B.3 mirror repo (`MickaelV0/semctx-plugin`) and its
snapshotter are retired: marketplace `git-subdir` already delivers the nested tree.

## Decision

Oh My Pi is a **consumer of the existing Claude plugin directory** (`plugins/claude-code`), not a third generated host.

1. Repository catalog `.omp-plugin/marketplace.json` lists plugin `semctx` at
   `source: { source: "git-subdir", url: "https://github.com/hoklims/semctx.git", path: "plugins/claude-code", ref: "stable" }`,
   marketplace name `semctx-stable`, version equal to `plugins/claude-code/.claude-plugin/plugin.json`.
   The marketplace name alone is not a Git pin — `omp plugin marketplace add hoklims/semctx` can
   fetch the catalog file itself from whatever ref the host resolves by default; only `source.ref`
   binds the installed plugin bytes to `stable`, independent of that catalog fetch.
2. `plugins/claude-code/plugin.json` is the Agent-Plugins-standard manifest (`$schema` exactly
   `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`). It does **not** carry MCP launch
   config and does **not** carry the guard: `plugin.json#extensions` is not
   `package.json#omp.extensions`. The guard stays in `package.json#omp.extensions`.
3. `plugins/claude-code/mcp.json` is schema-closed (`$schema` exactly
   `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`; top-level only `$schema` + `mcpServers`)
   and launches the committed bundle the same way Codex does, without Claude placeholders and
   without `SEMCTX_ROOT`: `type: "stdio"`, `command: "bun"`, `args: ["./dist/semctx-mcp.js"]`.
   `cwd` is omitted (defaults to the plugin root). No `env`. No `default_tools_approval_mode`
   (Codex-only). Resulting OMP server id is `semctx:semctx`; on-wire tool names stay `semctx_*`.
4. Claude `.mcp.json`, `.claude-plugin/plugin.json`, `hooks/hooks.json`, Codex `.mcp.json`,
   `SkillHost`, generated skills, and `dist/` stay unchanged. `semctx plugin-status --host` is
   **not** extended (still `auto|codex|claude|all` per ADR 0014).
5. Shell fallbacks on OMP use global `semctx` / `bunx semctx@latest`. The Claude skill still mentions `${CLAUDE_PLUGIN_ROOT}` in its body text (unsubstituted by OMP); agents must prefer connected MCP tools.
6. Compatibility floor: Oh My Pi **18.1.11** (verified: `kind:"standard"` classification, `agent-plugins`
   skills+MCP with `claude-plugins` disabled, guard factory loaded from `omp.extensions`) and Bun
   `>=1.3.14` on `PATH`.

## Consequences

- `omp plugin marketplace add hoklims/semctx` then `omp plugin install semctx@semctx-stable` is the supported install; the first command is mandatory because `classifyInstallTarget` only treats `name@marketplace` as a marketplace spec when that marketplace is already registered locally, otherwise it silently falls through to an npm spec. The plugin itself always resolves from `ref: "stable"` regardless of which ref the marketplace add step fetched. A restart is required for the guard: `/reload-plugins` refreshes skills, commands and MCP but does not re-import extension modules.
- `.omp-plugin/marketplace.json`, `plugins/claude-code/plugin.json` and `plugins/claude-code/mcp.json` join the release-lockstep version SSOT (`plugins/plugin-parity.test.ts`, `docs/publishing.md`) alongside the Claude/Codex surfaces. `plugins/claude-code/.omp-plugin/plugin.json` and `plugins/claude-code/mcp-omp.json` are deleted.
- The B.3 mirror (`MickaelV0/semctx-plugin`) and its snapshotter are retired. Mirror and marketplace install occupy the same `~/.omp/plugins/node_modules/semctx` path: uninstall the git-pipe package and drop its `package.json` dependency key before installing from the catalog, or the two clobber rather than coexist.
- Cross-host `dist/` byte equality and Claude/Codex parity tests remain the SSOT; OMP adds a manifest test only, and is excluded from the `deliver` stable-delivery-proof job — no `plugin-status` support, no delivery attestation. Closing that gap is HOK-456, not this ADR.
- Guard `hooks/hooks.json` stays Claude-only. OMP has a sibling adapter at
  `hooks/pre/semctx-guard.ts` that calls the same `evaluateBashGuard` decision function, loaded via
  `package.json#omp.extensions`.
- Two authoring traps are silent at runtime on OMP 18.1.11: an extra top-level key in `mcp.json` disables the whole file (zero servers registered, no error); `cwd: "."` skips that server. A malformed `plugin.json` (`kind:"invalid"`) withholds every surface, which is strictly worse than omitting the file.
