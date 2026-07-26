import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { initWorkspace } from "@semantic-context/repository-store";
import { AltitudeAuthorityReportV1Schema } from "@semantic-context/control-model";
import { controlAltitudeAuthority, indexRepository } from "@semantic-context/app-services";
import { controlAuthorityTool } from "../src/control-tools";

const LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
let root: string;

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-authority-parity-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  git(root, "init");
  initWorkspace(root);
  initSemanticScaffold(root);
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
  indexRepository(root, "2026-07-26T00:00:00.000Z");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("required-altitude authority across hosts", () => {
  it("produces byte-identical reports through the MCP tool and the shared service", () => {
    for (const level of LEVELS) {
      const viaMcp = controlAuthorityTool(root, level);
      const viaService = controlAltitudeAuthority(root, level);
      expect(JSON.stringify(viaMcp)).toBe(JSON.stringify(viaService));
      expect(AltitudeAuthorityReportV1Schema.safeParse(viaMcp).success).toBe(true);
    }
  });

  it("binds the report to the repository's real freshness verdict", () => {
    const report = controlAuthorityTool(root, 0);

    expect(report.freshness.verdict).toBe("FRESH");
    expect(report.freshness.canRunHighRiskControl).toBe(true);
    expect(report.allowsAutonomousWrite).toBe(true);
    expect(report.reasons).toContain("freshness_verdict:FRESH");
  });

  it("withdraws autonomous write once the repository's inputs stop being trusted", () => {
    // Drift the authored lifecycle so the preflight degrades to UNSEALED without touching the index.
    Bun.write(join(root, ".semctx", "working", "active-change.sem"), "not a semantic block\n");

    const report = controlAuthorityTool(root, 0);

    expect(report.freshness.canRunHighRiskControl).toBe(false);
    expect(report.regime).toBe("autonomous");
    expect(report.allowsAutonomousWrite).toBe(false);
    expect(report.reasons).toContain(`autonomous_write_withheld:freshness:${report.freshness.verdict}`);
    expect(AltitudeAuthorityReportV1Schema.safeParse(report).success).toBe(true);
  });

  it("grants no execution authority at any altitude", () => {
    for (const level of LEVELS) {
      expect(controlAuthorityTool(root, level).executionAuthority).toBe("none");
    }
  });
});
