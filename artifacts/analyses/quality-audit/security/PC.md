# Security — PC

## Summary
Reviewed Plane C production source (`packages/control-model/src`, `packages/control-engine/src`, `packages/change-authorization-verifier/src`; 54 `.ts` files). SECURITY.md’s local-core claims hold here: no spawn, SQL, `node:fs`, `fetch`, or ambient clock in src; the offline verifier is graph-in and pins `executionAuthority: "none"`. Authorization PASSED is fail-closed unless an externally supplied authority digest matches and both historical and current re-derivations ALLOW. Worst issue is split path canonicalizers for L0 hunks vs envelopes (NUL / NFC / `.` diverge), plus freshness booleans that are not bound to STALE/UNSEALED at the altitude-report boundary.

## Findings

| ID | Sev | Location | Issue | Evidence | Fix | Confidence |
|----|-----|----------|-------|----------|-----|------------|
| SEC-PC-01 | P2 | packages/control-model/src/hashing.ts:30 | L0 hunk paths use a weaker canonicalizer than envelope/observation paths: NFC + reject `.`, but no NUL rejection; the envelope normalizer rejects NUL, collapses `.`, and does not NFC. Same repo path can mint two identities, and a NUL path is a valid hunk `normalizedPath`. | hashing.ts:37 `normalized.split("/").some((segment) => segment === "" \|\| segment === "." \|\| segment === "..")` vs task-envelope-canonical.ts:42 `if (input.includes("\\0")) throw`. | One normalizer for both; reject NUL/C0; pick NFC vs identity and `.` collapse vs reject once. | 90 |
| SEC-PC-02 | P2 | packages/control-engine/src/altitude-authority.ts:28 | Autonomous write is gated on caller `canRunHighRiskControl`, not on `verdict`. The altitude report schema repeats that boolean conjunction and never checks that STALE/UNSEALED imply `canRunHighRiskControl === false`. A report `{ verdict: "STALE", canRunHighRiskControl: true, allowsAutonomousWrite: true }` at L0/L1 is schema-valid. | altitude-authority.ts:28 `const trustedInputs = input.freshness.canRunHighRiskControl;` — contrast schemas.ts:167 `const allowed = value.verdict === "FRESH" \|\| value.verdict === "DIRTY_KNOWN"`. | Derive the boolean from verdict in `decideAltitudeAuthority`; copy the pairing into `AltitudeAuthorityReportV1Schema`. | 85 |
| SEC-PC-03 | P2 | packages/control-engine/src/traversal.ts:542 | `isStale` is true only when both seals are present and differ. Omitted seals (UNSEALED / default `lift`/`lower` bounds `{}`) are treated as not stale, so traversal proceeds. | traversal.ts:543 `return bounds.sourceSeal !== undefined && bounds.indexSeal !== undefined && bounds.sourceSeal !== bounds.indexSeal;` | Missing either seal → `refused` / `INDEX_STALE` (same as `refinementCoverage`, which already requires both). | 90 |
| SEC-PC-04 | P2 | packages/control-model/src/change-authorization-schemas.ts:560 | Capsule `safeParse` is self-consistency (hashes, subject projection, claimed evaluation rank), not policy replay. A hand-built ALLOW capsule with internally matching hashes can carry expired or untrusted evidence as `outcome: "satisfied"`; clock/trust checks live only in `evaluateRule` / verifier `derive`. | change-authorization-schemas.ts:567 `\|\| assertion.conclusion !== "SUPPORTS"` (no `expiresAt` / provider status). Replay is verify.ts:66 `deriveChangeAuthorizationVerificationDecisionV1({... evaluatedAt: sealed.evaluatedAt })`. | Never treat `ChangeAuthorizationCapsuleV1Schema` as verification; require `verifyChangeAuthorizationCapsuleV1` / `replayChangeAuthorizationV1` with a non-null expected digest before any ALLOW. | 88 |
| SEC-PC-05 | P3 | packages/control-engine/src/architecture.ts:42 | Graph fingerprint is raw SHA-256 hex with no domain separator; observation analysis then prefixes `sha256:`. Other Plane C digests NUL-prefix or wrap `{ domain, value }`. Type confusion with those families is unlikely (JSON never contains the auth NUL domains) but the fingerprint is the odd one out. | architecture.ts:42 `return createHash("sha256").update(stableJson(normalized)).digest("hex");` then observation-analysis.ts:251 `` candidateGraphHash: `sha256:${fingerprintCoordinateGraph(candidateGraph)}` ``. | Hash `SEMCTX_COORDINATE_GRAPH_FINGERPRINT_V1\\0` + JCS/stable JSON; return `Sha256Hash` directly. | 70 |

## Metrics
- Files read: 32 (54 Plane C src files scanned; tests/`dist` skipped)
- Findings: 5 (0 P0 / 0 P1 / 4 P2 / 1 P3)
- Injection sites reviewed: domain-prefixed SHA-256 (JCS vs `serializeControlReport`), L0 binary framing, two path normalizers, capsule/policy evaluation, altitude freshness, traversal seals, verifier request envelope
- Spawn sites in src: 0
- SQL sites in src: 0
- Path APIs in src: 2 normalizers (`normalizeObservedDiffPath`, `normalizeCanonicalRepoRelativePath`); no `node:path` / `path.join`
- Network / ambient clock / `JSON.parse` in src: 0 (`Date.parse` only on schema-validated timestamps)

## Recommendations
1. Collapse `normalizeObservedDiffPath` and `normalizeCanonicalRepoRelativePath` into one function used by L0 hunk identity, observation paths, and envelope bindings; reject NUL and other C0 bytes in both `normalizedPath` and `repositoryIdentity`.
2. Make `canRunHighRiskControl` a function of `verdict` everywhere (freshness status already does this); `decideAltitudeAuthority` and `AltitudeAuthorityReportV1Schema` must refuse STALE/UNSEALED + autonomy.
3. Treat missing traversal seals as UNSEALED: refuse, do not walk.
4. Keep the verifier host-free and continue to require an out-of-capsule `expectedAuthorityDescriptorDigest` for PASSED (null → REQUIRE_EVIDENCE is correct). Share `evaluateRule` between `control-engine` and the verifier so replay cannot drift.
5. Domain-separate `fingerprintCoordinateGraph` like L0 (`SEMCTXL0`) and authorization (NUL-terminated UTF-8 domains).
