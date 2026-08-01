import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  probeCliCompatibility,
  type CliCompatibilityProbeDependencies,
} from "../src/cli-compatibility";

const REQUIRED_VERSION = "0.1.17";
const UPGRADE_COMMAND = `bun install -g semctx@${REQUIRED_VERSION}`;
const itOnWindows = process.platform === "win32" ? it : it.skip;

describe("CLI compatibility probe", () => {
  it("reports a missing global command without invoking a subprocess", () => {
    let runnerCalled = false;
    const result = probeCliCompatibility(REQUIRED_VERSION, {
      resolveExecutable: () => null,
      runVersionProbe: () => {
        runnerCalled = true;
        throw new Error("must not run");
      },
    });

    expect(runnerCalled).toBe(false);
    expect(result).toEqual({
      found: false,
      path: null,
      version: null,
      requiredVersion: REQUIRED_VERSION,
      compatible: false,
      reason: "CLI_NOT_FOUND",
      upgradeCommand: UPGRADE_COMMAND,
    });
  });

  it("distinguishes executable-resolution failure from confirmed absence", () => {
    const result = probeCliCompatibility(REQUIRED_VERSION, {
      resolveExecutable: () => {
        throw new Error("sensitive resolution failure");
      },
    });

    expect(result).toEqual({
      found: false,
      path: null,
      version: null,
      requiredVersion: REQUIRED_VERSION,
      compatible: false,
      reason: "CLI_PROBE_FAILED",
      upgradeCommand: UPGRADE_COMMAND,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it.each([
    ["0.1.17", true, "CLI_VERSION_COMPATIBLE"],
    ["0.1.16", false, "CLI_VERSION_MISMATCH"],
  ] as const)(
    "enforces exact pre-1.0 lockstep for installed version %s",
    (version, compatible, reason) => {
      const result = probeCliCompatibility(REQUIRED_VERSION, dependencies({ stdout: `${version}\n` }));

      expect(result).toEqual({
        found: true,
        path: "/tools/semctx",
        version,
        requiredVersion: REQUIRED_VERSION,
        compatible,
        reason,
        upgradeCommand: UPGRADE_COMMAND,
      });
    },
  );

  it("reports malformed version output without exposing subprocess details", () => {
    const result = probeCliCompatibility(
      REQUIRED_VERSION,
      dependencies({ stdout: "semctx version unknown\n" }),
    );

    expect(result).toEqual({
      found: true,
      path: "/tools/semctx",
      version: null,
      requiredVersion: REQUIRED_VERSION,
      compatible: false,
      reason: "CLI_VERSION_MALFORMED",
      upgradeCommand: UPGRADE_COMMAND,
    });
    expect(JSON.stringify(result)).not.toContain("unknown");
    expect(JSON.stringify(result)).not.toContain("exitCode");
  });

  it.each(["00.1.17", "0.1.17-alpha..1", "0.1.17-01"])(
    "rejects invalid SemVer output %s",
    (version) => {
      const result = probeCliCompatibility(REQUIRED_VERSION, dependencies({ stdout: version }));

      expect(result.version).toBeNull();
      expect(result.reason).toBe("CLI_VERSION_MALFORMED");
    },
  );

  it("reports a bounded timeout without exposing a raw subprocess error", () => {
    const result = probeCliCompatibility(
      REQUIRED_VERSION,
      dependencies({ stdout: "", exitCode: null, timedOut: true }),
    );

    expect(result).toEqual({
      found: true,
      path: "/tools/semctx",
      version: null,
      requiredVersion: REQUIRED_VERSION,
      compatible: false,
      reason: "CLI_PROBE_TIMEOUT",
      upgradeCommand: UPGRADE_COMMAND,
    });
  });

  it("collapses subprocess failures into one advisory reason", () => {
    const result = probeCliCompatibility(REQUIRED_VERSION, {
      resolveExecutable: () => "/tools/semctx",
      runVersionProbe: () => {
        throw new Error("sensitive child-process detail");
      },
    });

    expect(result.reason).toBe("CLI_PROBE_FAILED");
    expect(result.compatible).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("executes the resolved Windows wrapper path directly with a bounded timeout", () => {
    const wrapperPath = String.raw`C:\Users\agent\AppData\Roaming\bun\bin\semctx.cmd`;
    const calls: Array<{ path: string; timeoutMs: number }> = [];
    const result = probeCliCompatibility(REQUIRED_VERSION, {
      resolveExecutable: (command) => {
        expect(command).toBe("semctx");
        return wrapperPath;
      },
      runVersionProbe: (path, timeoutMs) => {
        calls.push({ path, timeoutMs });
        return { exitCode: 0, stdout: "0.1.17\r\n", timedOut: false };
      },
    });

    expect(calls).toEqual([{ path: wrapperPath, timeoutMs: 2_000 }]);
    expect(result).toMatchObject({
      found: true,
      path: wrapperPath,
      version: REQUIRED_VERSION,
      compatible: true,
      reason: "CLI_VERSION_COMPATIBLE",
    });
  });

  itOnWindows("resolves and executes a real divergent Windows command wrapper", () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-cli-wrapper-"));
    try {
      const wrapperPath = join(directory, "semctx.cmd");
      writeFileSync(wrapperPath, "@echo off\r\necho 0.1.16\r\n", "utf8");
      const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../src/cli-compatibility.ts")).href;
      const script = [
        `import { probeCliCompatibility } from ${JSON.stringify(moduleUrl)};`,
        `console.log(JSON.stringify(probeCliCompatibility(${JSON.stringify(REQUIRED_VERSION)})));`,
      ].join("\n");
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...processEnv(), PATH: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(child.stderr);

      expect(child.exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
        found: true,
        path: wrapperPath,
        version: "0.1.16",
        requiredVersion: REQUIRED_VERSION,
        compatible: false,
        reason: "CLI_VERSION_MISMATCH",
        upgradeCommand: UPGRADE_COMMAND,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function dependencies(
  execution: Partial<ReturnType<CliCompatibilityProbeDependencies["runVersionProbe"]>>,
): CliCompatibilityProbeDependencies {
  return {
    resolveExecutable: () => "/tools/semctx",
    runVersionProbe: () => ({
      exitCode: 0,
      stdout: "",
      timedOut: false,
      ...execution,
    }),
  };
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
