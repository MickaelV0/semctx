# Publishing semctx to npm — state & decisions

Prep for the "publish" move (competitive-scan 2026-07: publishing is the strongest non-technical
lever against commoditisation — visibility).

**Decided 2026-07-05** (owner ratified): the CLI publishes as **`semctx`** (unscoped — the name is
free on npm), **bun-only**, as a **single self-contained bundle**. This shipped: `0.1.0` and `0.1.1`
are published. Subsequent releases remain the owner's to run and need `npm login` (credentials).

## Decisions (ratified)

1. **Distribution runtime → bun-only.** The code is bun-first to the bone (`bun:sqlite` in the
   store, `Bun.spawnSync` in the CLI's git path). A `--target=node` bundle would compile then
   crash at runtime; true node support needs a real port (`bun:sqlite` → `better-sqlite3` — a
   native dependency whose `npx` install can fail per-platform — plus a spawn shim). Rejected as
   dishonest and adoption-negative for a first release. The `RepositoryStore` port keeps the node
   door open for later (one file to swap) at zero cost now.
2. **Name → `semctx`** (unscoped, verified free on npm). Install = `bunx semctx`. Product name =
   install name. The internal libs stay `@semantic-context/*` and are **not** published — they are
   inlined into the bundle.
3. **Packaging → single autonomous bundle.** `bun build src/index.ts --target=bun --minify`
   inlines the 6 workspace libs into `apps/cli/dist/index.js` (3.8 MB — it embeds the TypeScript
   compiler, needed by `semctx index`). This **removes the topological publish-order blocker**:
   one package to publish, not seven; no npm org to create.

## What was done here

- `apps/cli/package.json`: renamed `@semantic-context/cli` → `semctx`; `bin` → `./dist/index.js`;
  `files: ["dist", "README.md", "LICENSE"]`; `build` / `prepublishOnly` run the bundle; the 6
  `@semantic-context/*` deps moved to `devDependencies` (dev only; inlined at build; never
  installed by a consumer).
- `apps/cli/README.md` + `apps/cli/LICENSE` added (npm ships them from the package directory).
- Verified end-to-end: `bun build` bundles 62 modules; the shebang is preserved; the **extracted
  tarball runs outside node_modules** — `--help`, `verify diff --dry-run`, and `doctor`
  (exercising `bun:sqlite`) all work.
- `npm pack --dry-run`: exactly 4 files (LICENSE, README.md, dist/index.js, package.json),
  1.1 MB packed / 3.8 MB unpacked.

## Final step — the owner runs this

```bash
npm login                         # or set NPM_TOKEN in the environment
cd apps/cli
npm publish --access public       # 'semctx' is unscoped → public by default;
                                  # prepublishOnly rebuilds dist/index.js from source first
```

Then tag the release: `git tag v0.1.0 && git push --tags` (and optionally announce).

**Published.** `semctx` `0.1.0` and `0.1.1` are live on npm (`0.1.1` since 2026-07-05). The
publishing mechanics above are proven, not pending.

What is unresolved is the *release policy*, not the ability to release: `apps/cli/package.json`
still reads `0.1.1` while the plugins ship `0.1.10`, so `bunx semctx` serves a CLI well behind this
repository. See [#38](https://github.com/hoklims/semctx/issues/38) and
[#35](https://github.com/hoklims/semctx/issues/35).

## Plugin runtime

The Claude Code and Codex plugins ship byte-identical committed Bun bundles:

| artifact | entrypoint | role |
| --- | --- | --- |
| `dist/semctx-mcp.js` | `packages/mcp-server/src/index.ts` | MCP server (agent tools) |
| `dist/semctx.js` | `apps/cli/src/index.ts` | CLI for setup / verify / shell fallbacks |

Each `dist/` also carries the TypeScript standard-library declarations used by the analyzer, and
the generated runtimes resolve them relative to the installed plugin directory rather than the
build checkout:

```bash
bun run plugin:build   # refresh tracked dist/semctx-mcp.js + dist/semctx.js on both plugins
bun run plugin:check   # fail if any tracked artifact is missing or stale
```

Agent sessions should prefer the plugin-bundled CLI so a marketplace update keeps MCP and CLI in
lockstep. The npm `semctx` package remains the channel for CI, GitHub Actions, and non-plugin shells.

### Version SSOT (release lockstep)

These surfaces must share the same `x.y.z` on every plugin/CLI release:

| Surface | Path |
| --- | --- |
| Claude plugin | `plugins/claude-code/.claude-plugin/plugin.json` |
| Codex plugin | `plugins/semctx-control/.codex-plugin/plugin.json` |
| Marketplace | `.claude-plugin/marketplace.json` |
| MCP package | `packages/mcp-server/package.json` (also `McpServer({ version })`) |
| App services | `packages/app-services/package.json` |
| npm CLI | `apps/cli/package.json` (`semctx --version` / `doctor`) |

`plugins/plugin-parity.test.ts` fails CI when plugins, marketplace, MCP, app-services, or the npm
CLI package diverge. Plugin MCP/CLI **bundles** are rebuilt together via `plugin:build` (same
entrypoint sources). The npm CLI uses a separate `apps/cli` prepublish bundle for CI/global
installs — same version number, two packagers by design.

Plugin, marketplace, MCP package and runtime versions move together. CI runs the freshness check,
rejects build-machine paths, and performs a real stdio handshake (MCP) plus a packaged CLI smoke
(`setup`, `doctor --json`, `verify diff --dry-run` on a foreign sample repo) from a copied plugin
directory on Windows and Ubuntu before the plugin snapshot is publishable.

## Deliberately out of scope (this pass)

- **Publishing the MCP server as a separate npm package.** Plugin installs use their committed,
  self-contained runtime and therefore need no global `bun link` or package publish order.
- **node compatibility.** Deferred by decision #1; the `RepositoryStore` port keeps it a
  single-file change if real demand appears.
