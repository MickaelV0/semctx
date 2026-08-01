#!/usr/bin/env bun
/**
 * Domain / ADR invariants Biome cannot express (or only partially).
 *
 * Sources of truth:
 * - CONTRIBUTING.md determinism ground rules
 * - ADR 0012 (MCP error boundary — enforced mainly by tests + ToolRegistrar)
 * - PR review lessons: fail-open empty catch on public paths; agent-facing string drift
 *
 * Exit 1 on any violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const failures: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "corpus" || name === "typescript-lib") {
      continue;
    }
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function rel(path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function isTestPath(path: string): boolean {
  const r = rel(path);
  return r.includes("/test/") || r.endsWith(".test.ts") || r.includes("/tests/");
}

function isProductionPackageSrc(path: string): boolean {
  const r = rel(path);
  return (
    (r.startsWith("packages/") && r.includes("/src/") && !isTestPath(path))
    || (r.startsWith("packages/") && !r.includes("/test/") && !isTestPath(path) && r.endsWith(".ts"))
  );
}

/** CONTRIBUTING: no Math.random in the deterministic pipeline. */
function checkNoMathRandom(path: string, text: string): void {
  if (isTestPath(path)) return;
  if (!isProductionPackageSrc(path) && !rel(path).startsWith("apps/cli/src/")) return;
  // CLI human UX may use clocks; package core/pipeline must not use Math.random.
  if (!rel(path).startsWith("packages/")) return;
  if (rel(path).includes("/src/") === false && !rel(path).match(/^packages\/[^/]+\/[^/]+\.ts$/)) {
    // only src/ and package root ts
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("Math.random")) {
      failures.push(`${rel(path)}:${i + 1}: Math.random forbidden in packages (determinism — CONTRIBUTING)`);
    }
  });
}

/**
 * Empty catch that swallows without throw/return/assign/comment.
 * Biome noEmptyBlockStatements covers `{}` and comment-only blocks; this flags
 * bare `catch { }` style that can hide public-contract failures (PR #73 lesson).
 */
function checkEmptyCatch(path: string, text: string): void {
  if (isTestPath(path)) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bcatch\s*(\([^)]*\))?\s*\{\s*$/.test(line)) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] ?? "";
      if (l.includes("}")) {
        const before = l.slice(0, l.indexOf("}"));
        if (before.trim()) body.push(before);
        break;
      }
      body.push(l);
      j++;
    }
    const content = body.join("\n").trim();
    if (content === "") {
      failures.push(
        `${rel(path)}:${i + 1}: empty catch block — add a comment explaining intentional swallow, or rethrow/fail closed (review lesson: fail-open catch on public paths)`,
      );
    }
  }
}

/**
 * Discourage hard-coding stale catalogue codes next to domain refuse SSOT in MCP setup surface.
 * Lightweight: only when both the SSOT constant name and a known stale string appear in the same file.
 */
function checkReasonCodeDrift(path: string, text: string): void {
  const r = rel(path);
  if (!r.startsWith("packages/mcp-server/src/")) return;
  if (isTestPath(path)) return;
  // After setup PR lands: if SSOT constant exists in tree, descriptions must not advertise CONFIG_INVALID for polyglot refuse.
  if (
    text.includes("SETUP_POLYGLOT")
    && text.includes("CONFIG_INVALID")
    && text.includes("polyglot")
    && text.includes("describe")
  ) {
    failures.push(
      `${rel(path)}: polyglot agent-facing text mentions CONFIG_INVALID alongside SETUP_POLYGLOT SSOT — use POLYGLOT_REQUIRES_CONFIG_V2 only in descriptions (PR #73 metadata drift)`,
    );
  }
}

const roots = ["packages", "apps", "scripts"].map((d) => join(root, d));
const files = roots.flatMap((d) => {
  try {
    return walk(d);
  } catch {
    return [];
  }
});

for (const path of files) {
  const text = readFileSync(path, "utf8");
  checkNoMathRandom(path, text);
  checkEmptyCatch(path, text);
  checkReasonCodeDrift(path, text);
}

if (failures.length > 0) {
  console.error("check-invariants: failed\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\n${failures.length} violation(s)`);
  process.exit(1);
}

console.log(`check-invariants: ok (${files.length} files)`);
