import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { extractionContext, extractTypeScript, extractTypeScriptParallel } from "../src/ts-symbols";

const temporary: string[] = [];
function fixture(files: Record<string, string>): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "semctx-semantic-memory-"));
  temporary.push(root);
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  });
  return { root, paths };
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([false, true])("repository directory aliases preserve imports and worker facts (reference=%s)", async (reference) => {
  const { root, paths } = fixture({
    "src/source.ts": (reference ? "/// <reference path='./shared.d.ts' />\n" : "")
      + "import { target } from './dependency';\nimport { typed } from 'trusted-tooling';\nexport function run() { target(); typed(); }\n",
    "src/shared.d.ts": "declare const shared: string;\n",
    "src/dependency.ts": "export function target() {}\n",
    "src/independent.ts": "export function independent() {}\n",
    "node_modules/trusted-tooling/package.json": "{\"name\":\"trusted-tooling\",\"types\":\"index.d.ts\"}\n",
    "node_modules/trusted-tooling/index.d.ts": "export declare function typed(): string;\n",
  });
  const aliasBase = mkdtempSync(join(tmpdir(), "semctx-semantic-alias-"));
  temporary.push(aliasBase);
  const aliasRoot = join(aliasBase, "repository");
  symlinkSync(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const roots = paths.slice(0, 4);
  const aliasPaths = roots.map((path) => join(aliasRoot, relative(root, path)));
  const expected = extractTypeScript(roots, root);
  expect(expected.modules).toEqual(["src/dependency.ts", "src/source.ts", "src/independent.ts"]);
  expect(expected.imports.map((item) => item.resolvedRelPath)).toEqual([
    "src/dependency.ts", "node_modules/trusted-tooling/index.d.ts",
  ]);
  expect(extractTypeScript(aliasPaths, aliasRoot)).toEqual(expected);
  const parallel = await extractTypeScriptParallel(aliasPaths, aliasRoot, 2);
  expect(parallel.parallelism).toMatchObject(reference
    ? { used: 1, mode: "preflight-fallback" }
    : { used: 2, mode: "parallel" });
  expect(parallel.extraction).toEqual(expected);
});

test("omits prose JSDoc ASTs while retaining source comments and type-error links", () => {
  const text = "/** prose documentation */\nexport function plain() {}\n"
    + "/** @see plain */\nexport function linked() { plain() }\n";
  const { root, paths } = fixture({ "source.ts": text });
  const createProgram = extractionContext.createProgram;
  const programs: ts.Program[] = [];
  const observe = spyOn(extractionContext, "createProgram").mockImplementation((roots) => {
    const program = createProgram(roots);
    programs.push(program);
    return program;
  });
  try {
    const extraction = extractTypeScript(paths, root);
    expect(observe).toHaveBeenCalledTimes(1);
    const program = programs[0]!;
    const source = program.getSourceFile(paths[0]!)!;
    const [plain, linked] = source.statements;
    expect(ts.getJSDocCommentsAndTags(plain!)).toHaveLength(0);
    expect(ts.getJSDocCommentsAndTags(linked!)).toHaveLength(1);
    expect(source.getFullText()).toBe(text);
    expect(extraction.symbols[0]!.jsdoc).toBe("/** prose documentation */");
    expect(program.getSourceFiles().some((file) => file.fileName.endsWith("lib.es2022.d.ts"))).toBe(true);
  } finally {
    observe.mockRestore();
  }
});

test("preserves TSX, raw markers, aliases and calls through shared declarations", () => {
  const doc = "/** Description.\n * @capability render-view\n * @invariant keep-target: calls keep their declaration\n * @see renamed\n * {@link renamed}\n */";
  const { root, paths } = fixture({
    "src/view.tsx": "/// <reference path='./shared.d.ts' />\n"
      + "import { target as renamed, Service as Alias } from './dependency';\n"
      + `${doc}\nexport function view() { renamed(); new Alias().run(); shared.invoke(); return <div /> }\n`,
    "src/shared.d.ts": "interface Shared { invoke: typeof import('./dependency').target }\ndeclare const shared: Shared;\n",
    "src/dependency.ts": "export function target() {}\nexport class Service { run() { target() } }\n",
  });
  const extraction = extractTypeScript(paths.slice(0, 2), root);
  expect(extraction.modules).toEqual(["src/view.tsx"]);
  expect(extraction.symbols).toHaveLength(1);
  expect(extraction.symbols[0]).toMatchObject({ name: "view", exported: true, jsdoc: doc });
  expect(extraction.symbols[0]!.markers).toEqual([
    { tag: "capability", slug: "render-view" },
    { tag: "invariant", slug: "keep-target", statement: "calls keep their declaration" },
  ]);
  expect(extraction.imports).toEqual([{
    fromRelPath: "src/view.tsx", moduleSpecifier: "./dependency",
    resolvedRelPath: "src/dependency.ts", names: ["renamed", "Alias"], line: 2,
  }]);
  expect(extraction.calls.map((call) => ({
    name: call.calleeName, path: call.calleeRelPath, target: call.calleeSymbolPath,
  }))).toEqual([
    { name: "renamed", path: "src/dependency.ts", target: "target" },
    { name: "run", path: "src/dependency.ts", target: "Service.run" },
    { name: "invoke", path: undefined, target: "invoke" },
  ]);
});

test("keeps standard libraries and declared package types available to the TypeChecker", () => {
  const { root, paths } = fixture({
    "src/source.ts": "import { typed } from 'trusted-tooling';\nexport function run() { return typed() }\n",
    "node_modules/trusted-tooling/package.json": "{\"name\":\"trusted-tooling\",\"types\":\"index.d.ts\"}\n",
    "node_modules/trusted-tooling/index.d.ts": "export declare function typed(): string;\n",
  });
  const createProgram = extractionContext.createProgram;
  const programs: ts.Program[] = [];
  const observe = spyOn(extractionContext, "createProgram").mockImplementation((roots) => {
    const program = createProgram(roots);
    programs.push(program);
    return program;
  });
  try {
    const extraction = extractTypeScript([paths[0]!], root);
    expect(programs[0]!.getSourceFiles().some((file) => file.fileName.endsWith("lib.es2022.d.ts"))).toBe(true);
    expect(programs[0]!.getSourceFiles().some((file) => file.fileName.endsWith("trusted-tooling/index.d.ts"))).toBe(true);
    expect(extraction.imports[0]).toMatchObject({
      moduleSpecifier: "trusted-tooling",
      resolvedRelPath: "node_modules/trusted-tooling/index.d.ts",
    });
    expect(extraction.calls.find((call) => call.calleeName === "typed")).toMatchObject({
      calleeSymbolPath: "typed",
    });
  } finally {
    observe.mockRestore();
  }
});

test.each([
  ["relative import", "import { secret } from '../../outside/secret'; export const value = secret;\n"],
  ["reference path", "/// <reference path='../../outside/secret.d.ts' />\nexport const value = secret;\n"],
])("refuses a %s outside the repository before TypeScript reads it", (_label, source) => {
  const base = mkdtempSync(join(tmpdir(), "semctx-semantic-boundary-"));
  temporary.push(base);
  const root = join(base, "repository");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const sourcePath = join(root, "src", "source.ts");
  const externalSource = join(outside, "secret.ts");
  const externalDeclaration = join(outside, "secret.d.ts");
  writeFileSync(sourcePath, source, "utf8");
  writeFileSync(externalSource, "export const secret = 'outside';\n", "utf8");
  writeFileSync(externalDeclaration, "declare const secret: string;\n", "utf8");
  const readFile = ts.sys.readFile.bind(ts.sys);
  const externalReads: string[] = [];
  const observe = spyOn(ts.sys, "readFile").mockImplementation((path, encoding) => {
    if (path === externalSource || path === externalDeclaration) externalReads.push(path);
    return readFile(path, encoding);
  });
  try {
    expect(() => extractTypeScript([sourcePath], root)).toThrow(/OUTSIDE_REPOSITORY/);
    expect(externalReads).toEqual([]);
  } finally {
    observe.mockRestore();
  }
});
