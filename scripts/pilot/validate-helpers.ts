/**
 * Hand-rolled strict validators. Zod is a workspace-package dependency, not a root one, so it does
 * not resolve from `scripts/` without adding a root dependency (out of scope for this packet). These
 * primitives give the same "reject unknown/wrong-shaped input" guarantee without one.
 */

export class PilotValidationError extends Error {
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "PilotValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function field(object: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in object)) throw new PilotValidationError(path, `missing required field "${key}"`);
  return object[key];
}

export function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PilotValidationError(path, "expected an object");
  return value;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PilotValidationError(path, "expected an array");
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PilotValidationError(path, "expected a non-empty string");
  return value;
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new PilotValidationError(path, "expected a boolean");
  return value;
}

export function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new PilotValidationError(path, "expected a finite number");
  return value;
}

export function requireInteger(value: unknown, path: string): number {
  const n = requireFiniteNumber(value, path);
  if (!Number.isInteger(n)) throw new PilotValidationError(path, "expected an integer");
  return n;
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PilotValidationError(path, `expected one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

export function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((item, index) => requireString(item, `${path}[${index}]`));
}

const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;
export function requireSha256(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (!SHA256_HEX.test(s)) throw new PilotValidationError(path, "expected a sha256:<hex64> digest");
  return s;
}

const GIT_SHA = /^[0-9a-f]{40}$/;
export function requireGitSha(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (!GIT_SHA.test(s)) throw new PilotValidationError(path, "expected a 40-character hex commit SHA");
  return s;
}

/** Rejects unknown keys so a governed input cannot silently smuggle extra fields (ADR 0019). */
export function requireExactKeys(object: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new PilotValidationError(path, `unknown field "${key}"`);
  }
}
