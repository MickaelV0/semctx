# Tech debt — PC

## Summary
Reviewed Plane C production source only (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 52 `.ts` files). Zero `TODO`/`FIXME`/`HACK`/`XXX`, zero `@deprecated`, zero commented-out statements, and no ADR 0005 retriever leftovers (`prepare_task` / `ContextPack` / experimental pack). Health is good on markers; the real debt is an unfinished V1→V2 cutover. Worst issue: `authorize*` still emits `schemaVersion: 1` reports while `ControlQueryEnvelopeV1` requires V2 payloads, so the published engine and the envelope contract disagree and callers patch `schemaVersion` outside Plane C.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| DEBT-PC-01 | P2 | packages/control-engine/src/policy.ts:40 | Dual-live V1/V2 control contracts with no `@deprecated`. `authorizeTransition` returns `TransitionAuthorizationReport` (`schemaVersion: 1`). `ControlQueryEnvelopeV1` requires `TransitionAuthorizationReportV2` (`refinement.ts:370`). `fingerprintCoordinateGraph` still unions V1\|V2 (`architecture.ts:17`). `PublicControlReport` (`types.ts:575`) is V1-only. `normalize*V1` exist on the barrel and are unused outside `control-model` tests. New graphs are V2 (`coordinates.ts:173`); impact/explain stay V1 (`traversal.ts:184,206`). | `return { schemaVersion: 1, decision: unique.length === 0 ? "ALLOW" : "DENY", fromState: input.fromState, toState: input.toState, risk: input.risk, reasons: unique, proofEvaluations, details: details(unique) };` | Emit V2 from `authorize*` (attestations already on the input). `@deprecated` the V1 report types and `normalize*`. Drop the V1 branch in `fingerprintCoordinateGraph` once no caller passes `schemaVersion: 1`. Point `PublicControlReport` at the envelope payloads. | 92 |
| DEBT-PC-02 | P2 | packages/control-model/src/types.ts:115 | Frozen `schemaVersion: 1` bags keep growing optional fields instead of a bump. `staleLinks?` / `danglingReferences?` are “additive since schemaVersion 1; new builders always emit”. Same pattern on the V1 seal (`planeAIndexSnapshotHash?` `:146`, “absent on legacy v1 indexing flows”) and `DeclaredReconciliationScopeV1` `filePaths?` (`task-envelope-types.ts:81`, “backward compatibility with pre-field schemaVersion 1 artifacts”). Two artifacts with the same version do not have the same shape. | `/** Additive since schemaVersion 1; new builders always emit it. */` | Required fields → bump. Keep a dated V1 parser only if old artifacts must still load; do not extend the live V1 types. | 88 |
| DEBT-PC-03 | P2 | packages/control-model/src/schemas.ts:233 | Traversal caps are copied, not shared. Zod `boundedDepth`/`boundedResults`/`boundedExpansions`/`boundedQueue` hard-code `.max(100)` / `10_000` / `100_000` / `10_000`. Engine `LIMITS` repeats the same four numbers (`traversal.ts:35`) plus separate `DEFAULTS` (`:34`). A schema-only or engine-only edit silently desynchronizes validation vs walk. | `const boundedDepth = z.number().int().min(0).max(100);` | Export `LIMITS` (and `DEFAULTS`) from one module; Zod `.max()` reads those constants. | 90 |
| DEBT-PC-04 | P3 | packages/control-engine/src/legacy-planning.ts:1 | Pre-P2 migration-profile adapter is a public package export (`package.json` `./legacy-planning`) but is not on the main barrel (`index.ts`) and has no production importer — only `refinement-planner.test.ts`. Not `@deprecated`. | `* Compatibility adapter for the pre-P2 migration profile vocabulary.` | Delete the subpath once tests construct adapter steps from `MIGRATION_STEP_PROFILES`, or mark `@deprecated` with a removal issue. | 85 |

## Metrics
- Files read: 52 scanned (all Plane C `src/**/*.ts`; tests/`dist` skipped); 24 inspected
- Findings: 4 (0 P0 / 0 P1 / 3 P2 / 1 P3)
- TODO/FIXME count: 0 (also 0 `HACK`/`XXX`/`WIP`/`@deprecated` in src)
- Deprecated symbols (`@deprecated`): 0 — V1 APIs are still first-class (DEBT-PC-01)
- Experimental retriever leftovers (ADR 0005 `ContextPack` / `prepare_task` / “experimental” pack): 0
- Commented-out code (`// export` / `// const` / `// function` / `// return` / `// if` / `// import`): 0
- Magic-number sites: named — `DEFAULTS`/`LIMITS` (`traversal.ts:34-35`), `MAX_PATHS_PER_DESTINATION = 2` (`:36`), `MAX_LINK_CANDIDATES = 8` (`link-resolution.ts:45`); unnamed duplicate — Zod bounds (`schemas.ts:233-236`); levels re-listed as `[0, 1, 2, 3, 4, 5, 6]` (`coordinates.ts:163`) beside `SEMANTIC_LEVELS`
- Compatibility shims (intentional, not extra findings): `normalizers.ts` V1→V2; `legacy-planning.ts`; `CompatibilityNormalizationNoteV1`; `LEGACY_HANDOFF_ONLY` / `legacy_ambiguous` / `legacy?: true` on link resolution
- Version drift plugin/cli/mcp: none in this partition. Plane C packages are private `0.1.0` + `workspace:*`. No plugin/cli/mcp version literals in src. `toolVersion` is a compared seal field (`types.ts:144-145`, `freshness.ts:72`), not a pin. (CLI/MCP/plugin manifests are `0.1.20` and aligned with each other; owned by PApp/PPlug.)
- V2 seal still labels `algorithm: "sha256-v1"` (`refinement-schemas.ts:276`) while hashing uses `FRESHNESS_V2_DOMAIN` (`hashing.ts:15,151`) — naming leftover, not filed (discriminator is `sealSchemaVersion: 2`)

## Recommendations
1. Finish the V1→V2 cutover in Plane C: engine reports match envelope payloads; `@deprecated` then delete V1 graph/seal/auth report types and `normalize*`.
2. Stop extending frozen `schemaVersion: 1` with optional fields. Next additive field is a bump plus a real legacy parser.
3. One exported `LIMITS`/`DEFAULTS` object for traversal Zod and the walk.
4. Remove or `@deprecated` `./legacy-planning` once tests do not need the subpath.
5. Do not add retriever/`ContextPack` surface to Plane C (ADR 0005). Graph walk stays impact/justification/gating.
