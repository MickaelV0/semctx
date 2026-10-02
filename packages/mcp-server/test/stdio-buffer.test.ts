import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { analyzeAndBuildClaims } from "@semantic-context/app-services";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const entrypoint = resolve(import.meta.dir, "../src/index.ts");
const checkout = resolve(import.meta.dir, "../../..");

function largeDiff(bytes: number): string {
  return [
    "diff --git a/src/greeting.ts b/src/greeting.ts",
    "--- a/src/greeting.ts",
    "+++ b/src/greeting.ts",
    "@@ -1 +1 @@",
    '-export function greet() { return "hello"; }',
    `+export function greet() { return "hello"; } /* private-payload-${"x".repeat(bytes)} */`,
    "",
  ].join("\n");
}

async function withServer(action: (client: Client, root: string, stderr: () => string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "semctx-stdio-buffer-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment["SEMCTX_ROOT"];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: checkout,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: "semctx-stdio-buffer-test", version: "1" });
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/greeting.ts"), 'export function greet() { return "hello"; }\n');
    const config = initWorkspace(root);
    const store = openStore(root);
    try {
      const { analysis, claims } = analyzeAndBuildClaims(config);
      store.saveGraph(analysis.graph, analysis.evidence);
      store.replaceClaims(claims);
    } finally {
      store.close();
    }
    await client.connect(transport);
    await action(client, root, () => stderr);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("MCP stdio message bounds", () => {
  test("an inline diff above the SDK's 10 MiB default returns analysis and keeps the connection open", async () => {
    await withServer(async (client, root) => {
      const result = await client.callTool({
        name: "semctx_verify_change",
        arguments: { repositoryRoot: root, gitDiff: largeDiff(12 * 1024 * 1024) },
      });
      expect(result.isError).not.toBe(true);
      const report = result.structuredContent;
      if (typeof report !== "object" || report === null || !("changedFiles" in report)) throw new Error("missing verify report");
      expect(report.changedFiles).toEqual(["src/greeting.ts"]);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    });
  }, 30_000);

  test("a message above 32 MiB stays bounded and reports the Git fallback without exposing its payload", async () => {
    // The SDK client waits only for 'drain' when sending, even if the peer closes.
    // Observe the server process directly for an intentionally rejected message.
    const child = spawn(process.execPath, [entrypoint], { cwd: checkout, windowsHide: true });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.on("error", () => { /* Closing the bounded reader can break the writer's pipe. */ });
    try {
      const closed = new Promise<void>((resolveClosed, reject) => {
        child.once("close", () => resolveClosed());
        child.once("error", reject);
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "semctx_verify_change", arguments: { repositoryRoot: checkout, gitDiff: largeDiff(33 * 1024 * 1024) } },
      }) + "\n");
      await closed;
      expect(stderr).toContain("32 MiB");
      expect(stderr).toContain("omit gitDiff");
      expect(stderr).not.toContain("private-payload");
      expect(stdout).toBe("");
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);
});
