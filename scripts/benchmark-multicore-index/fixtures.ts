import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGitState, fingerprintAnalysisInputs } from "@semantic-context/app-services";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { discoverRepository } from "@semantic-context/ts-analyzer";

export type CorpusId =
  | "disconnected-modules"
  | "global-script-fallback"
  | "module-augmentation-fallback";

export const CORPUS_IDS: readonly CorpusId[] = [
  "disconnected-modules",
  "global-script-fallback",
  "module-augmentation-fallback",
];

export interface CorpusDimensions {
  packages: number;
  filesPerPackage: number;
}

/** Fallback is a property of one hostile file, not of scale: bounded regardless of the CLI-supplied dimensions. */
export const HOSTILE_CORPUS_DIMENSIONS: CorpusDimensions = { packages: 1, filesPerPackage: 4 };

export interface FixtureIdentity {
  sourceCommit: string | null;
  analysisInputHash: string;
  /** Digest of the exact config used to initialize the corpus workspace (include globs, dimensions-derived paths). */
  configIdentity: string;
}

/** Deterministic, disconnected-per-package module graph: the safe corpus whose size the CLI controls. */
function materializeDisconnectedModules(repositoryRoot: string, dimensions: CorpusDimensions): void {
  writeFileSync(join(repositoryRoot, "package.json"), `${JSON.stringify({
    name: "semctx-multicore-benchmark",
    private: true,
    workspaces: ["packages/*"],
  }, null, 2)}\n`);
  writeFileSync(join(repositoryRoot, ".gitignore"), ".semctx/\n");
  writeFileSync(join(repositoryRoot, "shared.d.ts"), "declare interface BenchmarkContext { value: number }\n");
  for (let packageIndex = 0; packageIndex < dimensions.packages; packageIndex += 1) {
    const packageName = `package-${String(packageIndex).padStart(3, "0")}`;
    const packageRoot = join(repositoryRoot, "packages", packageName);
    const source = join(packageRoot, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: `@semctx-benchmark/${packageName}`,
      private: true,
    }, null, 2)}\n`);
    for (let fileIndex = 0; fileIndex < dimensions.filesPerPackage; fileIndex += 1) {
      const predecessor = fileIndex === 0 ? undefined : `./file-${String(fileIndex - 1).padStart(3, "0")}`;
      writeFileSync(
        join(source, `file-${String(fileIndex).padStart(3, "0")}.ts`),
        `${predecessor === undefined ? "" : `import { value${fileIndex - 1} } from '${predecessor}';\n`}`
          + `export function value${fileIndex}(context: BenchmarkContext): number { return context.value + ${fileIndex}`
          + `${predecessor === undefined ? "" : ` + value${fileIndex - 1}(context)`}; }\n`,
      );
    }
  }
}

/** A root TypeScript module with no import/export triggers ts-analyzer's "global script" preflight fallback. */
function materializeGlobalScriptFallback(repositoryRoot: string): void {
  writeFileSync(
    join(repositoryRoot, "packages", "package-000", "src", "hostile-global-script.ts"),
    "function benchmarkGlobalScriptFallbackHelper(): number { return 1; }\n",
  );
}

/** A `declare global` block triggers ts-analyzer's global/module-augmentation preflight fallback. */
function materializeModuleAugmentationFallback(repositoryRoot: string): void {
  writeFileSync(
    join(repositoryRoot, "packages", "package-000", "src", "hostile-augmentation.ts"),
    "export {};\ndeclare global {\n  interface BenchmarkGlobalAugmentation { readonly value: number }\n}\n",
  );
}

function commitFixture(repositoryRoot: string): void {
  git(repositoryRoot, "init", "-q");
  git(repositoryRoot, "add", ".");
  git(
    repositoryRoot,
    "-c", "user.name=Semctx Benchmark",
    "-c", "user.email=benchmark@semctx.test",
    "commit", "-q", "-m", "fixture",
  );
}

function initializeWorkspace(repositoryRoot: string): void {
  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(repositoryRoot),
    include: ["packages/**/*.ts", "shared.d.ts"],
  };
  initWorkspace(repositoryRoot, config);
}

export function materializeCorpus(id: CorpusId, repositoryRoot: string, dimensions: CorpusDimensions): void {
  materializeDisconnectedModules(repositoryRoot, dimensions);
  if (id === "global-script-fallback") materializeGlobalScriptFallback(repositoryRoot);
  if (id === "module-augmentation-fallback") materializeModuleAugmentationFallback(repositoryRoot);
  commitFixture(repositoryRoot);
  initializeWorkspace(repositoryRoot);
}

/** Source identity for the materialized fixture: the commit it was frozen at, and its analyzer content hash. */
export function captureFixtureIdentity(repositoryRoot: string): FixtureIdentity {
  const sourceCommit = captureGitState(repositoryRoot).headCommit;
  const config = loadConfig(repositoryRoot);
  const discovery = discoverRepository(config);
  return {
    sourceCommit,
    analysisInputHash: fingerprintAnalysisInputs(config, discovery.files),
    configIdentity: digestCanonical(config),
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
