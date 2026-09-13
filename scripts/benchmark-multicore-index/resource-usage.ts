/**
 * Bun's `SyncSubprocess.resourceUsage` reports native lifetime `maxRSS` in bytes and `cpuTime`
 * in microseconds (see bun-types docs/runtime/child-process.mdx). On Bun 1.4.0/Windows, `maxRSS`
 * is observed as a `number` but `cpuTime.user/system/total` are observed as `bigint` despite
 * bun-types declaring `number`; fields are read as `unknown` and normalized defensively rather
 * than trusted at their declared type. A missing, zero (RSS only), negative, non-finite,
 * unsafe-to-represent or otherwise unexpected value is reported as NOT_MEASURED with a reason;
 * it is never inferred from a post-run sample, silently treated as a zero-memory success, and
 * never causes this module itself to throw.
 */
export interface NativeResourceUsage {
  maxRSS?: unknown;
  cpuTime?: { user?: unknown; system?: unknown; total?: unknown };
}

export type PeakMemoryObservation =
  | { status: "MEASURED"; bytes: number }
  | { status: "NOT_MEASURED"; reason: string };

export type CpuTimeObservation =
  | { status: "MEASURED"; userMicroseconds: number; systemMicroseconds: number; totalMicroseconds: number }
  | { status: "NOT_MEASURED"; reason: string };

/** Renders an unexpected raw metric value into a safe reason string; bigint never reaches JSON.stringify unconverted. */
function describeUnexpected(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested: unknown) => (typeof nested === "bigint" ? `${nested}n` : nested))
      ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalizes a `number | bigint` native metric to a non-negative, finite, precision-safe `number`.
 * Bigints outside `Number.MAX_SAFE_INTEGER` cannot be represented exactly, so they are treated as
 * unmeasured rather than silently losing precision.
 */
function normalizeNonNegativeMetric(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return null;
}

export function observePeakRssBytes(resourceUsage: NativeResourceUsage | undefined): PeakMemoryObservation {
  if (resourceUsage === undefined) {
    return { status: "NOT_MEASURED", reason: "subprocess reported no resource usage" };
  }
  const bytes = normalizeNonNegativeMetric(resourceUsage.maxRSS);
  if (bytes === null || bytes <= 0) {
    return { status: "NOT_MEASURED", reason: `native maxRSS was ${describeUnexpected(resourceUsage.maxRSS)}` };
  }
  return { status: "MEASURED", bytes };
}

export function observeCpuTime(resourceUsage: NativeResourceUsage | undefined): CpuTimeObservation {
  const cpuTime = resourceUsage?.cpuTime;
  if (cpuTime === undefined) {
    return { status: "NOT_MEASURED", reason: "subprocess reported no native CPU time" };
  }
  const userMicroseconds = normalizeNonNegativeMetric(cpuTime.user);
  const systemMicroseconds = normalizeNonNegativeMetric(cpuTime.system);
  const totalMicroseconds = normalizeNonNegativeMetric(cpuTime.total);
  if (userMicroseconds === null || systemMicroseconds === null || totalMicroseconds === null) {
    return {
      status: "NOT_MEASURED",
      reason: `native CPU time was ${describeUnexpected({ user: cpuTime.user, system: cpuTime.system, total: cpuTime.total })}`,
    };
  }
  return { status: "MEASURED", userMicroseconds, systemMicroseconds, totalMicroseconds };
}
