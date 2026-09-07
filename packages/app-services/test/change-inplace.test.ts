import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeFilePath, loadSemanticModel, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { closeChange } from "../src";

const roots: string[] = [];

const INLINE = `# header comment stays

goal goal.keep-me
  statement: sibling declaration
  status: declared

# between comment stays
change change.inline-mvp
  statement: close me in place
  status: active
  provenance: author

# trailing comment stays
`;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "semctx-change-inplace-"));
  roots.push(dir);
  mkdirSync(join(dir, ".semctx", "semantic", "project"), { recursive: true });
  writeFileSync(join(dir, ".semctx", "semantic", "project", "control.sem"), INLINE, "utf8");
  return dir;
}

function changeSemFiles(dir: string): string[] {
  const changes = join(dir, ".semctx", "semantic", "changes");
  if (!existsSync(changes)) return [];
  return readdirSync(changes).filter((name) => name.endsWith(".sem")).sort();
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("change declarations mutate in place", () => {
  it("close --superseded rewrites the original inline block and does not duplicate the id", () => {
    const dir = root();
    const closed = closeChange(dir, { id: "change.inline-mvp", superseded: true });
    expect(closed.lifecycle).toBe("superseded");

    expect(changeSemFiles(dir)).toEqual([]);
    expect(existsSync(changeFilePath(dir, "change.inline-mvp"))).toBe(false);

    const after = readFileSync(join(dir, ".semctx", "semantic", "project", "control.sem"), "utf8");
    expect(after).toContain("# header comment stays");
    expect(after).toContain("# between comment stays");
    expect(after).toContain("# trailing comment stays");
    expect(after).toContain("goal goal.keep-me\n  statement: sibling declaration\n  status: declared");
    expect(after).toMatch(/change change\.inline-mvp\n(?:.*\n)*?  status: superseded/);

    const loaded = loadSemanticModel(dir);
    expect(loaded.duplicateIds).toEqual([]);
    expect(loaded.model.changes.map((change) => change.id)).toEqual(["change.inline-mvp"]);
    expect(loaded.model.changes[0]?.lifecycle).toBe("superseded");
    expect(loaded.model.nodes.map((node) => node.id)).toEqual(["goal.keep-me"]);
    expect(loaded.model.nodes[0]?.statement).toBe("sibling declaration");
  });

  it("writes a new id to .semctx/semantic/changes/<id>.sem", () => {
    const dir = root();
    const id = "change.brand-new";
    writeChangeFile(dir, newChangeContract({ id, statement: "fresh", provenance: "author" }));

    expect(existsSync(changeFilePath(dir, id))).toBe(true);
    expect(readFileSync(changeFilePath(dir, id), "utf8")).toContain(`change ${id}`);
    expect(readFileSync(join(dir, ".semctx", "semantic", "project", "control.sem"), "utf8")).toBe(INLINE);

    const loaded = loadSemanticModel(dir);
    expect(loaded.duplicateIds).toEqual([]);
    expect(loaded.model.changes.map((change) => change.id).sort()).toEqual(["change.brand-new", "change.inline-mvp"]);
  });
});
