import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
export const PLUGIN_SOURCE = resolve(root, "plugins/claude-code");

function listRelativeFiles(dir: string, acc: string[] = [], prefix = ""): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git") continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) listRelativeFiles(full, acc, rel);
    else acc.push(rel);
  }
  return acc;
}

export function overlayOmpMcp(mirrorRoot: string): void {
  const ompSafe = readFileSync(join(mirrorRoot, "mcp-omp.json"), "utf8");
  writeFileSync(join(mirrorRoot, ".mcp.json"), ompSafe);
}

export function copyPluginTree(source: string, mirror: string): void {
  for (const name of readdirSync(mirror)) {
    if (name === ".git") continue;
    rmSync(join(mirror, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(mirror, name), { recursive: true });
  }
}

/** After overlay, the only byte-diff vs plugins/claude-code must be `.mcp.json`. */
export function assertMirrorOnlyMcpDiffers(source: string, mirror: string): void {
  const srcFiles = new Set(listRelativeFiles(source));
  const mirFiles = new Set(listRelativeFiles(mirror));
  const extra = [...mirFiles].filter((file) => !srcFiles.has(file));
  const missing = [...srcFiles].filter((file) => !mirFiles.has(file));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `mirror file set mismatch extra=${extra.join(",") || "-"} missing=${missing.join(",") || "-"}`,
    );
  }
  const different: string[] = [];
  for (const rel of srcFiles) {
    const left = readFileSync(join(source, rel));
    const right = readFileSync(join(mirror, rel));
    if (!left.equals(right)) different.push(rel);
  }
  if (different.length !== 1 || different[0] !== ".mcp.json") {
    throw new Error(
      `expected only .mcp.json to differ from plugins/claude-code, got: ${different.join(", ") || "(none)"}`,
    );
  }
}

function runPluginCheck(): void {
  const result = spawnSync("bun", ["scripts/build-plugin-runtime.ts", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `plugin:check failed (exit ${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
}

function parseArgs(argv: string[]): { mirror: string; commit: boolean } {
  let mirror = "";
  let commit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--commit") {
      commit = true;
      continue;
    }
    if (arg === "--mirror") {
      mirror = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!mirror) {
    throw new Error("usage: bun scripts/snapshot-omp-plugin.ts --mirror <semctx-plugin-clone> [--commit]");
  }
  return { mirror: resolve(mirror), commit };
}

function git(mirror: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: mirror, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function snapshotOmpPlugin(mirror: string, options: { check?: boolean; commit?: boolean } = {}): void {
  if (!existsSync(mirror) || !existsSync(join(mirror, ".git"))) {
    throw new Error(`mirror is not a git clone: ${mirror}`);
  }
  if (options.check !== false) runPluginCheck();
  copyPluginTree(PLUGIN_SOURCE, mirror);
  overlayOmpMcp(mirror);
  assertMirrorOnlyMcpDiffers(PLUGIN_SOURCE, mirror);
  if (options.commit) {
    const head = git(root, ["rev-parse", "HEAD"]);
    git(mirror, ["add", "-A"]);
    const status = git(mirror, ["status", "--porcelain"]);
    if (!status) {
      process.stdout.write(`mirror already matches ${head}\n`);
      return;
    }
    git(mirror, [
      "commit",
      "-m",
      `chore(delivery): snapshot plugins/claude-code from ${head}\n\nGenerated from MickaelV0/semctx plugins/claude-code.\nRoot .mcp.json equals mcp-omp.json.`,
    ]);
  }
}

if (import.meta.main) {
  const { mirror, commit } = parseArgs(process.argv.slice(2));
  snapshotOmpPlugin(mirror, { commit });
  process.stdout.write(`snapshotted ${PLUGIN_SOURCE} -> ${mirror}\n`);
}
