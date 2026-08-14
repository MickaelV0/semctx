import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolPublicError } from "../src/public-tool-error";
import {
  createRepositoryRootResolver,
  optionalProcessBoundRoot,
} from "../src/repository-root";

describe("optionalProcessBoundRoot", () => {
  test("treats missing, empty, and unsubstituted host placeholders as unset", () => {
    expect(optionalProcessBoundRoot(undefined)).toBeUndefined();
    expect(optionalProcessBoundRoot("")).toBeUndefined();
    expect(optionalProcessBoundRoot("   ")).toBeUndefined();
    expect(optionalProcessBoundRoot("${CLAUDE_PROJECT_DIR}")).toBeUndefined();
    expect(optionalProcessBoundRoot("  ${CLAUDE_PROJECT_DIR}  ")).toBeUndefined();
    expect(optionalProcessBoundRoot("${CLAUDE_PROJECT_DIR}/nested")).toBeUndefined();
  });

  test("keeps a concrete value for later canonicalization", () => {
    expect(optionalProcessBoundRoot("/abs/repo")).toBe("/abs/repo");
    expect(optionalProcessBoundRoot(".")).toBe(".");
  });
});

describe("createRepositoryRootResolver host placeholders", () => {
  test("does not bind construction on an unexpanded placeholder", () => {
    const resolver = createRepositoryRootResolver("${CLAUDE_PROJECT_DIR}");
    expect(resolver.current()).toBeUndefined();
    const root = resolve(mkdtempSync(join(tmpdir(), "semctx-root-")));
    expect(resolver.resolve(root)).toBe(root);
    expect(resolver.current()).toBe(root);
  });

  test("still fails closed on a real relative process root", () => {
    expect(() => createRepositoryRootResolver(".")).toThrow(ToolPublicError);
    try {
      createRepositoryRootResolver(".");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolPublicError);
      expect((error as ToolPublicError).code).toBe("REPOSITORY_ROOT_INVALID");
    }
  });
});
