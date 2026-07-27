/** Focused CLI transport for immutable, non-authorizing target proposals. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ProposeTargetArchitectureCommandV1Schema,
  proposeTargetArchitecture,
  type ProposeTargetArchitectureCommandV1,
} from "@semantic-context/app-services";
import { serializeControlReport } from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagString } from "../args";
import { info } from "../output";

export const CONTROL_TARGET_HELP = `  control target-propose --input <proposal.json> [--json]
      create one immutable agent-authored target proposal bound to the current FRESH state;
      the proposal remains hypothetical and grants no execution authority`;

const FORBIDDEN_SOURCE_STATE_FLAGS = [
  "base",
  "head",
  "base-ref",
  "head-ref",
  "baseRef",
  "headRef",
] as const;

export function runControlTarget(
  root: string,
  args: ParsedArgs,
): number | undefined {
  if (args.positionals[1] !== "target-propose") return undefined;
  assertPositionalCount(args, 2);
  const forbidden = FORBIDDEN_SOURCE_STATE_FLAGS.filter((name) => args.flags.has(name));
  if (forbidden.length > 0) {
    throw new Error(
      `semctx control target-propose does not accept caller-selected Git refs: ${
        forbidden.map((name) => `--${name}`).join(", ")
      }`,
    );
  }
  const inputFile = requiredFlag(args, "input");
  const command = ProposeTargetArchitectureCommandV1Schema.parse(
    readJsonObject(root, inputFile),
  ) as ProposeTargetArchitectureCommandV1;
  info(serializeControlReport(proposeTargetArchitecture(root, command)));
  return 0;
}

function assertPositionalCount(args: ParsedArgs, expected: number): void {
  if (args.positionals.length !== expected) {
    throw new Error("usage: semctx control target-propose --input <proposal.json>");
  }
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function readJsonObject(root: string, file: string): Record<string, unknown> {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`target proposal input file does not exist: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`target proposal input file is not valid JSON: ${String(cause)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target proposal input must be a JSON object");
  }
  return value as Record<string, unknown>;
}
