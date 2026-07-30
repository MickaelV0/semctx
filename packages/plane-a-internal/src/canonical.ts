import { createHash } from "node:crypto";
import type { CanonicalValue } from "./model";

/** Canonical source-text identity used by every Plane A seal and source digest. */
export function canonicalSourceText(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) result[key] = canonicalize(member);
    }
    return result;
  }
  throw new TypeError(`unsupported canonical value type: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
