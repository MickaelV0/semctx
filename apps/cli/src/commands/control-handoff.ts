import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureControlHandoffV2,
  resumeControlHandoffV2,
} from "@semantic-context/app-services/control-handoff";
import { explainControlHandoffV2 } from "@semantic-context/app-services/control-continuation";
import {
  ControlHandoffCaptureRequestV2Schema,
  ControlHandoffResumeRequestV2Schema,
  type ControlHandoffCaptureRequestV2,
  type ControlHandoffResumeRequestV2,
} from "@semantic-context/control-model/control-handoff";
import { ControlContinuationExplainRequestV1Schema } from "@semantic-context/control-model/control-continuation";
import { serializeControlReport } from "@semantic-context/control-model/reconciliation";
import type { ParsedArgs } from "../args";
import { flagString } from "../args";
import { info } from "../output";

export const CONTROL_HANDOFF_HELP = `  control handoff <input.json> [--json]
      capture a strict Control Handoff v2 capsule in ignored working state
  control resume-handoff <capsule-hash> [--json]
      resume exactly one Control Handoff v2 capsule by its canonical hash
  control handoff explain --hash <sha256> [--json]
      explain one intact Control Handoff v2 capsule's historical context and
      current dependency applicability, granting no execution authority`;

export function runControlHandoff(
  root: string,
  args: ParsedArgs,
): number | undefined {
  const subcommand = args.positionals[1];
  if (subcommand === "handoff" && args.positionals[2] === "explain") return explain(root, args);
  if (subcommand === "handoff") return capture(root, args);
  if (subcommand === "resume-handoff") return resume(root, args);
  return undefined;
}

function explain(root: string, args: ParsedArgs): number {
  const hash = flagString(args, "hash");
  if (hash === undefined || hash.length === 0) {
    throw new Error("usage: semctx control handoff explain --hash <sha256>");
  }
  const request = ControlContinuationExplainRequestV1Schema.parse({
    schemaVersion: 1,
    capsuleHash: hash,
  });
  const result = explainControlHandoffV2(root, request);
  info(serializeControlReport(result));
  return result.status === "REFUSED" ? 2 : 0;
}

function capture(root: string, args: ParsedArgs): number {
  assertPositionalCount(args, 3, "semctx control handoff <input.json>");
  const inputFile = requiredPositional(args, 2, "semctx control handoff <input.json>");
  const request = ControlHandoffCaptureRequestV2Schema.parse(
    readJsonObject(root, inputFile, "control handoff input"),
  ) as ControlHandoffCaptureRequestV2;
  const result = captureControlHandoffV2(root, request);
  info(serializeControlReport(result));
  return result.status === "REFUSED" ? 3 : 0;
}

function resume(root: string, args: ParsedArgs): number {
  assertPositionalCount(args, 3, "semctx control resume-handoff <capsule-hash>");
  const request = ControlHandoffResumeRequestV2Schema.parse({
    schemaVersion: 2,
    capsuleHash: requiredPositional(
      args,
      2,
      "semctx control resume-handoff <capsule-hash>",
    ),
  }) as ControlHandoffResumeRequestV2;
  const result = resumeControlHandoffV2(root, request);
  info(serializeControlReport(result));
  return result.status === "REFUSED" ? 3 : 0;
}

function readJsonObject(root: string, file: string, label: string): Record<string, unknown> {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${label} file is not valid JSON: ${String(cause)}`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredPositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) throw new Error(`usage: ${usage}`);
  return value;
}

function assertPositionalCount(args: ParsedArgs, expected: number, usage: string): void {
  if (args.positionals.length !== expected) throw new Error(`usage: ${usage}`);
}
