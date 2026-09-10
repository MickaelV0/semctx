# Type Safety — PPlug

## Summary
Reviewed plugin hosts (`plugins/shared` lifecycle, Claude `semctx-guard.mjs`), `scripts/` (compatibility, delivery proof, plugin/CLI build, verify-pr, multicore bench), `packages/github-action/src/adapter.mjs`, `packages/eval/src`, and `packages/test-fixtures/src` (source only; skipped tests, `dist/`, `typescript-lib`). TypeScript in this plane has **zero** `any` / `as any` / `as unknown as` / `@ts-ignore|nocheck|expect-error`. Worst issue is the GitHub Action adapter: ADR 0008’s `VerifyReport` is `JSON.parse`d with no schema and no `verdict`/`schemaVersion` check, so an unknown verdict never fails the job. JS hooks are untyped by design; lifecycle already structurally validates stdin/contract/ledger, the Claude guard does not.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| TYPE-PPLUG-01 | P1 | packages/github-action/src/adapter.mjs:106 | Action adapter `JSON.parse`s the verify report with no schema. ADR 0008 says consumers key off `schemaVersion`; the adapter never reads it. `renderAction` treats only exact `"BLOCK"`/`"WARN"` as fail-on hits, so a missing/unknown `verdict` (or a future schema bump) exits 0. MCP already has `VerifyReportSchema`; this Node boundary does not. | `report = JSON.parse(readFileSync(reportPath, "utf8"));` | Add a Node-safe `isVerifyReport` (or ship a tiny Zod parse) requiring `schemaVersion === 1` and `verdict ∈ {PASS,WARN,BLOCK}`; refuse otherwise with exit 2. | 92 |
| TYPE-PPLUG-02 | P2 | packages/github-action/src/adapter.mjs:103 | `fail-on` is documented as `block \| warn \| none` but never exhaustively checked. Unknown `INPUT_FAIL_ON` (including wrong case) makes `shouldFail` false. | `const failOn = (process.env.INPUT_FAIL_ON \|\| "block").trim();` | Reject anything outside `{block,warn,none}` before `renderAction`; default only when unset. | 90 |
| TYPE-PPLUG-03 | P2 | plugins/claude-code/hooks/semctx-guard.mjs:1609 | Guard stdin is `JSON.parse` then property access with no object/envelope guard. Lifecycle already has `normalizeHookEnvelope` (`semctx-lifecycle.mjs:119`) that refuses null/array/non-object. Here `JSON.parse("null")` / a number throws (no `uncaughtException` pin) and a non-object envelope is otherwise trusted for `tool_name` / `tool_input`. | `input = JSON.parse(readFileSync(0, "utf8"));` | Mirror lifecycle: require a non-array object, then `nonEmptyString` for `tool_name`/`cwd` before any `?.` chain. | 88 |
| TYPE-PPLUG-04 | P3 | scripts/prove-stable-delivery.ts:2128 | MCP NDJSON line is asserted `as Record<string, unknown>` and `message["id"] as number` before `isRecord` / `evaluateJsonRpcResponse`. Later evaluators fail-closed on id mismatch, but the Map lookup is a lie: a string id never matches the numeric pending key. | `const waiter = pending.get(message["id"] as number);` | `JSON.parse` → `unknown`; dispatch only when `isRecord(message) && typeof message.id === "number"`. | 82 |
| TYPE-PPLUG-05 | P3 | scripts/compatibility.ts:43 | Repo `package.json` / workflow YAML are asserted into shapes with no field guards. `pkg.engines.bun` and `workflow.jobs` are used immediately; a drifted manifest or YAML without `jobs` throws or writes `"undefined"` into the compatibility block. | `JSON.parse(...) as { version: string; engines: { bun: string } }` | Narrow with `typeof pkg?.engines?.bun === "string"`; treat missing `jobs` as a check error, not a throw. Same for `Bun.YAML.parse(...) as Workflow` at `:61`. | 78 |
| TYPE-PPLUG-06 | P3 | scripts/benchmark-multicore-index.ts:60 | Worker stdout is `JSON.parse`d `as BenchmarkResult` with no field checks. Identity compare then reads `graphDigest`/`sealHash`; a truncated or extra-line stdout becomes `"undefined:undefined"` and can false-pass the identity set. | `results.push(JSON.parse(...) as BenchmarkResult);` | Parse as `unknown`; require string hashes + finite numbers before pushing. | 80 |

## Metrics
- Files read: 22
- Findings: 6 (P0: 0 / P1: 1 / P2: 2 / P3: 3)
- `any` / `as any` / `as unknown as`: 0 (TS source under scripts, eval, test-fixtures)
- `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`: 0
- Non-null `!`: 9 (all after length/key/`matchAll` guards except `name!` in `reconciliation-authority.ts:126`) — `build-plugin-runtime.ts` 148, 398, 457, 494, 624; `reconciliation-authority.ts` 110, 111, 126, 156
- `JSON.parse` sites (unique authored; lifecycle host copies not double-counted): 12. Schema/structural guard after parse: 4 (lifecycle contract `:107`, ledger `:233`, stdin envelope `:548`; doctor smoke `prove-stable-delivery.ts:1337`). Assertion-only or unguarded: 7 (adapter `:106`, guard stdin `:1609`, guard `readJson` `:1347`, compatibility JSON `:43` + YAML `:61`, benchmark `:60`, MCP line `:2128`). Helper `parseJson` (`prove-stable-delivery.ts:1295`) returns `unknown`.
- Discriminated-union switches in this plane: none in TS source (`verify-pr` unknown-arg throw is fail-closed). Eval/test-fixtures/build-cli-package: clean.

## Recommendations
1. Treat the Action adapter as the ADR 0008 consumer it is: validate `schemaVersion` + `verdict` (and `fail-on`) before annotations or exit; reuse the MCP `VerifyReportSchema` shape as a portable predicate, not a Bun/Zod workspace import if Node must stay dependency-free.
2. Give the Claude guard the same stdin envelope predicate the lifecycle hook already ships; do not access host JSON until `typeof === "object" && !Array.isArray`.
3. Ban `JSON.parse(...) as T` in `scripts/`: parse to `unknown`, then `isRecord` + field checks (delivery proof already does this for doctor/marketplace — extend it to MCP NDJSON, compatibility, and the bench worker).
4. Leave eval and verify-pr as the type-safety baseline for this plane; they do not parse untrusted JSON and do not use `any`.
