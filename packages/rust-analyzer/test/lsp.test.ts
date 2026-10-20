import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RustLspClient } from "../src/lsp";
import { assertNoAmbientCargoConfiguration, parseRustAnalyzerInitializeResponse } from "../src/navigation";

function client(mode = "ok"): RustLspClient {
  return new RustLspClient([process.execPath, "run", join(import.meta.dir, "fixtures/lsp-server.ts"), mode], {
    cwd: import.meta.dir, budgetMs: mode === "hang" ? 100 : 5_000,
  });
}

test("pinned rust-analyzer accepts observed host version forms and refuses unknown initialization", () => {
  const response = (version: string, positionEncoding = "utf-16") => ({ capabilities: { positionEncoding }, serverInfo: { version } });
  expect(() => parseRustAnalyzerInitializeResponse(response("0.3.3081-standalone"))).not.toThrow();
  expect(() => parseRustAnalyzerInitializeResponse(response("0.3.3081-standalone (2ad81e72b7 2026-10-11)"))).not.toThrow();
  expect(() => parseRustAnalyzerInitializeResponse(response("0.3.3082-standalone"))).toThrow();
  expect(() => parseRustAnalyzerInitializeResponse(response("0.3.3081-standalone", "utf-8"))).toThrow();
});

test("refuses Cargo configuration discovered in any ancestor of the navigation workspace", () => {
  const directory = mkdtempSync(join(tmpdir(), "semctx-rust-ambient-"));
  try {
    const workspace = join(directory, "outer", "navigation", "workspace");
    mkdirSync(workspace, { recursive: true });
    expect(() => assertNoAmbientCargoConfiguration(workspace)).not.toThrow();
    for (const name of ["config.toml", "config"]) {
      const configuration = join(directory, "outer", ".cargo");
      mkdirSync(configuration, { recursive: true });
      writeFileSync(join(configuration, name), '[build]\nrustc-wrapper = "planted"\n');
      expect(() => assertNoAmbientCargoConfiguration(workspace)).toThrow("RUST_CARGO_CONFIGURATION_UNSUPPORTED");
      rmSync(configuration, { recursive: true, force: true });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("frames UTF-8 JSON-RPC over a real child process with consecutive responses", async () => {
  const connection = client();
  try {
    expect(await connection.request("initialize", {})).toEqual({ text: "🦀 café", method: "initialize" });
    expect(await connection.request("textDocument/definition", {})).toEqual({ text: "🦀 café", method: "textDocument/definition" });
  } finally { await connection.close(); }
});

for (const [mode, reason] of [["corrupt", "RUST_LSP_PROTOCOL"], ["hang", "RUST_LSP_TIMEOUT"], ["exit", "RUST_LSP_EXIT"]] as const) {
  test(`refuses ${mode} without a successful empty result`, async () => {
    const connection = client(mode);
    try { await rejects(connection.request("initialize", {}), new RegExp(reason)); }
    finally { await connection.close(); }
  });
}
