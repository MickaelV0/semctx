import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, planForPaths, planFromGit } from "../ci-plan";

const present = () => true;
const rows = (paths: string[]) => planForPaths(paths, present).matrix.include;

describe("adaptive CI plan", () => {
  test("documentation uses the contract lane; gate wiring also exercises the runner on both other OSes", () => {
    expect(planForPaths(["docs/reference/cli.md"], present).mode).toBe("docs");
    expect(rows(["docs/reference/cli.md"]).map((row) => [row.os, row.profile])).toEqual([
      ["ubuntu-latest", "contract"],
    ]);
    expect(planForPaths([".github/workflows/ci.yml", "docs/adr/0013-contributor-autonomy-and-required-ci.md"], present).mode)
      .toBe("routing");
    expect(rows(["scripts/ci-plan.ts"]).map((row) => [row.os, row.profile])).toEqual([
      ["ubuntu-latest", "contract"],
      ["windows-latest", "focused"],
      ["macos-15", "focused"],
    ]);
    expect(rows(["scripts/ci-plan.ts"]).slice(1).every((row) =>
      row.targets.includes("scripts/test/ci-plan.test.ts"))).toBe(true);
  });

  test("a product change runs the full Ubuntu gate and affected package tests on both other OSes", () => {
    expect(rows(["apps/cli/src/commands/install.ts", "packages/app-services/src/plugin-delivery.ts"])).toEqual([
      { os: "ubuntu-latest", profile: "contract", targets: "", smoke: "false" },
      { os: "ubuntu-latest", profile: "full", targets: "", smoke: "false" },
      { os: "windows-latest", profile: "focused", targets: "apps/cli/test,packages/app-services/test", smoke: "false" },
      { os: "macos-15", profile: "focused", targets: "apps/cli/test,packages/app-services/test", smoke: "false" },
    ]);
  });

  test("Markdown inside plugins and packages is domain content, not documentation-only", () => {
    const plugin = rows(["plugins/shared/skills/semctx-control/SKILL.md"]);
    expect(plugin.map((row) => row.profile)).toEqual(["contract", "full", "focused", "focused"]);
    expect(plugin[2]?.targets).toBe("plugins");
    expect(rows(["packages/app-services/README.md"])[2]?.targets).toBe("packages/app-services/test");
    expect(planForPaths(["scripts/README.md"], present).mode).toBe("fallback");
  });

  test("worker source also executes real small equivalence on all three OSes", () => {
    const workerRows = rows(["packages/ts-analyzer/src/index-worker.ts"]);
    expect(workerRows.filter((row) => row.smoke === "true").map((row) => row.os)).toEqual([
      "ubuntu-latest", "windows-latest", "macos-15",
    ]);
    expect(workerRows.filter((row) => row.profile === "focused").every((row) => row.targets === "packages/ts-analyzer/test"))
      .toBe(true);
    expect(rows(["packages/app-services/src/plane-a-runtime.ts"]).filter((row) => row.smoke === "true"))
      .toHaveLength(3);
  });

  test.each([
    ["package.json"],
    ["bun.lock"],
    [".github/workflows/release.yml"],
    ["packages/new-domain/src/index.ts"],
    ["AGENTS.md"],
    ["scripts/unknown-verifier.ts"],
    ["docs/reference/cli.md", "package.json"],
    [],
  ].map((paths) => ({ paths })))("falls back to full cross-platform proof for unknown or sensitive paths: %j", ({ paths }) => {
    const plan = planForPaths(paths, present);
    expect(plan.mode).toBe("fallback");
    expect(plan.matrix.include.map((row) => [row.os, row.profile])).toEqual([
      ["ubuntu-latest", "contract"],
      ["ubuntu-latest", "full"],
      ["windows-latest", "full"],
      ["macos-15", "full"],
    ]);
  });

  test("a missing focused test root cannot silently omit that host", () => {
    expect(planForPaths(["apps/cli/src/commands/install.ts"], () => false).mode).toBe("fallback");
  });

  test("rejects malformed path bytes and never returns an empty matrix", () => {
    for (const path of ["../packages/core/src/index.ts", "packages\\core\\src\\index.ts", "docs/a\nb.md", ""] ) {
      const plan = planForPaths([path], present);
      expect(plan.mode).toBe("fallback");
      expect(plan.matrix.include.length).toBeGreaterThan(0);
    }
  });
});

test("Git diff treats a rename as both deletion and addition and missing base as maximal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "semctx-ci-plan-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--quiet");
    git("config", "user.email", "ci-plan@example.invalid");
    git("config", "user.name", "CI Plan Test");
    writeFileSync(join(cwd, "old.md"), "old\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.md", "AGENTS.md");
    git("commit", "--quiet", "-m", "rename");
    expect(changedPaths(base, cwd)).toEqual(["AGENTS.md", "old.md"]);
    expect(planFromGit(base, cwd).mode).toBe("fallback");
    expect(planFromGit("missing-base", cwd).mode).toBe("fallback");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
