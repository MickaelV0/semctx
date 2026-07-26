import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout) };
}

describe("help / usage exit codes", () => {
  it("`--help` is an explicit help request and exits 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: semctx");
  });

  it("the `help` command exits 0", () => {
    const r = run(["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: semctx");
  });

  it("a bare invocation (no command, no --help) is a usage error and exits 1", () => {
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage: semctx");
  });

  it("an unknown command exits 2", () => {
    const r = run(["definitely-not-a-command"]);
    expect(r.code).toBe(2);
  });

  it("`--version` and `version` print the package version and exit 0", () => {
    for (const args of [["--version"], ["version"]] as const) {
      const r = run([...args]);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe(packageJson.version);
    }
  });

  it("`--version` never short-circuits a real command (no silent exit-0 gate bypass)", () => {
    // Gate-shaped argv: a short-circuit that honours --version after any position would exit 0
    // and print only the version line, skipping verify entirely.
    const root = mkdtempSync(join(tmpdir(), "semctx-version-argv-"));
    try {
      const r = run(["verify", "diff", "--record", "--root", root, "--version"]);
      expect(r.code).not.toBe(0);
      expect(r.out.trim()).not.toBe(packageJson.version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
