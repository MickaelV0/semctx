import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  exportFeedbackAggregate,
  listFeedback,
  recordFeedback,
  removeFeedback,
  showFeedback,
  updateFeedback,
  type FeedbackAnswer,
} from "@semantic-context/app-services";
import {
  FeedbackOutcomeSchema,
  FeedbackReasonCodeSchema,
  FEEDBACK_NOTE_MAX_LENGTH,
  SemctxError,
  VerifyReportSchema,
  type VerifyReport,
} from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagString } from "../args";
import { fail, heading, info, json, nowIso, success } from "../output";
import { writeNewLocalReportFile } from "../report-output";

function readVerifyReportFile(file: string): VerifyReport {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new SemctxError("IO_ERROR", `report file does not exist`, { path });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SemctxError("INVALID_TASK_INPUT", `report file is not valid JSON`, { path, cause: String(cause) });
  }
  const parsed = VerifyReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SemctxError("INVALID_TASK_INPUT", `report file is not a valid VerifyReport`, {
      path,
      issues: parsed.error.issues,
    });
  }
  if (Object.keys(raw as Record<string, unknown>).some((key) => !Object.hasOwn(parsed.data, key))) {
    throw new SemctxError("INVALID_TASK_INPUT", "report contains a top-level field that cannot be preserved");
  }
  return parsed.data as VerifyReport;
}

function requiredFlag(args: ParsedArgs, name: string, usage: string): string {
  const value = flagString(args, name);
  if (value === undefined) throw new SemctxError("INVALID_TASK_INPUT", `usage: ${usage}`);
  return value;
}

function parseFindingIndex(args: ParsedArgs, usage: string): number {
  const raw = requiredFlag(args, "finding", usage);
  const index = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== raw) {
    throw new SemctxError("INVALID_TASK_INPUT", `--finding must be a non-negative integer index, got "${raw}"`, {
      finding: raw,
    });
  }
  return index;
}

function parseAnswer(args: ParsedArgs, usage: string): FeedbackAnswer {
  const outcomeRaw = requiredFlag(args, "outcome", usage);
  const outcome = FeedbackOutcomeSchema.safeParse(outcomeRaw);
  if (!outcome.success) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      `--outcome must be one of ${FeedbackOutcomeSchema.options.join("|")}, got "${outcomeRaw}"`,
      { outcome: outcomeRaw },
    );
  }
  const reasonRaw = flagString(args, "reason");
  let reason: FeedbackAnswer["reason"];
  if (reasonRaw !== undefined) {
    const parsedReason = FeedbackReasonCodeSchema.safeParse(reasonRaw);
    if (!parsedReason.success) {
      throw new SemctxError(
        "INVALID_TASK_INPUT",
        `--reason must be one of ${FeedbackReasonCodeSchema.options.join("|")}, got "${reasonRaw}"`,
        { reason: reasonRaw },
      );
    }
    reason = parsedReason.data;
  }
  const note = flagString(args, "note");
  if (note !== undefined && note.length > FEEDBACK_NOTE_MAX_LENGTH) {
    throw new SemctxError("INVALID_TASK_INPUT", `--note must be at most ${FEEDBACK_NOTE_MAX_LENGTH} characters`, {
      length: note.length,
    });
  }
  return { outcome: outcome.data, ...(reason === undefined ? {} : { reason }), ...(note === undefined ? {} : { note }) };
}

function runRecord(root: string, args: ParsedArgs): number {
  const usage = "semctx feedback record --report <path> --finding <index> --outcome <useful|ignored|unclear|suspected-error> [--reason <code>] [--note <text>]";
  const reportPath = requiredFlag(args, "report", usage);
  const findingIndex = parseFindingIndex(args, usage);
  const answer = parseAnswer(args, usage);
  const report = readVerifyReportFile(reportPath);

  const result = recordFeedback(root, nowIso, { report, findingIndex, ...answer });
  if (result.status === "conflict") {
    fail(`feedback for finding ${findingIndex} already has a different answer; use 'feedback update ${result.existing.recordId}' to change it`);
    return 3;
  }
  const asJson = flagString(args, "json") !== undefined || args.flags.has("json");
  if (asJson) {
    json({ status: result.status, record: result.record });
    return 0;
  }
  success(result.status === "recorded" ? `recorded feedback ${result.record.recordId}` : `feedback ${result.record.recordId} already recorded (unchanged)`);
  return 0;
}

function runList(root: string, args: ParsedArgs): number {
  const records = listFeedback(root);
  if (args.flags.has("json")) {
    json({ records });
    return 0;
  }
  heading("Local feedback (private)");
  if (records.length === 0) info("  none");
  for (const record of records) {
    info(`  ${record.recordId}  ${record.outcome.padEnd(16)} rule=${record.finding.rule} finding=${record.finding.index}`);
  }
  return 0;
}

function runShow(root: string, args: ParsedArgs): number {
  const recordId = args.positionals[2];
  if (recordId === undefined) throw new SemctxError("INVALID_TASK_INPUT", "usage: semctx feedback show <record-id>");
  const record = showFeedback(root, recordId);
  if (args.flags.has("json")) {
    json({ record });
    return 0;
  }
  heading(`Feedback ${record.recordId} (private)`);
  info(`  outcome    : ${record.outcome}`);
  if (record.reason !== undefined) info(`  reason     : ${record.reason}`);
  if (record.note !== undefined) info(`  note       : ${record.note}`);
  info(`  rule       : ${record.finding.rule}`);
  info(`  finding idx: ${record.finding.index}`);
  info(`  recorded at: ${record.recordedAt}`);
  info(`  updated at : ${record.updatedAt}`);
  return 0;
}

function runUpdate(root: string, args: ParsedArgs): number {
  const recordId = args.positionals[2];
  const usage = "semctx feedback update <record-id> --outcome <useful|ignored|unclear|suspected-error> [--reason <code>] [--note <text>]";
  if (recordId === undefined) throw new SemctxError("INVALID_TASK_INPUT", `usage: ${usage}`);
  const answer = parseAnswer(args, usage);
  const record = updateFeedback(root, nowIso, recordId, answer);
  if (args.flags.has("json")) {
    json({ record });
    return 0;
  }
  success(`updated feedback ${record.recordId}`);
  return 0;
}

function runRemove(root: string, args: ParsedArgs): number {
  const recordId = args.positionals[2];
  if (recordId === undefined) throw new SemctxError("INVALID_TASK_INPUT", "usage: semctx feedback remove <record-id>");
  removeFeedback(root, recordId);
  if (args.flags.has("json")) {
    json({ removed: recordId });
    return 0;
  }
  success(`removed feedback ${recordId}`);
  return 0;
}

function runExport(root: string, args: ParsedArgs): number {
  const aggregate = exportFeedbackAggregate(root, nowIso);
  const outputPath = flagString(args, "output");
  if (args.flags.has("output") && outputPath === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", "--output requires a new local file path");
  }
  if (outputPath !== undefined) {
    writeNewLocalReportFile(resolve(process.cwd(), outputPath), `${JSON.stringify(aggregate, null, 2)}\n`);
  }
  json(aggregate);
  return 0;
}

/** `semctx feedback <record|list|show|update|remove|export>` — voluntary local finding feedback. */
export function runFeedback(root: string, args: ParsedArgs): number {
  const sub = args.positionals[1];
  switch (sub) {
    case "record":
      return runRecord(root, args);
    case "list":
      return runList(root, args);
    case "show":
      return runShow(root, args);
    case "update":
      return runUpdate(root, args);
    case "remove":
      return runRemove(root, args);
    case "export":
      return runExport(root, args);
    default:
      fail(`unknown 'feedback' subcommand: ${sub ?? "(none)"} (expected: record|list|show|update|remove|export)`);
      return 2;
  }
}
