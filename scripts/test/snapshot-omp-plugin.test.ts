import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMirrorOnlyMcpDiffers, overlayOmpMcp } from "../snapshot-omp-plugin.ts";

describe("snapshot-omp-plugin overlay invariant", () => {
  test("the only allowed byte-diff after overlay is .mcp.json", () => {
    const source = mkdtempSync(join(tmpdir(), "semctx-omp-src-"));
    const mirror = mkdtempSync(join(tmpdir(), "semctx-omp-mir-"));
    writeFileSync(join(source, "mcp-omp.json"), '{"cwd":"."}\n');
    writeFileSync(join(source, ".mcp.json"), '{"claude":true}\n');
    writeFileSync(join(source, "package.json"), '{"name":"semctx"}\n');
    writeFileSync(join(mirror, "mcp-omp.json"), '{"cwd":"."}\n');
    writeFileSync(join(mirror, ".mcp.json"), '{"claude":true}\n');
    writeFileSync(join(mirror, "package.json"), '{"name":"semctx"}\n');
    overlayOmpMcp(mirror);
    assertMirrorOnlyMcpDiffers(source, mirror);
  });

  test("refuses extra diffs", () => {
    const source = mkdtempSync(join(tmpdir(), "semctx-omp-src-"));
    const mirror = mkdtempSync(join(tmpdir(), "semctx-omp-mir-"));
    writeFileSync(join(source, "mcp-omp.json"), '{"cwd":"."}\n');
    writeFileSync(join(source, ".mcp.json"), '{"claude":true}\n');
    writeFileSync(join(mirror, "mcp-omp.json"), '{"cwd":"."}\n');
    writeFileSync(join(mirror, ".mcp.json"), '{"claude":true}\n');
    mkdirSync(join(mirror, "extra"));
    writeFileSync(join(mirror, "extra", "nope.txt"), "x\n");
    overlayOmpMcp(mirror);
    expect(() => assertMirrorOnlyMcpDiffers(source, mirror)).toThrow(/file set mismatch/);
  });
});
