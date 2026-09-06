import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_MCP_SCHEMA, assertAgentPluginMcp } from "../build-plugin-runtime";

/**
 * The host expands `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` inside `args` and then
 * hands the strings to the command verbatim — it never resolves an arg as a
 * path. A `./` bundle path therefore depends on the launch cwd, while the
 * anchored spelling does not. Both spellings are legal; the gate must accept
 * the anchored one and reject the combination that silently launches nothing.
 */
const pluginRoot = mkdtempSync(join(tmpdir(), "agent-plugin-mcp-"));
mkdirSync(join(pluginRoot, "dist"), { recursive: true });
writeFileSync(join(pluginRoot, "dist", "semctx-mcp.js"), "export {};\n");

function manifest(server: Record<string, unknown>): Record<string, unknown> {
  return {
    $schema: AGENT_MCP_SCHEMA,
    mcpServers: { semctx: { type: "stdio", command: "bun", ...server } },
  };
}

const check = (server: Record<string, unknown>): void => {
  assertAgentPluginMcp(manifest(server), pluginRoot, "mcp.json");
};

describe("assertAgentPluginMcp stdio args", () => {
  test("accepts the cwd-independent ${PLUGIN_ROOT} bundle path", () => {
    expect(() => check({ args: ["${PLUGIN_ROOT}/dist/semctx-mcp.js"] })).not.toThrow();
  });

  test("still catches a renamed bundle behind the ${PLUGIN_ROOT} anchor", () => {
    expect(() => check({ args: ["${PLUGIN_ROOT}/dist/renamed-bundle.js"] })).toThrow(
      /renamed-bundle\.js/,
    );
  });

  test("keeps the plain ./ bundle path legal when the launch cwd is the plugin root", () => {
    expect(() => check({ args: ["./dist/semctx-mcp.js"] })).not.toThrow();
    expect(() => check({ args: ["./dist/semctx-mcp.js"], cwd: "${PLUGIN_ROOT}" })).not.toThrow();
  });

  test("rejects a ./ bundle path once cwd moves off the plugin root", () => {
    expect(() =>
      check({ args: ["./dist/semctx-mcp.js"], cwd: "${PLUGIN_ROOT}/elsewhere" })
    ).toThrow(/elsewhere/);
    expect(() => check({ args: ["./dist/semctx-mcp.js"], cwd: "${PLUGIN_DATA}" })).toThrow(
      /PLUGIN_DATA/,
    );
  });
});
