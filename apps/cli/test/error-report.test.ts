import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError } from "../src/output";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const SPAWN_TIMEOUT_MS = 25_000;
const UNSUPPORTED_OPTION =
  "unsupported option(s) for semctx control verify-authorization <request.json>: --bogus";
const BOGUS_OPTION_ARGV = ["control", "verify-authorization", "request.json", "--bogus"];

function runCli(stackHeader: "native" | "missing" | "stale", debug = false) {
  const directory = mkdtempSync(join(tmpdir(), "semctx-error-report-"));
  try {
    const sentinel = join(directory, "preloaded");
    const preload = join(directory, "preload.js");
    if (stackHeader !== "native") {
      const header = stackHeader === "missing" ? "error.name" : 'error.name + ": stale header"';
      writeFileSync(preload, [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
        `Error.prepareStackTrace = (error, frames) => [${header}, ...frames.map((frame) => "    at " + frame)].join("\\n");`,
        "",
      ].join("\n"));
    }
    const env = { ...process.env };
    delete env["SEMCTX_DEBUG"];
    if (debug) env["SEMCTX_DEBUG"] = "1";
    const preloadArgs = stackHeader === "native" ? [] : [`--preload=${preload}`];
    const child = Bun.spawnSync([process.execPath, ...preloadArgs, "run", CLI, ...BOGUS_OPTION_ARGV], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
    });
    return {
      code: child.exitCode,
      out: new TextDecoder().decode(child.stdout),
      err: new TextDecoder().decode(child.stderr),
      preload: stackHeader === "native" ? "native" : existsSync(sentinel) ? "ran" : "missing",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("top-level CLI error report", () => {
  it("formats Error, string, and unknown values without trusting a stack header", () => {
    const error = new TypeError("not callable");
    Object.defineProperty(error, "stack", {
      value: "TypeError: stale header\n    at caller (caller.ts:1:1)",
    });
    expect(describeError(error, {})).toBe("TypeError: not callable");
    expect(describeError(error, { SEMCTX_DEBUG: "1" })).toBe(
      "TypeError: not callable\n    at caller (caller.ts:1:1)",
    );
    expect(describeError("plain string", {})).toBe("plain string");
    expect(describeError({ reason: "unknown" }, {})).toBe("[object Object]");
    expect(describeError(new Error(""), {})).toBe("Error");
  });

  it("prints the Error's current name and message with exit 1 regardless of its stack header", () => {
    for (const stackHeader of ["native", "missing", "stale"] as const) {
      expect({ stackHeader, ...runCli(stackHeader) }).toEqual({
        stackHeader,
        code: 1,
        out: "",
        err: `ERROR Error: ${UNSUPPORTED_OPTION}\n`,
        preload: stackHeader === "native" ? "native" : "ran",
      });
    }
  }, SPAWN_TIMEOUT_MS);

  it("adds frame lines only under SEMCTX_DEBUG=1 while preserving exit 1", () => {
    const result = runCli("stale", true);
    const [header, ...frames] = result.err.trimEnd().split("\n");
    expect({ code: result.code, out: result.out, header, preload: result.preload }).toEqual({
      code: 1,
      out: "",
      header: `ERROR Error: ${UNSUPPORTED_OPTION}`,
      preload: "ran",
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => line.startsWith("    at "))).toBe(true);
  }, SPAWN_TIMEOUT_MS);
});
