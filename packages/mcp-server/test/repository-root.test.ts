import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolPublicError } from "../src/public-tool-error";
import {
  createRepositoryRootResolver,
  optionalProcessBoundRoot,
} from "../src/repository-root";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("optionalProcessBoundRoot", () => {
  test("treats missing, empty, and unsubstituted host placeholders as unset", () => {
    expect(optionalProcessBoundRoot(undefined)).toBeUndefined();
    expect(optionalProcessBoundRoot("")).toBeUndefined();
    expect(optionalProcessBoundRoot("   ")).toBeUndefined();
    expect(optionalProcessBoundRoot("${CLAUDE_PROJECT_DIR}")).toBeUndefined();
    expect(optionalProcessBoundRoot("  ${CLAUDE_PROJECT_DIR}  ")).toBeUndefined();
    expect(optionalProcessBoundRoot("${CLAUDE_PROJECT_DIR}/nested")).toBeUndefined();
    expect(optionalProcessBoundRoot("${FOO}")).toBeUndefined();
    expect(optionalProcessBoundRoot("${GROK_WORKSPACE}")).toBeUndefined();
    expect(optionalProcessBoundRoot("${FOO}/nested")).toBeUndefined();
  });

  test("keeps a concrete value for later canonicalization", () => {
    expect(optionalProcessBoundRoot("/abs/repo")).toBe("/abs/repo");
    expect(optionalProcessBoundRoot(".")).toBe(".");
  });

  test("keeps a concrete path that merely contains a placeholder-shaped segment", () => {
    // ADR 0012 binds a concrete filesystem path at construction. `$`, `{` and `}` are legal
    // filename characters, so only a value that *starts* with `${NAME}` is an unexpanded
    // host template; an embedded one is part of the path.
    expect(optionalProcessBoundRoot("/srv/${tenant}/repo")).toBe("/srv/${tenant}/repo");
    expect(optionalProcessBoundRoot("C:\\work\\${legacy}\\app")).toBe("C:\\work\\${legacy}\\app");
    expect(optionalProcessBoundRoot("/workspaces/${REPO_NAME}")).toBe("/workspaces/${REPO_NAME}");
  });

  test("keeps a bare dollar: only a braced `${NAME}` is a host placeholder", () => {
    expect(optionalProcessBoundRoot("/home/me/$work/repo")).toBe("/home/me/$work/repo");
    expect(optionalProcessBoundRoot("C:\\repos\\$scratch\\semctx")).toBe(
      "C:\\repos\\$scratch\\semctx",
    );
  });
});

describe("createRepositoryRootResolver host placeholders", () => {
  test("does not bind construction on an unexpanded placeholder", () => {
    const resolver = createRepositoryRootResolver("${GROK_WORKSPACE}");
    expect(resolver.current()).toBeUndefined();
    const root = resolve(mkdtempSync(join(tmpdir(), "semctx-root-")));
    temporaryRoots.push(root);
    // resolve() can remain on a Windows 8.3 alias (RUNNER~1); the resolver
    // returns realpathSync.native(), same contract as loadConfig / ADR 0012.
    const canonical = realpathSync.native(root);
    expect(resolver.resolve(root)).toBe(canonical);
    expect(resolver.resolve(canonical)).toBe(canonical);
    expect(resolver.current()).toBe(canonical);
  });

  test("binds at construction on a real path containing a placeholder-shaped segment", () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-root-")));
    temporaryRoots.push(parent);
    const root = join(parent, "${tenant}");
    mkdirSync(root);

    // The operator-configured hard bind must survive: this is a concrete filesystem path,
    // not an unexpanded host template, so it binds now and no later call can retarget it.
    const resolver = createRepositoryRootResolver(root);
    expect(resolver.current()).toBe(realpathSync.native(root));
    expect(() => resolver.resolve(parent)).toThrow(ToolPublicError);
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
