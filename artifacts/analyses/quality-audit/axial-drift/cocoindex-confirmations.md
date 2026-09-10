# Cocoindex confirmations

`ccc` was initialized and indexed (517 files, 7056 chunks) at audit start.

**Do not use `ccc` top-5 as a severity gate on this run.** After Wave 2 the index includes `artifacts/analyses/quality-audit/**`. Queries such as “bunfig.toml preload” returned the audit reports themselves (markdown echo), not product source. Applying the playbook “no ccc top-5 → downgrade one severity” rule would demote real P0s.

P0/P1 product confirmation is **grep on source**, not semantic search:

| ID | Product evidence | Verdict |
|----|------------------|---------|
| SEC-PB-01 | `packages/semantic-engine/src/store.ts:24-32` — `entry.isDirectory()` recurses; only `*.sem` *file* symlinks throw | **keep P0** |
| SEC-PPLUG-01 | `plugins/claude-code/mcp-omp.json:6` `"cwd": "."`; `plugins/semctx-control/.mcp.json:6` same; `plugins/claude-code/.mcp.json` has `command: bun` and no cwd (host default = project) | **keep P0** |
| SEC-PPLUG-02 | `packages/github-action/action.yml:73-90` — `working-directory: ${{ inputs.working-directory }}` then `bun "$SEMCTX_CLI" init/index/verify --root .` | **keep P0** |
| SEC-PB-02 | `packages/semantic-engine/src/store.ts:97-100` and `handoff.ts:85-88` — `${path}.tmp` + `writeFileSync` | **keep P1** |

`ccc search "writeAtomic path.tmp"` did hit `handoff.ts` (score 0.65) and the exclusive-writer contrast in `anchor-migration.ts` (0.68). That is consistent with SEC-PB-02 but is not the confirmation path used.

No finding was downgraded for lack of `ccc` confirmation.
