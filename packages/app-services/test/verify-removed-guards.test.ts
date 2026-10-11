import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

/**
 * A PR is checked as a committed range against its base, with the index built at the PR head.
 */

const roots: string[] = [];

const MONEY = [
  "/**",
  " * @invariant money-never-negative: amounts must never be negative",
  " */",
  "export function clamp(x: number): number {",
  "  return x < 0 ? 0 : x;",
  "}",
  "",
].join("\n");

const CART = [
  "export interface CartTotal {",
  "  subtotalCents: number;",
  "  taxCents: number;",
  "}",
  "",
].join("\n");

const HELPER = "export function helper(x: number): number {\n  return x + 1;\n}\n";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** `main` holds a guarded function, an exported interface and an unguarded helper, all untested. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-removed-guards-"));
  roots.push(root);
  write(root, ".gitignore", ".semctx/\n");
  write(root, "src/money.ts", MONEY);
  write(root, "src/cart.ts", CART);
  write(root, "src/helper.ts", HELPER);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  initWorkspace(root, createDefaultConfig(root));
  return root;
}

/** Commit `edit` on a PR branch, index its head, and verify the range against `main`. */
function verifyPullRequest(edit: (root: string) => void) {
  const root = repository();
  git(root, "checkout", "-q", "-b", "pr");
  edit(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "pr");
  indexRepository(root, "2026-10-11T10:00:00.000Z");
  return runVerify(root, { kind: "range", base: "main" }).result;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a diff with no content hunks", () => {
  it("names the renamed paths as not compared instead of claiming nothing changed", () => {
    const result = verifyPullRequest((root) => git(root, "mv", "src/cart.ts", "src/cart2.ts"));
    const unknowns = result.unknowns.join("\n");
    expect(unknowns).not.toContain("No changes detected");
    expect(unknowns).toContain("no content hunks");
    expect(unknowns).toContain("src/cart.ts");
  });
});
