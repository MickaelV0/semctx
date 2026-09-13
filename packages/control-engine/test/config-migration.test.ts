import { describe, expect, test } from "bun:test";
import type { ConfigMigrationDiscoveryLedgerV1, ConfigMigrationPlanDetailsV1 } from "@semantic-context/control-model";
import {
  computeConfigMigrationPlanDigest,
  decideConfigMigrationRestoreOutcome,
  diffConfigMigrationSelection,
  driftedConfigPolicyFields,
} from "../src";

function ledger(selected: readonly string[], excluded: readonly string[] = []): ConfigMigrationDiscoveryLedgerV1 {
  return {
    candidates: [
      ...selected.map((relPath) => ({ relPath, language: "typescript", selectionDecision: "selected" as const, reason: "SELECTED" })),
      ...excluded.map((relPath) => ({ relPath, language: "typescript", selectionDecision: "excluded" as const, reason: "INCLUDE_MISS" })),
    ],
  };
}

const planDetails: ConfigMigrationPlanDetailsV1 = {
  currentConfigDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  proposedConfigDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  legacyDiscovery: ledger(["src/a.ts"]),
  proposedDiscovery: ledger(["src/a.ts", "src/b.ts"]),
  selectionDiff: { added: ["src/b.ts"], removed: [], unchanged: ["src/a.ts"] },
  authoredInventory: [],
  verificationState: { present: false, digest: null },
};

describe("diffConfigMigrationSelection", () => {
  test("reports added, removed and unchanged as sorted, disjoint sets", () => {
    const legacy = ledger(["src/a.ts", "src/z.ts"]);
    const proposed = ledger(["src/a.ts", "src/b.ts"]);
    expect(diffConfigMigrationSelection(legacy, proposed)).toEqual({
      added: ["src/b.ts"],
      removed: ["src/z.ts"],
      unchanged: ["src/a.ts"],
    });
  });

  test("an explicit empty proposed selection reports every legacy path as removed", () => {
    const legacy = ledger(["src/a.ts", "src/b.ts"]);
    const proposed = ledger([]);
    expect(diffConfigMigrationSelection(legacy, proposed)).toEqual({
      added: [],
      removed: ["src/a.ts", "src/b.ts"],
      unchanged: [],
    });
  });

  test("ignores excluded candidates entirely", () => {
    const legacy = ledger(["src/a.ts"], ["src/skip.ts"]);
    const proposed = ledger(["src/a.ts"], ["src/skip.ts"]);
    expect(diffConfigMigrationSelection(legacy, proposed)).toEqual({
      added: [],
      removed: [],
      unchanged: ["src/a.ts"],
    });
  });
});

describe("driftedConfigPolicyFields", () => {
  const current = {
    version: 1,
    include: ["src/**/*.ts"],
    exclude: ["node_modules"],
    docsDirs: ["docs"],
    migrationsDirs: ["migrations"],
    testGlobs: ["**/*.test.ts"],
    semanticProvider: "none",
    blockingRules: [],
  };

  test("allows the five migratable fields to change freely", () => {
    const proposed = {
      ...current,
      version: 2,
      selectionMode: "globs-v1",
      include: ["src/**/*.{ts,py}"],
      exclude: ["node_modules", "dist"],
      languages: { typescript: "on" },
    };
    expect(driftedConfigPolicyFields(current, proposed)).toEqual([]);
  });

  test("flags a changed non-selection field", () => {
    const proposed = { ...current, version: 2, selectionMode: "globs-v1", languages: {}, docsDirs: ["changed"] };
    expect(driftedConfigPolicyFields(current, proposed)).toEqual(["docsDirs"]);
  });

  test("flags an unknown field silently dropped or altered", () => {
    const withUnknown = { ...current, futureField: { keep: true } };
    const dropped = { ...current, version: 2, selectionMode: "globs-v1", languages: {} };
    expect(driftedConfigPolicyFields(withUnknown, dropped)).toEqual(["futureField"]);
  });

  test("ignores repositoryRoot", () => {
    const withRoot = { ...current, repositoryRoot: "/a" };
    const proposed = { ...current, version: 2, selectionMode: "globs-v1", languages: {}, repositoryRoot: "/b" };
    expect(driftedConfigPolicyFields(withRoot, proposed)).toEqual([]);
  });

  test("flags an unknown field dropped even though it was explicitly null (presence, not value, matters)", () => {
    const withExplicitNull = { ...current, futureField: null };
    const dropped = { ...current, version: 2, selectionMode: "globs-v1", languages: {} };
    expect(driftedConfigPolicyFields(withExplicitNull, dropped)).toEqual(["futureField"]);
  });

  test("treats an explicit null and an absent key as identical presence+value on both sides", () => {
    const withExplicitNull = { ...current, futureField: null };
    const alsoExplicitNull = { ...current, version: 2, selectionMode: "globs-v1", languages: {}, futureField: null };
    expect(driftedConfigPolicyFields(withExplicitNull, alsoExplicitNull)).toEqual([]);
  });

  test("is safe against a prototype-named unknown field", () => {
    const withProtoKey = JSON.parse(`${JSON.stringify(current).slice(0, -1)},"__proto__":{"polluted":true}}`);
    const proposed = { ...current, version: 2, selectionMode: "globs-v1", languages: {} };
    expect(driftedConfigPolicyFields(withProtoKey, proposed)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("computeConfigMigrationPlanDigest", () => {
  test("is deterministic for identical facts and changes when a bound fact changes", () => {
    const first = computeConfigMigrationPlanDigest("/repo", planDetails);
    const second = computeConfigMigrationPlanDigest("/repo", planDetails);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

    const changed = computeConfigMigrationPlanDigest("/repo", { ...planDetails, verificationState: { present: true, digest: null } });
    expect(changed).not.toBe(first);

    const differentRoot = computeConfigMigrationPlanDigest("/other-repo", planDetails);
    expect(differentRoot).not.toBe(first);
  });
});

describe("decideConfigMigrationRestoreOutcome", () => {
  const before = `sha256:${"0".repeat(64)}`;
  const after = `sha256:${"1".repeat(64)}`;
  const third = `sha256:${"2".repeat(64)}`;

  test("finalizes without a write when current config already matches before", () => {
    expect(decideConfigMigrationRestoreOutcome(before, before, after, false)).toBe("finalize");
  });

  test("rewrites when current config still matches the applied value", () => {
    expect(decideConfigMigrationRestoreOutcome(after, before, after, false)).toBe("rewrite");
  });

  test("refuses on any third value without naming which of before/after it resembles", () => {
    expect(decideConfigMigrationRestoreOutcome(third, before, after, false)).toBe("refuse");
  });

  test("a terminal RESTORED run is idempotent only while config still equals before", () => {
    expect(decideConfigMigrationRestoreOutcome(before, before, after, true)).toBe("finalize");
  });

  test("a terminal RESTORED run refuses rather than rewrite, even if config now equals the old candidate", () => {
    expect(decideConfigMigrationRestoreOutcome(after, before, after, true)).toBe("refuse");
  });

  test("a terminal RESTORED run refuses on any other later value", () => {
    expect(decideConfigMigrationRestoreOutcome(third, before, after, true)).toBe("refuse");
  });
});
