/**
 * Orchestration for voluntary local finding feedback (ADR 0021 / HOK-645).
 *
 * Composes the pure core projections with the repository-store persistence primitive. Feedback is
 * an opinion, never verified correction evidence; a missing record is absence, never approval or
 * rejection. `record` is idempotent on an exact duplicate and refuses a conflicting answer —
 * callers must call `updateFeedback` explicitly to change a prior answer.
 */
import {
  SemctxError,
  applyFeedbackUpdate,
  buildFeedbackAggregateExport,
  buildFeedbackRecord,
  emptyFeedbackStoreFile,
  sameFeedbackAnswer,
  type FeedbackAggregateExportV1,
  type FeedbackAnswer,
  type FeedbackOutcome,
  type FeedbackReasonCode,
  type FeedbackRecordV1,
  type FeedbackStoreFileV1,
  type VerifyReport,
} from "@semantic-context/core";
import { readFeedbackStore, writeFeedbackStore } from "@semantic-context/repository-store";

/** Injected observation time (ISO 8601) — never `Date.now()` inside this orchestration. */
export type FeedbackClock = () => string;

interface ReadableStore {
  file: FeedbackStoreFileV1;
  digest: string | undefined;
}

function requireReadableStore(root: string): ReadableStore {
  const result = readFeedbackStore(root);
  if (result.status === "corrupted") {
    throw new SemctxError(
      "STORE_ERROR",
      `feedback store is malformed at ${result.path}; inspect or remove it manually before continuing`,
      { path: result.path },
    );
  }
  return { file: result.file ?? emptyFeedbackStoreFile(), digest: result.digest };
}

export interface RecordFeedbackInput extends FeedbackAnswer {
  report: VerifyReport;
  findingIndex: number;
}

export type RecordFeedbackResult =
  | { status: "recorded"; record: FeedbackRecordV1 }
  | { status: "unchanged"; record: FeedbackRecordV1 }
  | { status: "conflict"; existing: FeedbackRecordV1 };

/** Explicit recording. Exact duplicate is idempotent; a conflicting prior answer is refused. */
export function recordFeedback(root: string, now: FeedbackClock, input: RecordFeedbackInput): RecordFeedbackResult {
  const built = buildFeedbackRecord({ ...input, now: now() });
  if (built.status === "finding-not-found") {
    throw new SemctxError("INVALID_TASK_INPUT", `report has no finding at index ${input.findingIndex}`, {
      findingIndex: input.findingIndex,
      findingCount: input.report.findings.length,
    });
  }
  const { file, digest } = requireReadableStore(root);
  const existing = file.records.find((record) => record.recordId === built.record.recordId);
  if (existing !== undefined) {
    if (sameFeedbackAnswer(existing, input)) return { status: "unchanged", record: existing };
    return { status: "conflict", existing };
  }
  const nextFile: FeedbackStoreFileV1 = { ...file, records: [...file.records, built.record] };
  writeFeedbackStore(root, digest, nextFile);
  return { status: "recorded", record: built.record };
}

/** Absent store returns no records without creating anything. */
export function listFeedback(root: string): FeedbackRecordV1[] {
  return requireReadableStore(root).file.records;
}

export function showFeedback(root: string, recordId: string): FeedbackRecordV1 {
  const record = requireReadableStore(root).file.records.find((candidate) => candidate.recordId === recordId);
  if (record === undefined) throw new SemctxError("INVALID_TASK_INPUT", "feedback record was not found");
  return record;
}

/** Explicit update of an existing record's answer. Refuses when `recordId` does not exist. */
export function updateFeedback(
  root: string,
  now: FeedbackClock,
  recordId: string,
  answer: FeedbackAnswer,
): FeedbackRecordV1 {
  const { file, digest } = requireReadableStore(root);
  const index = file.records.findIndex((record) => record.recordId === recordId);
  if (index === -1) throw new SemctxError("INVALID_TASK_INPUT", "feedback record was not found");
  const updated = applyFeedbackUpdate(file.records[index]!, answer, now());
  const nextRecords = [...file.records];
  nextRecords[index] = updated;
  writeFeedbackStore(root, digest, { ...file, records: nextRecords });
  return updated;
}

/** Exact-ID removal. Deletes only that record; refuses when it does not exist. */
export function removeFeedback(root: string, recordId: string): void {
  const { file, digest } = requireReadableStore(root);
  const nextRecords = file.records.filter((record) => record.recordId !== recordId);
  if (nextRecords.length === file.records.length) {
    throw new SemctxError("INVALID_TASK_INPUT", "feedback record was not found");
  }
  writeFeedbackStore(root, digest, { ...file, records: nextRecords });
}

/** Sanitised aggregate for explicit sharing. Empty when the store is absent. */
export function exportFeedbackAggregate(root: string, now: FeedbackClock): FeedbackAggregateExportV1 {
  return buildFeedbackAggregateExport(requireReadableStore(root).file.records, now());
}

export type { FeedbackAnswer, FeedbackOutcome, FeedbackReasonCode };
