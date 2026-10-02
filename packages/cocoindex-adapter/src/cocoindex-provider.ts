import { normalizePath } from "@semantic-context/core";
import type { SemanticCandidate, SemanticCandidateProvider, SemanticSearchInput } from "./provider";

export interface CocoIndexOptions {
  /** CLI command to invoke (default: "ccc"). */
  command?: string;
  /** Fixed command arguments before the ccc subcommand, used by wrappers and process fixtures. */
  commandArgs?: string[];
  versionTimeoutMs?: number;
  searchTimeoutMs?: number;
}

export const CCC_VERSION_TIMEOUT_MS = 2_000;
export const CCC_SEARCH_TIMEOUT_MS = 15_000;

export type CocoIndexProviderErrorCode = "TIMEOUT" | "PROCESS_FAILURE" | "INVALID_OUTPUT";

export class CocoIndexProviderError extends Error {
  constructor(readonly code: CocoIndexProviderErrorCode, message: string) {
    super(message);
    this.name = "CocoIndexProviderError";
  }
}

/**
 * Isolated CocoIndex adapter. Shells out to the `ccc` CLI (cocoindex-code) if present,
 * and degrades gracefully to zero candidates when it is not installed or errors.
 *
 * The exact result mapping is tolerant: it accepts a JSON array, a `{ results: [...] }`
 * object, or newline-delimited JSON, and reads common field aliases. This keeps the
 * adapter robust across `ccc` versions without the core ever depending on it.
 */
export class CocoIndexCandidateProvider implements SemanticCandidateProvider {
  readonly name = "cocoindex";
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly versionTimeoutMs: number;
  private readonly searchTimeoutMs: number;

  constructor(options: CocoIndexOptions = {}) {
    this.command = options.command ?? "ccc";
    this.commandArgs = [...(options.commandArgs ?? [])];
    this.versionTimeoutMs = positiveBudget(options.versionTimeoutMs, CCC_VERSION_TIMEOUT_MS);
    this.searchTimeoutMs = positiveBudget(options.searchTimeoutMs, CCC_SEARCH_TIMEOUT_MS);
  }

  async version(): Promise<string | null> {
    try {
      const proc = Bun.spawnSync(
        [this.command, ...this.commandArgs, "version"],
        { stdout: "pipe", stderr: "pipe", timeout: this.versionTimeoutMs },
      );
      if (proc.exitCode !== 0 || proc.exitedDueToTimeout) return null;
      const version = new TextDecoder().decode(proc.stdout).trim();
      return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.version()) !== null;
  }

  async search(input: SemanticSearchInput): Promise<SemanticCandidate[]> {
    let proc;
    try {
      proc = Bun.spawnSync(
        [
          this.command,
          ...this.commandArgs,
          "search",
          "--json",
          "--limit",
          String(input.limit),
          "--",
          input.query,
        ],
        {
          cwd: input.repositoryRoot,
          stdout: "pipe",
          stderr: "pipe",
          timeout: this.searchTimeoutMs,
        },
      );
    } catch (error) {
      throw new CocoIndexProviderError("PROCESS_FAILURE", `ccc search could not start: ${String(error)}`);
    }
    if (proc.exitedDueToTimeout) {
      throw new CocoIndexProviderError("TIMEOUT", `ccc search exceeded ${this.searchTimeoutMs}ms`);
    }
    if (proc.exitCode !== 0) {
      throw new CocoIndexProviderError("PROCESS_FAILURE", `ccc search exited with code ${proc.exitCode}`);
    }
    return this.parse(new TextDecoder().decode(proc.stdout).trim());
  }

  /** Parse raw `ccc` output into candidates. Exposed for testing. */
  parse(text: string): SemanticCandidate[] {
    if (text.length === 0) throw invalidOutput("ccc search returned empty output");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.parseLines(text);
    }
    const rows = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.results)
        ? raw.results
        : null;
    if (rows === null) throw invalidOutput("ccc search returned an unsupported JSON envelope");
    return rows.map((row) => this.toCandidate(row));
  }

  private parseLines(text: string): SemanticCandidate[] {
    const out: SemanticCandidate[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const candidate = this.toCandidate(JSON.parse(trimmed));
        out.push(candidate);
      } catch {
        throw invalidOutput("ccc search returned malformed NDJSON");
      }
    }
    if (out.length === 0) throw invalidOutput("ccc search returned no JSON records");
    return out;
  }

  private toCandidate(row: unknown): SemanticCandidate {
    if (!isRecord(row)) throw invalidOutput("ccc candidate must be an object");
    const obj = row;
    const filePath = pickString(obj, ["filePath", "file", "path"]);
    if (filePath === undefined) throw invalidOutput("ccc candidate requires a file path");
    const score = pickNumber(obj, ["score", "similarity", "relevance"]);
    if (score !== undefined && (score < 0 || score > 1)) {
      throw invalidOutput("ccc candidate score must be between 0 and 1");
    }
    const candidate: SemanticCandidate = {
      filePath: normalizePath(filePath),
      score: score ?? 0.5,
      provider: this.name,
    };
    const symbol = pickString(obj, ["symbolName", "symbol", "name"]);
    if (symbol !== undefined) candidate.symbolName = symbol;
    const snippet = pickString(obj, ["snippet", "content", "text"]);
    if (snippet !== undefined) candidate.snippet = snippet;
    const start = pickNumber(obj, ["startLine", "start_line", "start"]);
    if (start !== undefined && (!Number.isInteger(start) || start < 1)) {
      throw invalidOutput("ccc candidate start line must be a positive integer");
    }
    if (start !== undefined) candidate.startLine = start;
    const end = pickNumber(obj, ["endLine", "end_line", "end"]);
    if (end !== undefined && (!Number.isInteger(end) || end < 1 || (start !== undefined && end < start))) {
      throw invalidOutput("ccc candidate end line must be a positive integer after start line");
    }
    if (end !== undefined) candidate.endLine = end;
    return candidate;
  }
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function invalidOutput(message: string): CocoIndexProviderError {
  return new CocoIndexProviderError("INVALID_OUTPUT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
