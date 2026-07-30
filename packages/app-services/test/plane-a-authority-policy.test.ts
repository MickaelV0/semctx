import { describe, expect, it } from "bun:test";
import {
  REGISTERED_PLANE_A_AUTHORITY_COUNT,
  isPlaneAOperationAdmitted,
} from "../src/plane-a-authority-policy";

const scope = {
  repositoryIdentity: "repo:fixture",
  sourceStateDigest: "sha256:source",
  selectedPathSetDigest: "sha256:paths",
  selectedPaths: ["src/value.ts"],
  language: "typescript",
  dialectVersion: "5.9.3",
} as const;

function admitted(
  overrides: Partial<Parameters<typeof isPlaneAOperationAdmitted>[0]> = {},
): boolean {
  return isPlaneAOperationAdmitted({
    configVersion: 2,
    task: "verify",
    operation: "change",
    factKind: "function",
    scope,
    ...overrides,
  });
}

describe("independent Plane A task-relative authority policy", () => {
  it("admits only the explicit current policy surface", () => {
    expect(REGISTERED_PLANE_A_AUTHORITY_COUNT).toBe(85);
    expect(admitted()).toBe(true);
    expect(admitted({
      scope: {
        ...scope,
        selectedPaths: ["src/value.py"],
        language: "python",
        dialectVersion: "<=3.12",
      },
    })).toBe(true);
  });

  it("denies unknown task, operation, language, dialect, fact kind, and config tuples", () => {
    expect(admitted({ task: "index-health", operation: "inspect" })).toBe(false);
    expect(admitted({ operation: "delete" })).toBe(false);
    expect(admitted({ scope: { ...scope, language: "ruby" } })).toBe(false);
    expect(admitted({ scope: { ...scope, dialectVersion: "5.8.0" } })).toBe(false);
    expect(admitted({ factKind: "analysis" })).toBe(false);
    expect(admitted({
      configVersion: 1,
      scope: {
        ...scope,
        selectedPaths: ["src/value.py"],
        language: "python",
        dialectVersion: "<=3.12",
      },
    })).toBe(false);
  });
});
