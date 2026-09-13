/** ADR 0026: three repetitions per worker count, in a deterministic alternating subprocess order. */
export const WORKER_COUNTS = [1, 2, 4] as const;
export type WorkerCount = (typeof WORKER_COUNTS)[number];

export interface SamplePlanEntry {
  /** 0-based index in the deterministic subprocess invocation order. */
  position: number;
  repetition: 1 | 2 | 3;
  workers: WorkerCount;
}

const REPETITION_ORDER: readonly (readonly WorkerCount[])[] = [
  [1, 2, 4],
  [4, 1, 2],
  [2, 4, 1],
];

/** Pure and order-stable: repeated calls and repeated corpora must invoke fresh subprocesses in the same sequence. */
export function buildSamplePlan(): SamplePlanEntry[] {
  const plan: SamplePlanEntry[] = [];
  REPETITION_ORDER.forEach((order, repetitionIndex) => {
    for (const workers of order) {
      plan.push({ position: plan.length, repetition: (repetitionIndex + 1) as 1 | 2 | 3, workers });
    }
  });
  return plan;
}
