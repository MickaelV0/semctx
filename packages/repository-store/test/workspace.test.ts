import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig, saveConfig } from "../src/workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-workspace-"));
  roots.push(root);
  return root;
}

describe("config persistence (#82)", () => {
  it("does not write repositoryRoot to config.json", () => {
    const root = tempRoot();
    initWorkspace(root);
    const onDisk = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).not.toHaveProperty("repositoryRoot");
    expect(onDisk.version).toBe(1);
    expect(Array.isArray(onDisk.include)).toBe(true);
  });

  it("loads policy without repositoryRoot and injects the call root", () => {
    const root = tempRoot();
    const policy = createDefaultConfig(root);
    saveConfig(root, policy);
    const raw = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty("repositoryRoot");
    expect(raw.include).toEqual(policy.include);

    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    expect(loaded.include).toEqual(policy.include);
  });

  it("ignores a legacy absolute repositoryRoot on disk", () => {
    const root = tempRoot();
    const config = createDefaultConfig(root);
    saveConfig(root, config);
    const path = join(root, ".semctx", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.repositoryRoot = "/some/other/machine/path";
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    expect(loaded.repositoryRoot).not.toBe("/some/other/machine/path");
  });

  it("ignores empty-string and relative legacy repositoryRoot values", () => {
    const root = tempRoot();
    saveConfig(root, createDefaultConfig(root));
    const path = join(root, ".semctx", "config.json");
    for (const legacy of ["", "."] as const) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      raw.repositoryRoot = legacy;
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      const loaded = loadConfig(root);
      expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    }
  });

  it("load then save still omits repositoryRoot", () => {
    const root = tempRoot();
    initWorkspace(root);
    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    saveConfig(root, loaded);
    const again = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(again).not.toHaveProperty("repositoryRoot");
  });
});
