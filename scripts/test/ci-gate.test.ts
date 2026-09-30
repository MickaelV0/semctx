import { describe, expect, test } from "bun:test";
import { commandsForLane, runCiGate } from "../ci-gate";
import type { CiLane } from "../ci-plan";

const lane = (profile: CiLane["profile"], os: CiLane["os"], targets = "", smoke: CiLane["smoke"] = "false"): CiLane =>
  ({ profile, os, targets, smoke });

describe("CI gate runner", () => {
  test("contract lane runs diff, compatibility, documentation, static quality and routing regressions", () => {
    const commands = commandsForLane(lane("contract", "ubuntu-latest"), "base-sha", () => true);
    expect(commands.map((command) => command.label)).toEqual([
      "diff hygiene", "compatibility", "documentation", "quality", "routing regressions",
    ]);
    expect(commands[0]?.argv).toEqual(["git", "diff", "--check", "base-sha...HEAD"]);
    expect(commands.at(-1)?.argv).toContain("scripts/test/governance-files.test.ts");
  });

  test("full lane invokes the unchanged canonical gate; smoke is added only when selected", () => {
    expect(commandsForLane(lane("full", "ubuntu-latest"), "base", () => true).map((command) => command.argv))
      .toEqual([["bun", "run", "verify:pr"]]);
    expect(commandsForLane(lane("full", "ubuntu-latest", "", "true"), "base", () => true).at(-1)?.argv)
      .toEqual(["bun", "run", "bench:index-workers", "4", "2"]);
  });

  test("focused lane rejects unknown or missing targets and executes plugin parity", () => {
    expect(() => commandsForLane(lane("focused", "windows-latest", ""), "base", () => true)).toThrow();
    expect(() => commandsForLane(lane("focused", "windows-latest", "arbitrary"), "base", () => true)).toThrow();
    expect(() => commandsForLane(lane("focused", "windows-latest", "apps/cli/test"), "base", () => false)).toThrow();
    expect(commandsForLane(lane("focused", "macos-15", "plugins"), "base", () => true).map((command) => command.argv))
      .toEqual([
        ["bun", "test", "--timeout", "60000", "plugins"],
        ["bun", "run", "plugin:check"],
        ["python", "scripts/verify-index-routing.py"],
      ]);
    expect(() => commandsForLane(lane("focused", "ubuntu-latest", "plugins"), "base", () => true)).toThrow();
  });

  test("propagates a failed command without running later commands", async () => {
    const observed: string[][] = [];
    const code = await runCiGate(lane("contract", "ubuntu-latest"), "base", {
      cwd: "unused", targetExists: () => true, log: () => undefined,
      run: async (argv) => { observed.push(argv); return observed.length === 2 ? 19 : 0; },
    });
    expect(code).toBe(19);
    expect(observed).toHaveLength(2);
  });
});
