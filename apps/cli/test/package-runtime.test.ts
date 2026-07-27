import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import packageJson from "../package.json";

const cliRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(cliRoot, "..", "..");
const foreignRoot = mkdtempSync(join(tmpdir(), "semctx-npm-package-"));
let packedTarball: string | undefined;

afterAll(() => {
  rmSync(foreignRoot, { recursive: true, force: true });
  if (packedTarball !== undefined) rmSync(packedTarball, { force: true });
});

function run(command: string[], cwd: string): {
  code: number;
  out: string;
  err: string;
} {
  const process = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: process.exitCode ?? 1,
    out: new TextDecoder().decode(process.stdout),
    err: new TextDecoder().decode(process.stderr),
  };
}

describe("published npm CLI package", () => {
  test("packs and installs a portable CLI whose npm bin runs outside the checkout", () => {
    const pack = run(["npm", "pack", "--json", "--silent"], cliRoot);
    expect(pack.code, pack.err).toBe(0);
    type PackedPackage = {
      filename: string;
      files: Array<{ path: string }>;
    };
    const packJson = JSON.parse(pack.out) as PackedPackage[] | Record<string, PackedPackage>;
    const packed = Array.isArray(packJson) ? packJson : Object.values(packJson);
    expect(packed).toHaveLength(1);
    packedTarball = join(cliRoot, packed[0]!.filename);
    expect(existsSync(packedTarball)).toBe(true);
    expect(packed[0]!.files.some((file) => file.path === "dist/index.js")).toBe(true);
    expect(packed[0]!.files.some((file) => file.path === "package.json")).toBe(true);

    const installRoot = join(foreignRoot, "consumer");
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, "package.json"), '{"name":"consumer","private":true}\n');
    const install = run(
      ["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", packedTarball],
      installRoot,
    );
    expect(install.code, install.err).toBe(0);
    const semctxBin = join(
      installRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "semctx.cmd" : "semctx",
    );
    expect(existsSync(semctxBin)).toBe(true);

    const installed = join(installRoot, "node_modules", "semctx", "dist");
    const bundle = readFileSync(join(installed, "index.js"), "utf8");
    expect(bundle.includes('import.meta.dir+"/typescript-lib"')).toBe(true);
    expect(bundle.includes(repoRoot.replaceAll("\\", "\\\\"))).toBe(false);
    const libs = readdirSync(join(installed, "typescript-lib"))
      .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"));
    expect(libs.length).toBeGreaterThan(90);

    const help = run([semctxBin, "--version"], installRoot);
    expect(help.code, help.err).toBe(0);
    expect(help.out.trim()).toBe(packageJson.version);

    const target = join(foreignRoot, "project");
    cpSync(SAMPLE_REPO, target, {
      recursive: true,
      filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
    });
    const setup = run([semctxBin, "setup", "--root", target, "--json"], installRoot);
    expect(setup.code, setup.err).toBe(0);
    expect(JSON.parse(setup.out).check.ok).toBe(true);
  }, 30_000);
});
