import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NullSemanticCandidateProvider,
  CocoIndexCandidateProvider,
  CocoIndexProviderError,
  resolveProvider,
} from "../src/index";

describe("NullSemanticCandidateProvider", () => {
  it("is always available and contributes nothing", async () => {
    const provider = new NullSemanticCandidateProvider();
    expect(provider.name).toBe("none");
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.search({ query: "anything", repositoryRoot: ".", limit: 5 })).toEqual([]);
  });
});

describe("resolveProvider", () => {
  it("maps names to providers, defaulting to null", () => {
    expect(resolveProvider("cocoindex").name).toBe("cocoindex");
    expect(resolveProvider("none").name).toBe("none");
    expect(resolveProvider("something-unknown").name).toBe("none");
  });
});

describe("CocoIndexCandidateProvider.parse (tolerant to ccc output shapes)", () => {
  const provider = new CocoIndexCandidateProvider();

  it("parses a JSON array with field aliases", () => {
    const rows = provider.parse(JSON.stringify([{ file: "src/a.ts", symbol: "foo", score: 0.9, start_line: 3 }]));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ filePath: "src/a.ts", symbolName: "foo", score: 0.9, startLine: 3, provider: "cocoindex" });
  });

  it("parses a { results: [...] } envelope", () => {
    const rows = provider.parse(JSON.stringify({ results: [{ path: "src/b.ts" }] }));
    expect(rows[0]?.filePath).toBe("src/b.ts");
    expect(rows[0]?.score).toBe(0.5); // default when absent
  });

  it("parses newline-delimited JSON", () => {
    const rows = provider.parse('{"file":"src/c.ts"}\n{"file":"src/d.ts"}');
    expect(rows.map((r) => r.filePath)).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("distinguishes valid empty output from empty, noisy, or malformed output", () => {
    expect(provider.parse("[]")).toEqual([]);
    for (const invalid of ["", "this is not json", '{"results":{}}', '{"file":"src/a.ts"}\nnoise']) {
      expect(() => provider.parse(invalid)).toThrow(CocoIndexProviderError);
    }
  });
});

describe("CocoIndexCandidateProvider graceful degradation", () => {
  it("reports unavailable when ccc is missing", async () => {
    const provider = new CocoIndexCandidateProvider({ command: "definitely-not-a-real-command-xyzzy" });
    expect(await provider.isAvailable()).toBe(false);
  });

  it("keeps candidates unattested while ccc exposes no source-state seal", async () => {
    const provider = new CocoIndexCandidateProvider();
    expect("attestedSearch" in provider).toBe(false);
  });
});

describe("CocoIndexCandidateProvider process boundary", () => {
  it("uses ccc version and puts the query after the option terminator", async () => {
    await withFakeCcc(`
      const args = process.argv.slice(2);
      if (args[0] === "version") process.stdout.write("0.2.41\\n");
      else if (JSON.stringify(args) === JSON.stringify(["search", "--json", "--limit", "3", "--", "find --literal code"])) {
        process.stdout.write(JSON.stringify([{ path: "src/alias.ts", similarity: 0.75, start_line: 4 }]));
      } else process.exit(9);
    `, async (provider) => {
      expect(await provider.version()).toBe("0.2.41");
      expect(await provider.search({ query: "find --literal code", repositoryRoot: ".", limit: 3 })).toEqual([{
        filePath: "src/alias.ts",
        score: 0.75,
        startLine: 4,
        provider: "cocoindex",
      }]);
    });
  });

  it("kills version and search after their named budgets", async () => {
    await withFakeCcc("setTimeout(() => {}, 10_000);", async (provider) => {
      const started = Date.now();
      expect(await provider.version()).toBeNull();
      await expectProviderError(provider.search({ query: "x", repositoryRoot: ".", limit: 1 }), "TIMEOUT");
      expect(Date.now() - started).toBeLessThan(2_000);
    }, { versionTimeoutMs: 50, searchTimeoutMs: 50 });
  });

  it("distinguishes invalid output from process failure", async () => {
    await withFakeCcc(`
      const args = process.argv.slice(2);
      if (args[0] === "version") process.stdout.write("0.2.41\\n");
      else process.stdout.write("not-json\\n");
    `, async (provider) => {
      await expectProviderError(provider.search({ query: "x", repositoryRoot: ".", limit: 1 }), "INVALID_OUTPUT");
    });
    await withFakeCcc(`
      const args = process.argv.slice(2);
      if (args[0] === "version") process.stdout.write("0.2.41\\n");
      else process.exit(7);
    `, async (provider) => {
      await expectProviderError(provider.search({ query: "x", repositoryRoot: ".", limit: 1 }), "PROCESS_FAILURE");
    });
  });
});

async function withFakeCcc(
  source: string,
  run: (provider: CocoIndexCandidateProvider) => Promise<void>,
  budgets: { versionTimeoutMs?: number; searchTimeoutMs?: number } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "semctx-fake-ccc-"));
  const script = join(root, "ccc.mjs");
  writeFileSync(script, source);
  try {
    await run(new CocoIndexCandidateProvider({
      command: process.execPath,
      commandArgs: [script],
      ...budgets,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function expectProviderError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}
