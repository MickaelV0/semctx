/**
 * The frozen first-use fixture (ADR 0018 / HOK-632): a base commit plus three independent,
 * unauthored TypeScript changes a maintainer might actually make. No `@invariant`/`@contract`/
 * `@risk` markers — every classification the demo reports comes from the packaged CLI's own
 * structural analysis (exported interfaces/types as compiler-enforced contracts, see
 * packages/context-engine/src/claim-builder.ts), never from something this fixture asserts.
 */

export type FixtureCaseId = "benign" | "exported-contract-risk" | "unsupported-limit";

export interface FixtureFile {
  /** POSIX-style path relative to the fixture repository root. */
  relPath: string;
  base: string;
  changed: string;
}

export interface FixtureCase {
  id: FixtureCaseId;
  file: FixtureFile;
  title: string;
  /** What a correctly-behaving packaged CLI must report for this file's own findings. */
  expectedFinding: "none" | "warn";
  /** The concise, factual explanation rendered next to this case's real captured output. */
  explanation: string;
  nextCheck: string;
}

const GREETING_FILE: FixtureFile = {
  relPath: "src/greeting.ts",
  base: `export function greetingFor(name: string): string {
  // Trim so a trailing newline pasted from a form field does not leak into the greeting.
  return \`Hello, \${name.trim()}!\`;
}
`,
  changed: `export function greetingFor(name: string): string {
  // Trim first: a trailing newline pasted from a form field should not leak into the greeting.
  return \`Hello, \${name.trim()}!\`;
}
`,
};

const CART_FILE: FixtureFile = {
  relPath: "src/cart.ts",
  base: `export interface CartTotal {
  subtotalCents: number;
  taxCents: number;
}

export function computeCartTotal(subtotalCents: number, taxCents: number): CartTotal {
  return { subtotalCents, taxCents };
}
`,
  changed: `export interface CartTotal {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
}

export function computeCartTotal(subtotalCents: number, taxCents: number, discountCents: number): CartTotal {
  return { subtotalCents, taxCents, discountCents };
}
`,
};

const PRICING_FILE: FixtureFile = {
  relPath: "src/pricing.ts",
  base: `function applyDiscountRate(amountCents: number, ratePercent: number): number {
  return Math.round((amountCents * (100 - ratePercent)) / 100);
}

export function finalPriceCents(amountCents: number, ratePercent: number): number {
  return applyDiscountRate(amountCents, ratePercent);
}
`,
  // A one-percentage-point-off discount: a real, silent business-logic bug. Neither
  // \`applyDiscountRate\` (unexported) nor \`finalPriceCents\` (an exported *function*, not an
  // interface/type) is discovered as a contract by claim-builder.ts, so no rule can fire on it.
  changed: `function applyDiscountRate(amountCents: number, ratePercent: number): number {
  return Math.round((amountCents * (100 - ratePercent - 1)) / 100);
}

export function finalPriceCents(amountCents: number, ratePercent: number): number {
  return applyDiscountRate(amountCents, ratePercent);
}
`,
};

export const FIXTURE_CASES: readonly FixtureCase[] = [
  {
    id: "benign",
    file: GREETING_FILE,
    title: "Benign change",
    expectedFinding: "none",
    explanation:
      "A comment-only edit inside an already-exported function. It touches no exported " +
      "interface/type and no tracked invariant, so the packaged CLI reports it with no finding.",
    nextCheck: "Confirm the diff only changes the comment; retain the repository's normal checks.",
  },
  {
    id: "exported-contract-risk",
    file: CART_FILE,
    title: "Exported-contract risk",
    expectedFinding: "warn",
    explanation:
      "A required field was added to the exported `CartTotal` interface. Exported " +
      "interfaces/types are discovered as compiler-enforced contracts automatically (no " +
      "author markers involved); this one has no covering test, which is exactly what the " +
      "advisory `contract_changed_without_test` rule exists to surface.",
    nextCheck: "Add or update a test that exercises `computeCartTotal` with the new field.",
  },
  {
    id: "unsupported-limit",
    file: PRICING_FILE,
    title: "Explicit unsupported/unproven limit",
    expectedFinding: "none",
    explanation:
      "An off-by-one discount bug in an internal helper reached through an exported " +
      "*function* (not an interface/type). This version's contract discovery only covers " +
      "exported interfaces/types, so this changed exported function is not treated as a " +
      "contract and the change carries no invariant. The packaged CLI reports no finding here " +
      "— absence of a finding is not a claim that the change is correct. Semctx analyzes " +
      "structural impact and declared contracts, not runtime/business correctness.",
    nextCheck:
      "Read the diff to `src/pricing.ts` and test that a 10% discount on 10000 cents returns 9000 cents. " +
      "Adding a marker alone does not prove business correctness.",
  },
];

const PACKAGE_JSON = `{
  "name": "semctx-first-use-demo-fixture",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Frozen, unauthored fixture for the semctx first-use demo (ADR 0018 / HOK-632)."
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
`;

/** Every file the fixture repository needs at the base commit, relative path -> content. */
export function baseFixtureFiles(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  files.set("package.json", PACKAGE_JSON);
  files.set("tsconfig.json", TSCONFIG_JSON);
  for (const c of FIXTURE_CASES) files.set(c.file.relPath, c.file.base);
  return files;
}

/** The changed content for every case file, relative path -> content. */
export function changedFixtureFiles(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const c of FIXTURE_CASES) files.set(c.file.relPath, c.file.changed);
  return files;
}
