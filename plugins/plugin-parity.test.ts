import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOST_CLI_STRIP,
  hostCliLadder,
  renderControlSkill,
  type SkillHost,
} from "../scripts/build-plugin-runtime.ts";

const repoRoot = resolve(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}

function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function typescriptLibs(plugin: "claude-code" | "semctx-control"): string[] {
  return readdirSync(resolve(repoRoot, `plugins/${plugin}/dist/typescript-lib`))
    .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
    .sort();
}

function skillPath(host: SkillHost): string {
  return host === "claude-code"
    ? "plugins/claude-code/skills/semctx-control/SKILL.md"
    : "plugins/semctx-control/skills/semctx-control/SKILL.md";
}

/** Shared workflow contract = generated skill with the host CLI ladder region removed. */
function sharedContractBody(skill: string): string {
  const stripped = skill.replace(HOST_CLI_STRIP, "");
  expect(stripped).not.toBe(skill); // host region must be present and strip-able
  return stripped;
}

describe("Codex and Claude Code plugin parity", () => {
  test("ships one shared semctx-control workflow contract with host-generated CLI ladders", () => {
    const template = read("plugins/shared/skills/semctx-control/SKILL.md");
    expect(template).toContain("{{HOST_CLI_LADDER}}");
    expect(template).not.toContain("CLAUDE_PLUGIN_ROOT");

    const codex = read(skillPath("semctx-control"));
    const claude = read(skillPath("claude-code"));

    // Generated artifacts match the build (deterministic).
    expect(claude).toBe(renderControlSkill("claude-code", template));
    expect(codex).toBe(renderControlSkill("semctx-control", template));

    // Host-neutral body is still byte-identical across hosts.
    expect(sharedContractBody(claude)).toBe(sharedContractBody(codex));

    for (const required of [
      "semctx_control_status",
      "semctx_control_trace",
      "semctx_control_plan",
      "semctx_verify_change",
      "semctx_change_verify",
      "READY",
      "BLOCKED",
      "PARTIAL",
      "runtime tests",
      "Local equivalents when MCP is unavailable",
    ]) {
      expect(sharedContractBody(codex)).toContain(required);
    }

    // Claude keeps the plugin-bundled placeholder rung.
    expect(claude).toContain("Plugin-bundled CLI");
    expect(claude).toContain('bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js"');
    expect(claude).toContain("semctx --version");
    expect(claude).toContain(hostCliLadder("claude-code").trim().slice(0, 40));

    // Codex ships only host-working instructions — no Claude placeholder in any form.
    expect(codex).toContain("Global / CI CLI");
    expect(codex).toContain("semctx --version");
    expect(codex).toContain("semctx status --json");
    expect(codex).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(codex).not.toContain("Plugin-bundled CLI");
    expect(codex).toContain("does **not** substitute a plugin-root path");
  });

  // Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} into skill/agent content, hook and monitor
  // commands, and MCP/LSP server fields — the placeholder form only, via /\$\{CLAUDE_PLUGIN_ROOT\}/g.
  // A bare $CLAUDE_PLUGIN_ROOT is never substituted; it survives into the agent's shell, which does
  // not receive the variable, and expands to nothing. The failure is silent: `bun "/dist/semctx.js"`.
  test("never ships a bare $CLAUDE_PLUGIN_ROOT — only the ${…} placeholder is substituted", () => {
    const shipped = [
      "plugins/claude-code/skills/semctx-control/SKILL.md",
      "plugins/claude-code/skills/semctx-semantic/SKILL.md",
      "plugins/claude-code/skills/semctx-verify/SKILL.md",
      "plugins/semctx-control/skills/semctx-control/SKILL.md",
      "plugins/shared/skills/semctx-control/SKILL.md",
      "plugins/claude-code/hooks/hooks.json",
      "plugins/claude-code/.mcp.json",
      "plugins/claude-code/README.md",
      "plugins/claude-code/examples/guard.json",
      "README.md",
      "docs/integrations/claude-code.md",
      "docs/integrations/claude-code-guarded-mode.md",
      "docs/integrations/codex-control-plane.md",
    ];
    // Matches $CLAUDE_PLUGIN_ROOT only when it is NOT the ${…} form.
    const bare = /\$CLAUDE_PLUGIN_ROOT/;
    // Canary: a neutered pattern would leave this suite permanently green.
    expect(bare.test("$CLAUDE_PLUGIN_ROOT/dist/semctx.js")).toBe(true);
    expect(bare.test('bun "${CLAUDE_PLUGIN_ROOT}/dist/semctx.js"')).toBe(false);
    for (const path of shipped) {
      const offenders = read(path)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => bare.test(line));
      expect({ path, offenders }).toEqual({ path, offenders: [] });
    }
  });

  test("Codex plugin never ships CLAUDE_PLUGIN_ROOT in any form", () => {
    const anyForm = /CLAUDE_PLUGIN_ROOT/;
    expect(anyForm.test("${CLAUDE_PLUGIN_ROOT}")).toBe(true);
    expect(anyForm.test("$CLAUDE_PLUGIN_ROOT")).toBe(true);

    const codexTree = [
      "plugins/semctx-control/skills/semctx-control/SKILL.md",
      "plugins/semctx-control/.mcp.json",
      "plugins/semctx-control/.codex-plugin/plugin.json",
    ];
    for (const path of codexTree) {
      const offenders = read(path)
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => anyForm.test(line));
      expect({ path, offenders }).toEqual({ path, offenders: [] });
    }
  });

  test("registers the same MCP server identity and compatible plugin versions", () => {
    const codexMcp = json<{
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string; default_tools_approval_mode?: string }>;
    }>(
      "plugins/semctx-control/.mcp.json",
    );
    const claudeMcp = json<{
      mcpServers: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >;
    }>(
      "plugins/claude-code/.mcp.json",
    );
    const codexManifest = json<{ version: string }>(
      "plugins/semctx-control/.codex-plugin/plugin.json",
    );
    const claudeManifest = json<{
      version: string;
      skills?: string;
      hooks?: string;
      mcpServers?: string;
    }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    const marketplace = json<{ plugins: Array<{ name: string; version: string }> }>(
      ".claude-plugin/marketplace.json",
    );

    expect(Object.keys(codexMcp.mcpServers)).toEqual(["semctx"]);
    expect(Object.keys(claudeMcp.mcpServers)).toEqual(["semctx"]);
    expect(codexMcp.mcpServers.semctx).toEqual({
      command: "bun",
      args: ["./dist/semctx-mcp.js"],
      cwd: ".",
      default_tools_approval_mode: "writes",
    });
    expect(claudeMcp.mcpServers.semctx.command).toBe("bun");
    expect(claudeMcp.mcpServers.semctx.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/dist/semctx-mcp.js",
    ]);
    expect(claudeMcp.mcpServers.semctx.env).toEqual({
      SEMCTX_ROOT: "${CLAUDE_PROJECT_DIR}",
    });
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/bin/semctx-mcp-launcher.ts"))).toBe(false);
    expect(read("plugins/claude-code/dist/semctx-mcp.js")).toBe(read("plugins/semctx-control/dist/semctx-mcp.js"));
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/dist/semctx.js"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "plugins/semctx-control/dist/semctx.js"))).toBe(true);
    expect(read("plugins/claude-code/dist/semctx.js")).toBe(read("plugins/semctx-control/dist/semctx.js"));
    const codexLibs = typescriptLibs("semctx-control");
    const claudeLibs = typescriptLibs("claude-code");
    expect(codexLibs.length).toBeGreaterThan(90);
    expect(codexLibs).toContain("lib.d.ts");
    expect(claudeLibs).toEqual(codexLibs);
    for (const lib of codexLibs) {
      expect(read(`plugins/claude-code/dist/typescript-lib/${lib}`)).toBe(
        read(`plugins/semctx-control/dist/typescript-lib/${lib}`),
      );
    }
    expect(codexManifest.version.split("+")[0]).toBe(claudeManifest.version.split("+")[0]);
    expect(claudeManifest.skills).toBeUndefined();
    expect(claudeManifest.hooks).toBeUndefined();
    expect(claudeManifest.mcpServers).toBeUndefined();
    expect(marketplace.plugins.find((plugin) => plugin.name === "semctx")?.version).toBe(
      claudeManifest.version,
    );
    expect(json<{ version: string }>("packages/mcp-server/package.json").version).toBe(claudeManifest.version);
    expect(json<{ version: string }>("packages/app-services/package.json").version).toBe(claudeManifest.version);
    // Release SSOT: npm CLI package must ship the same release as the marketplace plugins/MCP.
    expect(json<{ version: string }>("apps/cli/package.json").version).toBe(claudeManifest.version);
    const serverSource = read("packages/mcp-server/src/server.ts");
    expect(serverSource).toContain('import packageJson from "../package.json"');
    expect(serverSource).toContain("version: packageJson.version");
  });

  test("documents the shared Plane A, B, and C workflow for both hosts", () => {
    const rootReadme = read("README.md");
    const claudeReadme = read("plugins/claude-code/README.md");
    const claudeGuide = read("docs/integrations/claude-code.md");
    const codexGuide = read("docs/integrations/codex-control-plane.md");

    for (const document of [rootReadme, claudeReadme, claudeGuide, codexGuide]) {
      expect(document).toContain("semctx_control_status");
      expect(document).toContain("semctx_control_trace");
      expect(document).toContain("semctx_control_plan");
      expect(document).toContain("READY");
      expect(document).toContain("execution authority");
    }
  });
});
