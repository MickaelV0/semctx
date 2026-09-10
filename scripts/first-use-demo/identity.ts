/** Artifact and fixture identity: what was actually run, digested from real bytes only. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FileIdentity {
  path: string;
  present: boolean;
  sizeBytes: number | null;
  sha256: string | null;
}

/** Digest a file's real bytes, or record its absence. Never fabricates a digest for a missing file. */
export function identifyFile(path: string): FileIdentity {
  if (!existsSync(path)) return { path, present: false, sizeBytes: null, sha256: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Linked runtime artifacts are not supported");
  if (!stat.isFile()) return { path, present: false, sizeBytes: null, sha256: null };
  const bytes = readFileSync(path);
  return { path, present: true, sizeBytes: stat.size, sha256: sha256Hex(bytes) };
}

export interface PackagedCliIdentity {
  /** The exact path the caller supplied. Never resolved against a global/PATH install. */
  cliPath: string;
  cli: FileIdentity;
  /** The colocated index worker bundle, when the packaged build ships one. */
  indexWorker: FileIdentity | null;
  /** Available build/source provenance for the CLI artifact. UNKNOWN unless the caller proved one. */
  sourceProvenance: string;
  authenticatedSource: "UNKNOWN";
  runtimeFiles: FileIdentity[];
  runtimeDigest: string | null;
}

/**
 * Identify the packaged CLI artifact the caller explicitly selected. `sourceProvenance` stays
 * `UNKNOWN` unless the caller supplies one: a caller-supplied string is never treated as a verified
 * build binding (ADR 0018), only as a label carried into the manifest.
 */
export function identifyPackagedCli(cliPath: string, sourceProvenance?: string): PackagedCliIdentity {
  const cli = identifyFile(cliPath);
  const workerPath = join(dirname(cliPath), "semctx-index-worker.js");
  const indexWorker = existsSync(workerPath) ? identifyFile(workerPath) : null;
  const root = dirname(cliPath);
  const runtimeFiles: FileIdentity[] = [];
  function visit(directory: string): void {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Linked runtime directories are not supported");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Linked runtime artifacts are not supported");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) runtimeFiles.push({ ...identifyFile(path), path: relative(root, path).replaceAll("\\", "/") });
      else throw new Error("Unsupported runtime file type");
    }
  }
  if (cli.present) visit(root);
  return {
    cliPath,
    cli,
    indexWorker,
    authenticatedSource: "UNKNOWN",
    runtimeFiles,
    runtimeDigest: cli.present ? sha256Hex(JSON.stringify(runtimeFiles)) : null,
    sourceProvenance: sourceProvenance !== undefined && sourceProvenance.trim().length > 0
      ? sourceProvenance
      : "UNKNOWN",
  };
}

export interface FixtureIdentity {
  /** sha256 over every base file's relative path and content, sorted and joined deterministically. */
  baseDigest: string;
  /** sha256 over every changed file's relative path and content, sorted and joined deterministically. */
  changedDigest: string;
}

function digestFileSet(files: ReadonlyMap<string, string>): string {
  const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const joined = entries.map(([relPath, content]) => `${relPath}\u0000${content}`).join("\u0001");
  return sha256Hex(joined);
}

export function identifyFixture(
  baseFiles: ReadonlyMap<string, string>,
  changedFiles: ReadonlyMap<string, string>,
): FixtureIdentity {
  return { baseDigest: digestFileSet(baseFiles), changedDigest: digestFileSet(changedFiles) };
}
