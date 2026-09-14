import type { PeakMemoryObservation } from "./resource-usage";

export interface MeasuredSummary {
  status: "MEASURED";
  /** Total samples this summary was computed over, MEASURED and NOT_MEASURED combined. */
  observedCount: number;
  measuredCount: number;
  missingCount: number;
  median: number;
  min: number;
  max: number;
  range: number;
}

export interface UnmeasuredSummary {
  status: "NOT_MEASURED";
  observedCount: number;
  missingCount: number;
  reason: string;
}

export type MetricSummary = MeasuredSummary | UnmeasuredSummary;

function median(sortedValues: readonly number[]): number {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle]!;
  return (sortedValues[middle - 1]! + sortedValues[middle]!) / 2;
}

/** Refuses to summarize a non-finite measurement rather than let it reach JSON as `null` silently. */
function summarizeNumbers(values: readonly number[], observedCount: number, emptyReason: string): MetricSummary {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`refusing to summarize a non-finite measurement: ${JSON.stringify(value)}`);
    }
  }
  if (values.length === 0) {
    return { status: "NOT_MEASURED", observedCount, missingCount: observedCount, reason: emptyReason };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    status: "MEASURED",
    observedCount,
    measuredCount: sorted.length,
    missingCount: observedCount - sorted.length,
    median: median(sorted),
    min: sorted[0]!,
    max: sorted.at(-1)!,
    range: sorted.at(-1)! - sorted[0]!,
  };
}

export function summarizeDurations(durationsMs: readonly number[]): MetricSummary {
  return summarizeNumbers(durationsMs, durationsMs.length, "no duration samples");
}

/**
 * Filters to MEASURED observations before computing statistics: a NOT_MEASURED sample carries no
 * numeric value, so it must never contribute a 0 that could pull the median toward zero. The
 * missing count is retained in the summary so it never reads as complete measurement.
 */
export function summarizePeakRss(observations: readonly PeakMemoryObservation[]): MetricSummary {
  const measured = observations.filter(
    (observation): observation is Extract<PeakMemoryObservation, { status: "MEASURED" }> =>
      observation.status === "MEASURED",
  );
  return summarizeNumbers(
    measured.map((observation) => observation.bytes),
    observations.length,
    `no sample reported a native peak RSS (${observations.length} sample(s) observed)`,
  );
}
