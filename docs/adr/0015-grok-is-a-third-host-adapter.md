# ADR 0015 — Grok is a third host adapter, not a third runtime

- Status: accepted
- Date: 2026-08-14
- Related: ADR 0012 (MCP 2026 stable surface), ADR 0013 (contributor gate),
  ADR 0014 (plugin delivery states), issue #40 (host CLI ladders)

## Context

Grok can load a Semctx marketplace plugin and launch the bundled stdio MCP server. It is not
Claude Code: plugin env templates in `.mcp.json` are not a Grok expression language, and
`${CLAUDE_PROJECT_DIR}` is not substituted into `SEMCTX_ROOT`. Reusing the Claude plugin as the
Grok delivery therefore either fails handshake (literal `SEMCTX_ROOT`) or requires a process-env
clarification that is independent of how Grok *should* package a plugin.

A second copy of the MCP/CLI TypeScript, or a hand-written third `SKILL.md`, would drift from the
Claude and Codex adapters. Those two hosts already share one generated runtime and one skill
template; only the host CLI ladder and the launch manifest differ.

Grok's official plugin contract (user guide §09) is a folder of `skills/`, optional
`plugin.json`, and `.mcp.json`, listed from `.grok-plugin/marketplace.json`. Plugin hooks receive
`GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA` (and Claude aliases). Those variables are **not**
documented for skill bodies or for the agent's shell. Skills therefore cannot rely on
`${CLAUDE_PLUGIN_ROOT}` substitution the way Claude Code does.

A global `semctx` CLI must remain optional for Grok, matching Claude: the plugin ships
`dist/semctx-mcp.js` and `dist/semctx.js`, and the agent must be able to invoke the bundled CLI
when MCP is down.

## Decision

### One runtime, three host leaves

`bun run plugin:build` continues to emit one portable artifact set
(`semctx-mcp.js`, `semctx-shared.js`, `semctx.js`, `typescript-lib/`) and copies it byte-identically
into every host plugin `dist/`. A new leaf `plugins/grok/` is a third destination, not a third
source. `plugin-parity` requires Claude = Codex = Grok on those bytes.

The shared skill template stays `plugins/shared/skills/semctx-control/SKILL.md`. `SkillHost`
gains `"grok"`. The host-neutral body (workflow + lifecycle) remains byte-identical after the
`host-cli-ladder` region is stripped.

### Grok launch contract

`plugins/grok/.mcp.json` launches the bundled MCP and **does not** set `SEMCTX_ROOT`. The server
starts unbound and pins on the first absolute `repositoryRoot` argument (ADR 0012). Grok's plugin
adapter already substitutes `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` `args` (observed on the Claude
leaf). The Grok leaf uses that same token to address `dist/semctx-mcp.js` so no global CLI is
required to start tools. `GROK_PLUGIN_ROOT` remains hook-only until Grok documents MCP expansion
of that name.

Relative `./dist/semctx-mcp.js` with `cwd: "."` is the Codex contract. It is not assumed for Grok:
plugin MCP cwd is the user workspace, not the plugin directory.

### Grok skill CLI ladder (no global install)

Grok does not substitute a plugin-root placeholder into skill text. The generated Grok ladder
therefore tells the agent to:

1. prefer connected MCP tools;
2. resolve the bundled CLI via `grok plugin list --json` (`name === "semctx"`, `status ===
   "installed"`) plus `grok plugin details semctx` (optional `subdir`);
3. run `bun "<plugin-root>/dist/semctx.js"` — never `./dist/semctx.js` from the repository cwd;
4. fall back to a global `semctx` of the same version only if that resolution fails.

`GROK_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` must not appear in the Grok skill body: they are absent
from the agent shell.

### Installer

`semctx install --host auto|codex|claude|grok|all` detects `grok` on PATH, adds or refreshes a
marketplace whose source is `hoklims/semctx`, installs/updates `semctx` with `--trust`, and
enables it. Enable is required: Grok plugins stay off until enabled. Trust is required: hooks and
MCP stay inert until trusted. `~/.grok/plugins/` auto-trust is not the marketplace install path.

A marketplace already named for this repository but pointing elsewhere is `conflict`, same as
Claude/Codex.

### Marketplace index

Grok reads `.grok-plugin/marketplace.json` in preference to the Claude index. That file lists
`semctx` → `./plugins/grok`. Claude continues to read `.claude-plugin/marketplace.json` →
`./plugins/claude-code`. Codex continues to read `.agents/plugins/marketplace.json` →
`./plugins/semctx-control`.

## Rejected alternatives

- **`${A}||${B}` in the Claude `.mcp.json`:** not a host expansion syntax; Claude would bind
  `/abs/workspace||${GROK_…}`, which is not a path.
- **Reuse `plugins/claude-code` as the Grok leaf:** ships `SEMCTX_ROOT=${CLAUDE_PROJECT_DIR}` and
  Claude-only hooks; fails or over-claims on Grok.
- **Reuse `plugins/semctx-control` as the Grok leaf:** Codex launch (`cwd: "."`) is unproven on
  Grok; Codex skill ladder requires a global CLI, which this decision forbids.
- **Third hand-written skill or third TypeScript tree:** guaranteed drift; the generator already
  exists to prevent it.
- **Rewrite the skill with an absolute install path at `semctx install` time:** the plugin must
  also work when installed by `grok plugin install` alone; hashed `installed-plugins/<key>` paths
  are not known at `plugin:build`.
- **SessionStart hook injecting the CLI path:** Grok treats SessionStart as passive (stdout
  ignored); it cannot publish the path into the conversation.

## Consequences

Contributors add Grok-specific files only under `plugins/grok/` (manifest, `.mcp.json`, generated
skill/dist) plus the Grok marketplace index and the installer host. Runtime and workflow edits
stay in packages and the shared template.

`semctx plugin-status --host grok` is out of this decision's implementation scope; delivery
observability for Grok can follow ADR 0014 without blocking the adapter.

A later Grok-native `${GROK_PLUGIN_ROOT}` expansion in `.mcp.json` is a mechanical token rename
once Grok documents it; it does not change the pin-on-first-request or bundled-CLI rules.

## Verification

- `plugin:check`: Grok `dist/` is byte-identical to Claude and Codex; Grok skill matches
  `renderControlSkill("grok")`; shared body matches the other hosts after stripping the host
  ladder.
- Installer unit tests: add/update/enable/`--trust`, conflict, missing binary, `--host grok`.
- Negative: Grok `.mcp.json` has no `SEMCTX_ROOT`; Grok skill contains no `CLAUDE_PLUGIN_ROOT`
  and no `bun ./dist/semctx.js`.
- `bun run verify:pr` on both CI lanes.
