import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { changedPaths, planForPaths, planFromGit, TEST_SHARDS, type CiLane } from "../ci-plan";

const present = () => true;
const rows = (paths: string[]) => planForPaths(paths, present).matrix.include;
const lanes = (paths: string[]) => rows(paths).map((row) => [row.os, row.profile, row.shard]);

const UBUNTU_FULL = [["ubuntu-latest", "full", "1/2"], ["ubuntu-latest", "full", "2/2"]];
const shards = (os: CiLane["os"], profile: CiLane["profile"]) =>
  Array.from({ length: TEST_SHARDS[os] }, (_, index) => [os, profile, `${index + 1}/${TEST_SHARDS[os]}`]);

describe("adaptive CI plan", () => {
  test("documentation uses the contract lane; gate wiring also exercises the runner on both other OSes", () => {
    expect(planForPaths(["docs/reference/cli.md"], present).mode).toBe("docs");
    expect(lanes(["docs/reference/cli.md"])).toEqual([
      ["ubuntu-latest", "contract", ""],
    ]);
    expect(planForPaths([".github/workflows/ci.yml", "docs/adr/0013-contributor-autonomy-and-required-ci.md"], present).mode)
      .toBe("routing");
    expect(lanes(["scripts/ci-plan.ts"])).toEqual([
      ["ubuntu-latest", "contract", ""],
      ["windows-latest", "focused", ""],
      ["macos-15", "focused", ""],
    ]);
    expect(rows(["scripts/ci-plan.ts"]).slice(1).every((row) =>
      row.targets.includes("scripts/test/ci-plan.test.ts"))).toBe(true);
  });

  test("the translated README and the SVG figures it embeds are documentation; other docs data is not", () => {
    const readme = ["README.fr.md", "README.md", "docs/assets/readme/hero-dark.svg"];
    expect(planForPaths(readme, present).mode).toBe("docs");
    expect(lanes(readme)).toEqual([["ubuntu-latest", "contract", ""]]);
    expect(planForPaths(["docs/pilot/public-corpus-2026-09-08.json"], present).mode).toBe("fallback");
    expect(planForPaths(["docs/assets/readme/figure.js"], present).mode).toBe("fallback");
  });

  test("a product change runs the full Ubuntu gate and affected package tests on both other OSes", () => {
    const targets = "apps/cli/test,packages/app-services/test";
    const product = rows(["apps/cli/src/commands/install.ts", "packages/app-services/src/plugin-delivery.ts"]);
    expect(product[0]).toEqual({ os: "ubuntu-latest", profile: "contract", targets: "", smoke: "false", shard: "" });
    expect(product.slice(1).map((row) => [row.os, row.profile, row.shard])).toEqual([
      ...UBUNTU_FULL, ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(product.slice(1).map((row) => row.targets)).toEqual(product.slice(1).map((row) =>
      row.profile === "full" ? "" : targets));
    expect(product.every((row) => row.smoke === "false")).toBe(true);
  });

  test("Markdown inside plugins and packages is domain content, not documentation-only", () => {
    const plugin = rows(["plugins/shared/skills/semctx-control/SKILL.md"]);
    expect(plugin.map((row) => [row.os, row.profile, row.shard])).toEqual([
      ["ubuntu-latest", "contract", ""], ...UBUNTU_FULL,
      ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(plugin.filter((row) => row.profile === "focused").every((row) => row.targets === "plugins")).toBe(true);
    expect(rows(["packages/app-services/README.md"]).find((row) => row.profile === "focused")?.targets)
      .toBe("packages/app-services/test");
    expect(planForPaths(["scripts/README.md"], present).mode).toBe("fallback");
  });

  test("worker source also executes real small equivalence on all three OSes", () => {
    const workerRows = rows(["packages/ts-analyzer/src/index-worker.ts"]);
    expect(workerRows.filter((row) => row.smoke === "true").map((row) => [row.os, row.profile, row.shard])).toEqual([
      ...UBUNTU_FULL, ...shards("windows-latest", "focused"), ...shards("macos-15", "focused"),
    ]);
    expect(workerRows.filter((row) => row.profile === "focused").every((row) => row.targets === "packages/ts-analyzer/test"))
      .toBe(true);
    expect(new Set(rows(["packages/app-services/src/plane-a-runtime.ts"]).filter((row) => row.smoke === "true")
      .map((row) => row.os))).toEqual(new Set(["ubuntu-latest", "windows-latest", "macos-15"]));
  });

  test("every suite lane is split into one complete shard set per host; contract and routing lanes are whole", () => {
    expect(TEST_SHARDS).toEqual({ "ubuntu-latest": 2, "windows-latest": 4, "macos-15": 2 });
    const plans = [
      ["package.json"], ["packages/app-services/src/plane-a-runtime.ts"], ["plugins/claude-code/src/guard.ts"],
      ["scripts/ci-plan.ts"], ["docs/reference/cli.md"],
    ].map((paths) => planForPaths(paths, present));
    expect(plans.map((plan) => plan.mode)).toEqual(["fallback", "affected", "affected", "routing", "docs"]);
    for (const plan of plans) {
      const groups = new Map<string, string[]>();
      for (const row of plan.matrix.include) {
        if (row.profile === "contract" || plan.mode === "routing") {
          expect(row.shard).toBe("");
          continue;
        }
        const key = JSON.stringify([row.os, row.profile, row.targets, row.smoke]);
        groups.set(key, [...(groups.get(key) ?? []), row.shard]);
      }
      for (const [key, observed] of groups) {
        const os = (JSON.parse(key) as [CiLane["os"]])[0];
        expect(observed).toEqual(shards(os, "full").map((row) => row[2]!));
      }
    }
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
    expect(plan.matrix.include.map((row) => [row.os, row.profile, row.shard])).toEqual([
      ["ubuntu-latest", "contract", ""],
      ...UBUNTU_FULL,
      ...shards("windows-latest", "full"),
      ...shards("macos-15", "full"),
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

test.skipIf(process.platform === "win32")("a real Git deadline selects the complete CI fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ci-plan-budget-"));
  try {
    const gitPath = join(root, "git");
    writeFileSync(gitPath, `#!/bin/sh\nexec "${process.execPath}" -e 'await Bun.sleep(6500)'\n`);
    chmodSync(gitPath, 0o755);
    const entrypoint = join(import.meta.dir, "../ci-plan.ts");
    const result = Bun.spawnSync([process.execPath, "-e", `import { planFromGit } from ${JSON.stringify(entrypoint)}; console.log(JSON.stringify(planFromGit("main", ${JSON.stringify(root)})));`], {
      env: { ...process.env, PATH: root }, stdout: "pipe", stderr: "pipe", timeout: 8000, killSignal: "SIGKILL",
    });
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(plan.mode).toBe("fallback");
    expect(plan.reason).toBe("diff unavailable");
    expect(new Set(plan.matrix.include.map((lane: CiLane) => lane.os))).toEqual(new Set(["ubuntu-latest", "macos-15", "windows-latest"]));
    expect(new Set(plan.matrix.include.filter((lane: CiLane) => lane.profile === "full").map((lane: CiLane) => lane.os))).toEqual(new Set(["ubuntu-latest", "macos-15", "windows-latest"]));
    expect(plan.matrix.include.filter((lane: CiLane) => lane.os !== "ubuntu-latest").every((lane: CiLane) => lane.smoke === "true")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/**
 * Package specifiers reachable from `entry` through relative imports, each with the chain that
 * reaches it. Node and Bun built-ins are not packages: they need no installation.
 */
function packageImports(entry: string): Map<string, string> {
  const builtins = new Set(builtinModules);
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const transpiler = new Bun.Transpiler({ loader: /\.m?js$/.test(file) ? "js" : "ts" });
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) {
        if (!/^(?:node|bun):/.test(path) && !builtins.has(path) && !found.has(path)) found.set(path, chain.join(" -> "));
        continue;
      }
      const target = [path, `${path}.ts`, `${path}.mjs`, `${path}/index.ts`]
        .map((candidate) => resolve(dirname(file), candidate))
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target === undefined || target.endsWith(".json")) continue;
      visit(target, [...chain, target.slice(REPOSITORY_ROOT.length + 1).replaceAll("\\", "/")]);
    }
  };
  const start = join(REPOSITORY_ROOT, entry);
  visit(start, [entry]);
  return found;
}

describe("planner and bootstrap scripts need no installed dependencies", () => {
  // The CI `plan` job runs `bun scripts/ci-plan.ts` before any `bun install`, and the contributor
  // helper diagnoses a missing install: neither may reach a package import (zod through core).
  test.each(["scripts/ci-plan.ts", "scripts/verify-pr.ts", "scripts/contributor.ts"])(
    "%s imports only built-ins and relative modules",
    (entry) => {
      expect(Object.fromEntries(packageImports(entry))).toEqual({});
    },
  );

  function checkout(): { root: string; git: (...args: string[]) => string } {
    const root = mkdtempSync(join(tmpdir(), "semctx-no-install-"));
    const git = (...args: string[]): string => {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
      const result = Bun.spawnSync(["git", "-c", "user.name=No Install", "-c", "user.email=no-install@example.invalid", ...args], {
        cwd: root, env: environment, stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    // Exactly what the script itself may reach: no node_modules, no workspace packages.
    for (const file of ["scripts/ci-plan.ts", "scripts/verify-pr.ts", "plugins/shared/hooks/process-budget.mjs"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(REPOSITORY_ROOT, file), join(root, file));
    }
    git("init", "--quiet");
    return { root, git };
  }

  // A caller's own GIT_DIR (a hook, a wrapper, `git -C` inside another repository) must not steer
  // the diff or the untracked listing: the child is started with it in its real environment.
  function steeredRepositories(): { root: string; target: string; foreign: string; git: (cwd: string, ...args: string[]) => string } {
    const root = mkdtempSync(join(tmpdir(), "semctx-git-steering-"));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
    const git = (cwd: string, ...args: string[]): string => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Steering", "-c", "user.email=steering@example.invalid", ...args], {
        cwd, env: environment, stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const target = join(root, "target");
    const foreign = join(root, "foreign");
    for (const directory of [target, foreign]) {
      mkdirSync(directory);
      git(directory, "init", "--quiet");
      // Distinct tracked names: under a stolen index the target's tracked file would also look untracked.
      writeFileSync(join(directory, directory === target ? "tracked.txt" : "foreign.txt"), "x\n");
      git(directory, "add", ".");
      git(directory, "commit", "--quiet", "-m", "base");
    }
    return { root, target, foreign, git };
  }

  test("changedPaths ignores a GIT_DIR in the caller's real environment", () => {
    const { root, target, foreign, git } = steeredRepositories();
    try {
      const base = git(target, "rev-parse", "HEAD");
      mkdirSync(join(target, "docs"));
      writeFileSync(join(target, "docs/changed.md"), "# changed\n");
      git(target, "add", ".");
      git(target, "commit", "--quiet", "-m", "change");
      const entry = `import { changedPaths } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/ci-plan.ts"))}; console.log(JSON.stringify(changedPaths(${JSON.stringify(base)}, ${JSON.stringify(target)})));`;
      const result = Bun.spawnSync([process.execPath, "-e", entry], {
        env: { ...process.env, GIT_DIR: join(foreign, ".git") }, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
      });
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toEqual(["docs/changed.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("listUntrackedFiles ignores a GIT_DIR in the caller's real environment", () => {
    const { root, target, foreign } = steeredRepositories();
    try {
      writeFileSync(join(target, "untracked.txt"), "x\n");
      const entry = `import { listUntrackedFiles } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/verify-pr.ts"))}; console.log(JSON.stringify(await listUntrackedFiles(${JSON.stringify(target)})));`;
      const result = Bun.spawnSync([process.execPath, "-e", entry], {
        env: { ...process.env, GIT_DIR: join(foreign, ".git") }, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
      });
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toEqual({ exitCode: 0, paths: ["untracked.txt"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // A `git` that takes 6.5 s on PATH (`git.cmd` on Windows): the 5 s Git deadline must fire first.
  function stalledGit(root: string): void {
    const sleeper = `"${process.execPath}" -e "await Bun.sleep(6500)"`;
    if (process.platform === "win32") {
      writeFileSync(join(root, "git.cmd"), `@echo off\r\n${sleeper}\r\n`);
    } else {
      writeFileSync(join(root, "git"), `#!/bin/sh\nexec ${sleeper}\n`);
      chmodSync(join(root, "git"), 0o755);
    }
  }

  /** On Windows the killed launcher's sleeper keeps its working directory open for a moment. */
  function removeWhenReleased(path: string): void {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        rmSync(path, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(250);
      }
    }
  }

  // Timed inside the child so that startup load cannot masquerade as a missed deadline.
  function stalledOutcome(root: string, program: string): { outcome: string; elapsed: number } {
    const result = Bun.spawnSync([process.execPath, "-e", program], {
      env: { ...process.env, PATH: root }, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
    });
    return JSON.parse(result.stdout.toString()) as { outcome: string; elapsed: number };
  }

  test("changedPaths refuses a stalled Git within its deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ci-plan-stall-"));
    try {
      stalledGit(root);
      const program = `import { changedPaths } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/ci-plan.ts"))};
const started = performance.now();
const paths = changedPaths("HEAD~1", ${JSON.stringify(root)});
console.log(JSON.stringify({ outcome: paths === null ? "refused" : "listed", elapsed: performance.now() - started }));`;
      const { outcome, elapsed } = stalledOutcome(root, program);
      expect(outcome).toBe("refused");
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      removeWhenReleased(root);
    }
  }, 30_000);

  test("listUntrackedFiles refuses a stalled Git within its deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-verify-pr-budget-"));
    try {
      stalledGit(root);
      const program = `import { listUntrackedFiles } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/verify-pr.ts"))};
const started = performance.now();
let outcome = "listed";
try { await listUntrackedFiles(${JSON.stringify(root)}); } catch (error) { outcome = String(error); }
console.log(JSON.stringify({ outcome, elapsed: performance.now() - started }));`;
      const { outcome, elapsed } = stalledOutcome(root, program);
      expect(outcome).toContain("PROCESS_TIMEOUT: Git capture refused");
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      removeWhenReleased(root);
    }
  }, 30_000);

  test("ci-plan.ts selects lanes in a checkout without node_modules", () => {
    const { root, git } = checkout();
    try {
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      mkdirSync(join(root, "docs/reference"), { recursive: true });
      writeFileSync(join(root, "docs/reference/cli.md"), "# CLI\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "docs");
      const environment = { ...process.env, SEMCTX_VERIFY_BASE: base, GITHUB_EVENT_NAME: "pull_request" } as Record<string, string | undefined>;
      delete environment["GITHUB_OUTPUT"];
      const result = Bun.spawnSync([process.execPath, "--no-install", join(root, "scripts/ci-plan.ts")], {
        cwd: root, env: environment, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toContain("[ci-plan] docs: documentation only; 1 lane(s)");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("verify-pr.ts lists untracked files in a checkout without node_modules", () => {
    const { root, git } = checkout();
    try {
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      writeFileSync(join(root, "untracked.txt"), "x\n");
      const entry = 'import { listUntrackedFiles } from "./scripts/verify-pr.ts"; console.log(JSON.stringify(await listUntrackedFiles(process.cwd())));';
      const result = Bun.spawnSync([process.execPath, "--no-install", "-e", entry], {
        cwd: root, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
      });
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toEqual({ exitCode: 0, paths: ["untracked.txt"] });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
