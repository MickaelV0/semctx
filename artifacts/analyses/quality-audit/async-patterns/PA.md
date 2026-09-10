# Async Patterns — PA

## Summary
Reviewed Plane A source only (`ts-analyzer` including `index-worker`, `python-analyzer/src`, `plane-a-internal`, `workspace-analyzer-internal`, `cocoindex-adapter`), skipping tests and excluded trees. 24 files. No SQLite, no floating promises, no missing `await` on real Promises. `python-analyzer` and `plane-a-internal` are purely synchronous CPU. Workspace async I/O awaits every `readdir`/`lstat`/`readFile`. Index-worker supervision is fail-closed (300s timer, `terminate` on success/fail/cancel, DTO `jobId` check, exact-cover merge). Worst issue: `CocoIndexCandidateProvider`’s `async` `search`/`version` call `Bun.spawnSync` with no timeout/kill, so a wedged `ccc` stalls the whole process — including index-worker `onmessage` and the 300s kill timer.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| ASYNC-PA-01 | P1 | packages/cocoindex-adapter/src/cocoindex-provider.ts:45 | `async search` / `version` wrap `Bun.spawnSync` with no `timeout`/`kill`. A hung `ccc` never returns; the method does not yield, so the event loop cannot deliver worker `onmessage` or fire `runExtractionWorker`’s 300s timer. Sibling: `:27` (`--version`). Not argv injection (security). | `proc = Bun.spawnSync(` | Use `Bun.spawn` (argv array) with `timeout` + `kill`, `await proc.exited`; bound stdout; keep degrade-to-empty on timeout/nonzero. | 93 |
| ASYNC-PA-02 | P2 | packages/ts-analyzer/src/ts-symbols.ts:339 | `extractTypeScriptParallel` runs a full `ts.createProgram` preflight (`:431`) plus per-file `statSync` (`:582`) on the calling thread before the first `await` (`:383`). `analyzeRepositoryAsync` therefore blocks like the sync path until workers are posted. After join, `assembleRepository` still `readFileSync`s every file for the sidecar (`analyze.ts:336`). | `const preflight = preflightParallelSafety(rootAbsPaths, repoRoot);` | Keep the safety preflight, but run it in a worker (or `setImmediate`/`await` a yield) so MCP/CLI can tick; sidecar re-read via `fs.promises.readFile` on the async path. | 88 |
| ASYNC-PA-03 | P2 | packages/ts-analyzer/src/discovery.ts:198 | `countTypeScriptFiles` is documented as a cheap walk “without reading file contents” / “before the (blocking) analysis”. Config v2 calls `discoverRepository`, which `readFileSync`s every selected file (`:318`) just to count TypeScript. v1 (`:201-208`) is the advertised path. | `return discoverRepository(config).files.filter((file) => file.language === "typescript").length;` | Count from the walk + include/exclude/language predicates only; do not open file bodies. | 90 |
| ASYNC-PA-04 | P2 | packages/ts-analyzer/src/ts-symbols.ts:582 | Chunk weighting `statSync` sits outside the worker `try/catch`. A file that vanishes (or errors) between preflight `createProgram` and launch rejects `extractTypeScriptParallel` instead of the existing `preflight-fallback` / `worker-unavailable-fallback` arms. | `weight: paths.reduce((total, path) => total + statSync(path).size, 0),` | `try/catch` around weighting → same fallback as an unsafe preflight; or treat stat failure as weight `1` and keep partitioning. | 78 |
| ASYNC-PA-05 | P3 | packages/ts-analyzer/src/ts-symbols.ts:626 | Parent sets `onerror`/`onmessage` and a 300s `setTimeout`, but not `onmessageerror`. A structured-clone failure waits the full five minutes. That timer lives on the parent event loop, so it cannot fire during ASYNC-PA-01 `spawnSync`. Worker `onmessage` is one-shot and `terminate`d on settle — no reuse race. | `worker.onerror = (event) => fail(new Error(\`index worker crashed: ${event.message}\`));` | `worker.onmessageerror = (e) => fail(e)`; optional `AbortSignal` shared across jobs. | 72 |

## Metrics
- Files read: 24 partition source files grepped; 12 read in detail (`ts-symbols.ts`, `index-worker.ts`, `analyze.ts`, `discovery.ts`, `cocoindex-provider.ts`, workspace `index.ts`, python `index.ts`, plane-a `index.ts`, cocoindex `index.ts`/`resolve.ts`/`provider.ts`/`null-provider.ts`)
- Findings: 5 (0 P0 / 1 P1 / 3 P2 / 1 P3)
- Spawn sites: 2 (`cocoindex-provider.ts:27` `--version`, `:45` `search`) — both `Bun.spawnSync`, no `timeout`/`kill`/`maxBuffer`; `Bun.spawn` (async): 0
- SQLite write sites: 0
- Index-worker protocols: 1 (`index-worker.ts` + `runExtractionWorker`); timeout 300_000 ms; `terminate` on success/fail/cancel; extra workers `workers.slice(jobs.length)` killed; merge requires exact unique cover (`ts-symbols.ts:739`)
- Missing-await suspects: 0 (`isSafeWorkspaceRoot` returns the `isSafeAbsolutePath` thenable; callers `await`)
- Floating promises / unawaited `.then`: 0
- `async` functions: 9 (`analyzeRepositoryAsync`, `extractTypeScriptParallel`, cocoindex `version`/`isAvailable`/`search`, null-provider trio, `analyzeWorkspace` + helpers)
- Blocking sync I/O on claimed-async/hot paths: discovery `readdirSync`/`lstatSync`/`readFileSync`; preflight `createProgram`; weighting `statSync`; sidecar `readFileSync`; cocoindex `spawnSync`; `analyzeWorkspaceSync` duplicate walker (async twin is correct)
- Unclosed DB/file handles: 0 (`readFileSync`/`readdir` only; no `openSync`/`createWriteStream`)
- `setTimeout` as fake-sync: 0 (only worker watchdog)

## Recommendations
1. Replace cocoindex `spawnSync` with timed `Bun.spawn` first. A wedged child currently outranks the index-worker kill switch because both share one event loop.
2. Treat `extractTypeScriptParallel`’s preflight as work that must yield; keep the isolation checks, but do not parse the whole program on the MCP thread before posting jobs. Wrap `statSync` weighting in the same fallback as an unsafe preflight.
3. Make `countTypeScriptFiles` v2 match v1 (no content reads). Keep `analyzeWorkspace`’s awaited I/O; prefer it on async runtimes over `analyzeWorkspaceSync`.
4. Leave python-analyzer and plane-a-internal synchronous. Do not add SQLite or spawn there.
