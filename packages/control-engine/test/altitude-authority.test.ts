import { describe, expect, it } from "bun:test";
import {
  ALTITUDE_AUTHORITY_POLICY_V1,
  ALTITUDE_AUTHORITY_REGIME_ORDER,
  AltitudeAuthorityReportV1Schema,
  altitudeAuthorityRegimeRank,
  type AltitudeAuthorityRegimeV1,
} from "@semantic-context/control-model";
import { decideAltitudeAuthority } from "../src/altitude-authority";

const LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
const FRESH = { verdict: "FRESH", canRunHighRiskControl: true } as const;
const DIRTY = { verdict: "DIRTY_KNOWN", canRunHighRiskControl: true } as const;
const STALE = { verdict: "STALE", canRunHighRiskControl: false } as const;
const UNSEALED = { verdict: "UNSEALED", canRunHighRiskControl: false } as const;

describe("required-altitude authority policy", () => {
  it("maps every altitude to the regime the roadmap declares", () => {
    const regimes = LEVELS.map((level) => decideAltitudeAuthority({ requiredAltitude: level, freshness: FRESH }).regime);

    expect(regimes).toEqual([
      "autonomous",     // L0 syntax/hunks
      "autonomous",     // L1 symbols/tests/schemas
      "constrained",    // L2 components/boundaries
      "reviewed_plan",  // L3 capabilities
      "human_authority", // L4 invariants/policies
      "human_authority", // L5 product intent
      "human_authority", // L6 strategy/constraints
    ]);
  });

  it("never loosens as altitude rises", () => {
    const ranks = LEVELS.map((level) =>
      altitudeAuthorityRegimeRank(decideAltitudeAuthority({ requiredAltitude: level, freshness: FRESH }).regime));

    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]!).toBeGreaterThanOrEqual(ranks[index - 1]!);
    }
  });

  it("reports exactly the policy's obligations, always starting with the preflight", () => {
    for (const level of LEVELS) {
      const report = decideAltitudeAuthority({ requiredAltitude: level, freshness: FRESH });
      expect(report.obligations).toEqual([...ALTITUDE_AUTHORITY_POLICY_V1[level].obligations]);
      expect(report.obligations[0]).toBe("preflight_fresh_inputs");
    }
  });

  it("keeps each regime's obligations a superset of the looser one", () => {
    const byRegime = (regime: AltitudeAuthorityRegimeV1): readonly string[] => {
      const level = LEVELS.find((candidate) => ALTITUDE_AUTHORITY_POLICY_V1[candidate].regime === regime);
      expect(level).toBeDefined();
      return ALTITUDE_AUTHORITY_POLICY_V1[level!].obligations;
    };
    const ladder = ALTITUDE_AUTHORITY_REGIME_ORDER.map(byRegime);

    for (let index = 1; index < ladder.length; index += 1) {
      for (const obligation of ladder[index - 1]!) expect(ladder[index]).toContain(obligation);
      expect(ladder[index]!.length).toBeGreaterThan(ladder[index - 1]!.length);
    }
  });

  it("allows an autonomous write only at L0-L1 and only on trusted inputs", () => {
    for (const level of LEVELS) {
      const autonomousLevel = level <= 1;
      expect(decideAltitudeAuthority({ requiredAltitude: level, freshness: FRESH }).allowsAutonomousWrite)
        .toBe(autonomousLevel);
      expect(decideAltitudeAuthority({ requiredAltitude: level, freshness: DIRTY }).allowsAutonomousWrite)
        .toBe(autonomousLevel);
    }
  });

  it("withdraws autonomy at every altitude when the preflight is not trusted", () => {
    for (const freshness of [STALE, UNSEALED]) {
      for (const level of LEVELS) {
        const report = decideAltitudeAuthority({ requiredAltitude: level, freshness });
        expect(report.allowsAutonomousWrite).toBe(false);
        expect(report.reasons).toContain(`autonomous_write_withheld:freshness:${freshness.verdict}`);
      }
    }
  });

  it("grants no execution authority and stays schema-valid at every altitude", () => {
    for (const level of LEVELS) {
      for (const freshness of [FRESH, DIRTY, STALE, UNSEALED]) {
        const report = decideAltitudeAuthority({ requiredAltitude: level, freshness });
        expect(report.executionAuthority).toBe("none");
        expect(AltitudeAuthorityReportV1Schema.safeParse(report).success).toBe(true);
      }
    }
  });

  it("is deterministic for identical inputs", () => {
    const left = decideAltitudeAuthority({ requiredAltitude: 3, freshness: FRESH });
    const right = decideAltitudeAuthority({ requiredAltitude: 3, freshness: FRESH });
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});

describe("altitude authority report contract", () => {
  it("rejects a regime that contradicts the policy", () => {
    const report = decideAltitudeAuthority({ requiredAltitude: 5, freshness: FRESH });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...report, regime: "autonomous" }).success).toBe(false);
  });

  it("rejects obligations that do not match the altitude, including reordered ones", () => {
    const report = decideAltitudeAuthority({ requiredAltitude: 3, freshness: FRESH });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...report, obligations: ["preflight_fresh_inputs"] }).success)
      .toBe(false);
    expect(AltitudeAuthorityReportV1Schema.safeParse({
      ...report,
      obligations: [...report.obligations].reverse(),
    }).success).toBe(false);
  });

  it("rejects an autonomous write claimed without both the regime and trusted freshness", () => {
    const constrained = decideAltitudeAuthority({ requiredAltitude: 2, freshness: FRESH });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...constrained, allowsAutonomousWrite: true }).success)
      .toBe(false);

    const stale = decideAltitudeAuthority({ requiredAltitude: 0, freshness: STALE });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...stale, allowsAutonomousWrite: true }).success).toBe(false);
  });

  it("rejects a report that grants execution authority", () => {
    const report = decideAltitudeAuthority({ requiredAltitude: 0, freshness: FRESH });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...report, executionAuthority: "granted" }).success).toBe(false);
  });

  it("requires non-empty unique reasons", () => {
    const report = decideAltitudeAuthority({ requiredAltitude: 1, freshness: FRESH });
    expect(AltitudeAuthorityReportV1Schema.safeParse({ ...report, reasons: [] }).success).toBe(false);
    expect(AltitudeAuthorityReportV1Schema.safeParse({
      ...report,
      reasons: [...report.reasons, report.reasons[0]!],
    }).success).toBe(false);
  });
});
