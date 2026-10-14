import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChangeImpactReportSchema, type ChangeImpactReport } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { controlStatus, indexRepository, indexRepositoryAsync, runChangeImpact, runVerify } from "../src";

/**
 * Issue #354: a repository that imports exclusively by tsconfig `paths` alias used to index with
 * no `imports` edge, no cross-file `calls` edge and no test link, so impact and verification
 * returned empty sets that read as "nothing depends on this".
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "core.autocrlf=false", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const tsconfig = (paths: Record<string, string[]>): string => JSON.stringify({
  compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: ".", noEmit: true, paths },
  include: ["src"],
}, null, 2) + "\n";

const ALIAS = { "@r/pkg/*": ["./src/*", "./src/*.ts"] };

function aliasRepository(indexNow = true): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-path-alias-"))).replaceAll("\\", "/");
  roots.push(root);
  write(root, {
    ".gitignore": ".semctx/\n",
    "package.json": JSON.stringify({ name: "repro-root", private: true, packageManager: "pnpm@10.0.0" }),
    "pnpm-workspace.yaml": 'packages:\n  - "pkg"\n',
    "pkg/package.json": JSON.stringify({ name: "@r/pkg", version: "1.0.0" }),
    "pkg/tsconfig.json": tsconfig(ALIAS),
    "pkg/src/feat/handler.ts": "export function handle(n: number): number { return n + 1; }\n",
    "pkg/src/feat/alias-js-user.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport function viaAliasJs(): number { return handle(1); }\n',
    "pkg/src/feat/alias-noext-user.ts": 'import { handle } from "@r/pkg/feat/handler";\nexport function viaAliasNoExt(): number { return handle(1); }\n',
    "pkg/src/feat/relative-user.ts": 'import { handle } from "./handler.js";\nexport function viaRelative(): number { return handle(2); }\n',
    "pkg/src/feat/handler.spec.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport const result = handle(3);\n',
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root, {
    version: 2,
    selectionMode: "globs-v1",
    include: ["pkg/**/*.ts"],
    exclude: [],
    languages: { typescript: "on", javascript: "off", python: "off", markdown: "off", sql: "off" },
  });
  if (indexNow) indexRepository(root, "2026-10-14T10:00:00.000Z");
  return root;
}

const reached = (report: ChangeImpactReport): string[] => [
  ...(report.directlyAffected ?? []),
  ...(report.transitivelyAffected ?? []),
  ...(report.possiblyAffected ?? []),
].map(target => target.id).sort();

describe("tsconfig path aliases in an indexed TypeScript-only repository", () => {
  it("reaches the aliased importers and their test from a change to the target", () => {
    const root = aliasRepository();
    const store = openStore(root);
    try {
      const graph = store.loadGraph();
      const imports = graph.edges.filter(edge => edge.kind === "imports").map(edge => `${edge.from} -> ${edge.to}`).sort();
      expect(imports).toEqual([
        "mod:pkg/src/feat/alias-js-user.ts -> mod:pkg/src/feat/handler.ts",
        "mod:pkg/src/feat/alias-noext-user.ts -> mod:pkg/src/feat/handler.ts",
        "mod:pkg/src/feat/relative-user.ts -> mod:pkg/src/feat/handler.ts",
        "test:pkg/src/feat/handler.spec.ts -> mod:pkg/src/feat/handler.ts",
      ]);
    } finally {
      store.close();
    }
    write(root, { "pkg/src/feat/handler.ts": "export function handle(n: number): number { return n + 2; }\n" });

    const impact = runChangeImpact(root, { kind: "working-tree" });
    ChangeImpactReportSchema.parse(impact);
    expect(reached(impact)).toEqual(expect.arrayContaining([
      "sym:function:pkg/src/feat/alias-js-user.ts:viaAliasJs",
      "sym:function:pkg/src/feat/alias-noext-user.ts:viaAliasNoExt",
      "sym:function:pkg/src/feat/relative-user.ts:viaRelative",
      "test:pkg/src/feat/handler.spec.ts",
    ]));
    expect(impact.blastRadius.scope).not.toBe("unknown");

    const verification = runVerify(root, { kind: "working-tree" }).report;
    expect(verification.recommendedTests.map(test => test.file)).toContain("pkg/src/feat/handler.spec.ts");
  });

  // `semctx index` runs the asynchronous path with one worker unless told otherwise.
  it("indexes the alias edges through the default single-worker path", async () => {
    const root = aliasRepository(false);
    const index = await indexRepositoryAsync(root, "2026-10-14T10:00:00.000Z", 1);
    expect(index.parallelism).toMatchObject({ requested: 1, mode: "single" });
    const store = openStore(root);
    try {
      const imports = store.loadGraph().edges.filter(edge => edge.kind === "imports").map(edge => edge.from).sort();
      expect(imports).toEqual([
        "mod:pkg/src/feat/alias-js-user.ts",
        "mod:pkg/src/feat/alias-noext-user.ts",
        "mod:pkg/src/feat/relative-user.ts",
        "test:pkg/src/feat/handler.spec.ts",
      ]);
    } finally {
      store.close();
    }
  });

  it("withdraws the index when the alias mapping changes", () => {
    const root = aliasRepository();
    expect(controlStatus(root).verdict).toBe("FRESH");
    write(root, { "pkg/tsconfig.json": tsconfig({ "@r/pkg/*": ["./elsewhere/*"] }) });
    // The tracked configuration also differs from the indexed working diff; the analysis input
    // reason is the one that withdraws the alias edges, whatever else is reported.
    const stale = controlStatus(root);
    expect(stale.verdict).toBe("STALE");
    expect(stale.reasons).toContain("ANALYSIS_INPUT_MISMATCH");
    write(root, { "pkg/tsconfig.json": tsconfig(ALIAS) });
    expect(controlStatus(root).verdict).toBe("FRESH");
  });
});
