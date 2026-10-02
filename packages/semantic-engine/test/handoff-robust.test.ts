import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHandoff, handoffJsonPath, workingDir, buildHandoffCapsule } from "../src/index";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function withHandoff(content: string): string {
  root = mkdtempSync(join(tmpdir(), "semctx-handoff-"));
  mkdirSync(workingDir(root), { recursive: true });
  writeFileSync(handoffJsonPath(root), content, "utf8");
  return root;
}

describe("readHandoff — absence and malformed artifacts remain distinct", () => {
  it("returns undefined only when the handoff is absent", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-handoff-"));
    expect(readHandoff(root)).toBeUndefined();
  });

  it("rejects a literal null as a partial capsule", () => {
    expectHandoffError(() => readHandoff(withHandoff("null")), "CAPSULE_INVALID");
  });

  it("rejects a structurally partial object with a distinct reason", () => {
    expectHandoffError(
      () => readHandoff(withHandoff('{"version":1,"createdAt":"2026-01-01"}')),
      "CAPSULE_INVALID",
    );
  });

  it("rejects invalid JSON with a distinct reason", () => {
    expectHandoffError(() => readHandoff(withHandoff("{not json")), "INVALID_JSON");
  });

  it("accepts a well-formed capsule round-trip", () => {
    const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05T00:00:00.000Z", model: { nodes: [], changes: [] } });
    expect(readHandoff(withHandoff(JSON.stringify(capsule)))?.createdAt).toBe("2026-07-05T00:00:00.000Z");
  });
});

function expectHandoffError(action: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_INVALID");
  expect((caught as { details?: { reason?: string } } | undefined)?.details?.reason).toBe(reason);
}
