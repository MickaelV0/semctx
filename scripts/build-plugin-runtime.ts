import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

interface BundleSpec {
  /** Output basename under each plugin dist/ */
  name: string;
  entrypoint: string;
  label: string;
}

const bundles: BundleSpec[] = [
  {
    name: "semctx-mcp.js",
    entrypoint: "packages/mcp-server/src/index.ts",
    label: "plugin MCP runtime",
  },
  {
    name: "semctx.js",
    entrypoint: "apps/cli/src/index.ts",
    label: "plugin CLI",
  },
];

async function buildPortableBundle(spec: BundleSpec): Promise<Uint8Array> {
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
  const portable = generated.replace(absoluteTypeScriptPrelude, portableTypeScriptPrelude);
  if (portable.includes(escapedRoot)) {
    throw new Error(`generated ${spec.label} still contains the build checkout path`);
  }
  return new TextEncoder().encode(portable);
}

function filesEqual(left: string, right: string): boolean {
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function bytesEqual(current: Buffer, expected: Uint8Array): boolean {
  return current.length === expected.length && current.every((value, index) => value === expected[index]);
}

const built = new Map<string, Uint8Array>();
for (const spec of bundles) {
  built.set(spec.name, await buildPortableBundle(spec));
}

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
  rmSync(typescriptLibOutput, { recursive: true, force: true });
  mkdirSync(typescriptLibOutput, { recursive: true });
  for (const lib of typescriptLibs) {
    copyFileSync(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib));
  }
}

const sizes = bundles.map((spec) => `${spec.name}=${built.get(spec.name)!.length}`).join(", ");
process.stdout.write(
  `${check ? "verified" : "built"} byte-identical plugin runtimes (${sizes}; ${typescriptLibs.length} TypeScript libraries)\n`,
);
