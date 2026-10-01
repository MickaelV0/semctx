import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { createExtractionProgram, extractTypeScript } from "../src/ts-symbols";

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

test("omits prose JSDoc ASTs while retaining source comments and type-error links", () => {
  const text = "/** prose documentation */\nexport function plain() {}\n"
    + "/** @see plain */\nexport function linked() { plain() }\n";
  const { paths } = fixture({ "source.ts": text });
  const program = createExtractionProgram(paths);
  program.getTypeChecker();
  const source = program.getSourceFile(paths[0]!)!;
  const [plain, linked] = source.statements;
  expect(ts.getJSDocCommentsAndTags(plain!)).toHaveLength(0);
  expect(ts.getJSDocCommentsAndTags(linked!)).toHaveLength(1);
  expect(source.getFullText()).toBe(text);
  expect(program.getSourceFiles().some((file) => file.fileName.endsWith("lib.es2022.d.ts"))).toBe(true);
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
