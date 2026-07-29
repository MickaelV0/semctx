import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AGENT_WORKFLOW_CONTRACT_V1,
  AgentWorkflowContractV1Schema,
  type AgentWorkflowContractV1,
} from "@semantic-context/control-model";

const root = resolve(import.meta.dir, "..");
const pluginDists = [
  resolve(root, "plugins/claude-code/dist"),
  resolve(root, "plugins/semctx-control/dist"),
];
const check = process.argv.includes("--check");
const typescriptEntrypoint = Bun.resolveSync("typescript", root);
const typescriptLibSource = dirname(typescriptEntrypoint);
const typescriptLibs = readdirSync(typescriptLibSource)
  .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
  .sort();

const absoluteTypeScriptPrelude = `var __dirname=${JSON.stringify(typescriptLibSource)},__filename=${JSON.stringify(typescriptEntrypoint)};`;
const portableTypeScriptPrelude =
  'var __dirname=import.meta.dir+"/typescript-lib",__filename=__dirname+"/typescript.js";';
const escapedRoot = JSON.stringify(root).slice(1, -1);

export interface BundleSpec {
  /** Output basename under each plugin dist/ */
  name: string;
  entrypoint: string;
  label: string;
}

export const CLI_BUNDLE_SPEC: BundleSpec = {
  name: "semctx.js",
  entrypoint: "apps/cli/src/index.ts",
  label: "plugin CLI",
};

const bundles: BundleSpec[] = [
  {
    name: "semctx-mcp.js",
    entrypoint: "packages/mcp-server/src/index.ts",
    label: "plugin MCP runtime",
  },
  CLI_BUNDLE_SPEC,
];

/** Host-specific shell ladder for the shared control skill (issue #40 option A). */
export type SkillHost = "claude-code" | "semctx-control";

const HOST_CLI_MARKER = "{{HOST_CLI_LADDER}}";
const SHARED_WORKFLOW_MARKER = "{{SHARED_WORKFLOW_CONTRACT}}";
const HOST_CLI_BEGIN = (host: SkillHost) => `<!-- BEGIN host-cli-ladder:${host} -->`;
const HOST_CLI_END = "<!-- END host-cli-ladder -->";
// Strip markers + host body so parity can assert the shared contract is still one document.
export const HOST_CLI_STRIP =
  /<!-- BEGIN host-cli-ladder:(?:claude-code|semctx-control) -->\n[\s\S]*?<!-- END host-cli-ladder -->\n?/;

const skillTemplatePath = resolve(root, "plugins/shared/skills/semctx-control/SKILL.md");
const skillOutputs: Record<SkillHost, string> = {
  "claude-code": resolve(root, "plugins/claude-code/skills/semctx-control/SKILL.md"),
  "semctx-control": resolve(root, "plugins/semctx-control/skills/semctx-control/SKILL.md"),
};

/**
 * Claude: load-time `${CLAUDE_PLUGIN_ROOT}` placeholder + global fallback.
 * Codex: global `semctx` only — no plugin-root substitution on that host.
 */
export function hostCliLadder(host: SkillHost): string {
  if (host === "claude-code") {
    return `Prefer MCP tools when they are connected. For shell fallbacks, resolve the CLI in this order
(stop at the first that works):

1. **Plugin-bundled CLI** (same release as the MCP bundle) — the \`bun "…/dist/semctx.js"\` path in
   the block below. Claude Code substitutes the plugin root into this skill **when the skill is
   loaded**, so the path you read is already absolute. Never expect \`CLAUDE_PLUGIN_ROOT\` to exist
   in the shell — where it is set at all, it is exported to hooks and MCP servers, not to your
   terminal. Do not try to guess the plugin directory, and do not assume the shell's cwd is the
   plugin package root: it is the user's repository.
2. **Global \`semctx\` on PATH** (\`bun install -g semctx@latest\` / \`bunx semctx@latest\`) — keep it on the **same
   version** as the plugin (\`semctx --version\` should match the marketplace plugin version).
3. If neither is available, say so and continue with MCP-only or ask the user to update the plugin /
   install the CLI — do not invent results.

\`\`\`text
# Plugin CLI (path substituted at skill load)
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" status --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic check --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic slice --change change.<slug> --format agent
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control trace repo:<graph-id> --direction lift --to 6 --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" control plan change.<slug> --target target-architecture.json --json
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" verify diff --base origin/main
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" change verify change.<slug> --base origin/main
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic handoff
bun "\${CLAUDE_PLUGIN_ROOT}/dist/semctx.js" semantic resume

# Global / CI fallback — same subcommands, no path
semctx --version
semctx status --json
\`\`\`
`;
  }

  return `Prefer MCP tools when they are connected. For shell fallbacks, use a global \`semctx\` on
PATH (\`bun install -g semctx@latest\` / \`bunx semctx@latest\`) — keep it on the **same version** as the plugin
(\`semctx --version\` should match the marketplace plugin version).

This host does **not** substitute a plugin-root path into skill content, and the agent's shell cwd
is the user's repository (not the plugin package root), so the bundled \`dist/semctx.js\` is not
addressable via a relative path such as \`bun ./dist/semctx.js\` or a placeholder. The plugin still
ships the CLI next to the MCP runtime for lockstep releases and for humans who know the absolute
path.

If \`semctx\` is not available, say so and continue with MCP-only or ask the user to install the CLI
— do not invent results.

\`\`\`text
# Global / CI CLI — same subcommands as the plugin MCP tools
semctx --version
semctx status --json
semctx semantic check --json
semctx verify diff --base origin/main
\`\`\`
`;
}

export function renderSharedWorkflowContract(
  contract: AgentWorkflowContractV1 = AGENT_WORKFLOW_CONTRACT_V1,
): string {
  const parsed = AgentWorkflowContractV1Schema.parse(contract) as AgentWorkflowContractV1;
  const stages = parsed.stages.map((stage, index) => {
    const tools = stage.mcpTools.length > 0
      ? stage.mcpTools.map((tool) => `\`${tool}\``).join(", ")
      : "host-local";
    return `${index + 1}. **${stage.id}** — ${stage.instruction}\n`
      + `   - Surface: ${tools}; effect: \`${stage.effect}\`; condition: \`${stage.condition}\`.`;
  }).join("\n");
  return `<!-- BEGIN shared-workflow-contract:v1 -->
Machine policy: enforcement is \`${parsed.enforcementMode}\`, blocking is disabled, repositories
without Semctx follow \`${parsed.nonSemctxRepository}\`, and execution authority is
\`${parsed.executionAuthority}\`.

${stages}

Completion requires: ${parsed.completion.requiredStageIds.map((id) => `\`${id}\``).join(" → ")}.
The bounded transfer stage is \`${parsed.completion.handoffStageId}\`.
<!-- END shared-workflow-contract -->`;
}

export function renderControlSkill(host: SkillHost, template: string = readSkillTemplate()): string {
  if (!template.includes(HOST_CLI_MARKER)) {
    throw new Error(
      `skill template missing ${HOST_CLI_MARKER}: ${skillTemplatePath}`,
    );
  }
  if (!template.includes(SHARED_WORKFLOW_MARKER)) {
    throw new Error(
      `skill template missing ${SHARED_WORKFLOW_MARKER}: ${skillTemplatePath}`,
    );
  }
  if (template.includes("CLAUDE_PLUGIN_ROOT")) {
    throw new Error(
      `skill template must not embed CLAUDE_PLUGIN_ROOT (host-specific; lives in hostCliLadder only): ${skillTemplatePath}`,
    );
  }
  const body = hostCliLadder(host).replace(/\n$/, "");
  const workflow = renderSharedWorkflowContract();
  const filled = template.replace(
    SHARED_WORKFLOW_MARKER,
    workflow,
  ).replace(
    HOST_CLI_MARKER,
    `${HOST_CLI_BEGIN(host)}\n${body}\n${HOST_CLI_END}`,
  );
  // Normalize to LF for deterministic committed artifacts across platforms.
  return filled.replaceAll("\r\n", "\n");
}

function readSkillTemplate(): string {
  if (!existsSync(skillTemplatePath)) {
    throw new Error(`missing shared skill template: ${skillTemplatePath}`);
  }
  return readFileSync(skillTemplatePath, "utf8").replaceAll("\r\n", "\n");
}

export async function buildPortableBundle(spec: BundleSpec): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [spec.entrypoint],
    root,
    target: "bun",
    minify: true,
    packages: "bundle",
    write: false,
  });

  if (!result.success || result.outputs.length !== 1) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    throw new Error(`failed to build the ${spec.label}`);
  }

  const generated = await result.outputs[0]!.text();
  const preludeCount = generated.split(absoluteTypeScriptPrelude).length - 1;
  if (preludeCount !== 1) {
    throw new Error(
      `expected one bundled TypeScript path prelude in ${spec.label}, found ${preludeCount}`,
    );
  }
  const portable = generated
    .replace(absoluteTypeScriptPrelude, portableTypeScriptPrelude)
    .replace(/[ \t]+(?=\r?\n)/g, "");
  if (portable.includes(escapedRoot)) {
    throw new Error(`generated ${spec.label} still contains the build checkout path`);
  }
  return new TextEncoder().encode(portable);
}

export function writePortableTypeScriptLibs(dist: string): void {
  const typescriptLibOutput = resolve(dist, "typescript-lib");
  rmSync(typescriptLibOutput, { recursive: true, force: true });
  mkdirSync(typescriptLibOutput, { recursive: true });
  for (const lib of typescriptLibs) {
    copyFileSync(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib));
  }
}

function filesEqual(left: string, right: string): boolean {
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function bytesEqual(current: Buffer, expected: Uint8Array): boolean {
  return current.length === expected.length && current.every((value, index) => value === expected[index]);
}

function textEqual(current: string, expected: string): boolean {
  return current.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n");
}

async function main(): Promise<void> {
  const built = new Map<string, Uint8Array>();
  for (const spec of bundles) {
    built.set(spec.name, await buildPortableBundle(spec));
  }

  const skillTemplate = readSkillTemplate();
  const renderedSkills = {
    "claude-code": renderControlSkill("claude-code", skillTemplate),
    "semctx-control": renderControlSkill("semctx-control", skillTemplate),
  } as const;

  for (const dist of pluginDists) {
    const typescriptLibOutput = resolve(dist, "typescript-lib");

    if (check) {
      if (!existsSync(typescriptLibOutput)) {
        throw new Error(`missing generated TypeScript libraries: ${typescriptLibOutput}`);
      }
      const currentLibs = readdirSync(typescriptLibOutput).sort();
      if (currentLibs.join("\n") !== typescriptLibs.join("\n")) {
        throw new Error(`stale generated TypeScript library set: ${typescriptLibOutput}; run 'bun run plugin:build'`);
      }
      for (const lib of typescriptLibs) {
        if (!filesEqual(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib))) {
          throw new Error(`stale generated TypeScript library: ${resolve(typescriptLibOutput, lib)}; run 'bun run plugin:build'`);
        }
      }
      for (const spec of bundles) {
        const output = resolve(dist, spec.name);
        if (!existsSync(output)) throw new Error(`missing generated ${spec.label}: ${output}`);
        const current = readFileSync(output);
        const expected = built.get(spec.name)!;
        if (!bytesEqual(current, expected)) {
          throw new Error(`stale generated ${spec.label}: ${output}; run 'bun run plugin:build'`);
        }
      }
      continue;
    }

    mkdirSync(dist, { recursive: true });
    for (const spec of bundles) {
      await Bun.write(resolve(dist, spec.name), built.get(spec.name)!);
    }
    writePortableTypeScriptLibs(dist);
  }

  // Host-generated control skills (always build + check — independent of dist loop).
  for (const host of Object.keys(skillOutputs) as SkillHost[]) {
    const output = skillOutputs[host];
    const expected = renderedSkills[host];
    if (check) {
      if (!existsSync(output)) {
        throw new Error(`missing generated control skill: ${output}; run 'bun run plugin:build'`);
      }
      const current = readFileSync(output, "utf8");
      if (!textEqual(current, expected)) {
        throw new Error(`stale generated control skill: ${output}; run 'bun run plugin:build'`);
      }
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    await Bun.write(output, expected);
  }

  const sizes = bundles.map((spec) => `${spec.name}=${built.get(spec.name)!.length}`).join(", ");
  process.stdout.write(
    `${check ? "verified" : "built"} byte-identical plugin runtimes (${sizes}; ${typescriptLibs.length} TypeScript libraries) + host control skills\n`,
  );
}

if (import.meta.main) {
  await main();
}
