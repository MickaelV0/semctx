/**
 * OMP extension adapter for the ADR 0007 terminal-Git guard.
 *
 * Declared once via `package.json#omp.extensions`, outside the conventionally scanned
 * `hooks/pre`/`hooks/post` extension surfaces, so this stays one policy shared with Claude Code's
 * `PreToolUse` hook rather than a forked copy. Both hosts call the same `evaluateGuard` in
 * `../hooks/semctx-guard.mjs`; only the input mapping (bash tool_call event -> command/cwd/env) is
 * host-specific. Advisory/off stays non-blocking here exactly as it does for Claude; a failed
 * evaluation (missing/stale proof, non-isolated command, scope escape) blocks the same way. Every
 * non-Bash tool call and every non-terminal Bash command is left untouched (returns `undefined`,
 * never `{ block: true }`), matching the "disabled/advisory and unrelated tools remain
 * non-blocking" and "an evaluation failure must not become authorization" invariants.
 *
 * Local structural types only (no import from an OMP package): this file must typecheck inside
 * the semctx monorepo, which does not depend on Oh My Pi's own types.
 */
import {
  evaluateGuard,
  guardEnabledForInvocation,
  isTerminalGitCommand,
} from "../hooks/semctx-guard.mjs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

interface ToolCallEventLike {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ExtensionContextLike {
  cwd: string;
}

interface ToolCallEventResultLike {
  block?: boolean;
  reason?: string;
}

interface ExtensionAPILike {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEventLike,
      ctx: ExtensionContextLike,
    ) => ToolCallEventResultLike | undefined,
  ): void;
}

type GuardEvaluator = typeof evaluateGuard;
type GuardEnablementEvaluator = typeof guardEnabledForInvocation;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const INTERNAL_URL = /^(?:agent|artifact|history|issue|local|mcp|memory|omp|pr|rule|security|skill|ssh|vault):\/\//i;
const AT_PREFIX_INTERNAL_URL = /^(?:agent|artifact|local|mcp|rule|security|skill):\/\//i;

interface OmpPathResolutionOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

export type OmpFilesystemCwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; reason: string };

function stripWindowsExtendedPrefix(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  const unc = /^\\\\[?](?:\\|\/)UNC(?:\\|\/)([^\\/]+)[\\/](.+)$/i.exec(value)
    ?? /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i.exec(value);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  const drive = /^\\\\[?](?:\\|\/)([A-Za-z]:[\\/].*)$/.exec(value)
    ?? /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/.exec(value);
  if (drive) return drive[1]!;
  const forwardUnc = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i.exec(value);
  if (forwardUnc) return `//${forwardUnc[1]}/${forwardUnc[2]}`;
  return /^\/\/[?]\/([A-Za-z]:\/.*)$/.exec(value)?.[1] ?? value;
}

function normalizeAtPrefix(value: string): string {
  if (!value.startsWith("@")) return value;
  const candidate = value.slice(1);
  if (
    candidate.startsWith("/")
    || candidate === "~"
    || candidate.startsWith("~/")
    || win32.isAbsolute(candidate)
    || AT_PREFIX_INTERNAL_URL.test(candidate.replace(/^(local:)\/(?!\/)/i, "$1//"))
  ) return candidate;
  return value;
}

function windowsDriveAlias(value: string): string | undefined {
  const match = /^\/(?:mnt\/)?([A-Za-z])(?:\/(.*))?$/.exec(value);
  if (!match) return undefined;
  const tail = match[2]?.split("/").filter(Boolean).join("\\");
  return `${match[1]!.toUpperCase()}:\\${tail ?? ""}`;
}

function windowsPathToWsl(value: string): string | undefined {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(win32.normalize(value.trim()));
  if (!match) return undefined;
  return posix.join("/mnt", match[1]!.toLowerCase(), ...match[2]!.split("\\").filter(Boolean));
}

function expandOmpFilesystemPath(raw: string, options: Required<OmpPathResolutionOptions>): string {
  const deColoned = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(raw) ? raw.slice(1) : raw;
  const atNormalized = normalizeAtPrefix(deColoned).replace(UNICODE_SPACES, " ");
  let value = atNormalized;
  if (value.toLowerCase().startsWith("file://")) {
    try {
      value = fileURLToPath(value, { windows: options.platform === "win32" });
    } catch { /* Preserve OMP's unresolved literal fallback. */ }
  }
  value = stripWindowsExtendedPrefix(value, options.platform);
  if (value === "~") value = options.home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = options.home + value.slice(1);
  else if (value.startsWith("~")) {
    value = (options.platform === "win32" ? win32 : posix).join(options.home, value.slice(1));
  }
  if (options.platform === "win32") return windowsDriveAlias(value) ?? value;
  if (options.platform === "linux" && (options.env.WSL_DISTRO_NAME || options.env.WSL_INTEROP)) {
    return windowsPathToWsl(value) ?? value;
  }
  return value;
}

/** Filesystem-only subset of OMP 18.1.11 expandPath + resolveToCwd. */
export function resolveOmpFilesystemCwd(
  rawCwd: string,
  sessionCwd: string,
  options: OmpPathResolutionOptions = {},
): OmpFilesystemCwdResolution {
  const normalizedOptions = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
  };
  const expanded = expandOmpFilesystemPath(rawCwd.replace(/^(local:)\/(?!\/)/i, "$1//"), normalizedOptions);
  if (INTERNAL_URL.test(expanded.replace(/^(local:)\/(?!\/)/i, "$1//"))) {
    return { ok: false, reason: `OMP did not expand internal URL cwd ${JSON.stringify(rawCwd)} to a filesystem path` };
  }
  if (/^\/+$/u.test(expanded)) return { ok: true, cwd: sessionCwd };
  const pathApi = normalizedOptions.platform === "win32" ? win32 : posix;
  return { ok: true, cwd: pathApi.isAbsolute(expanded) ? expanded : pathApi.resolve(sessionCwd, expanded) };
}

export function explicitGuardOff(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return Object.entries(env).some(([name, value]) => (
    (platform === "win32" ? name.toLowerCase() === "semctx_guard" : name === "SEMCTX_GUARD")
    && ["off", "0", "false"].includes(String(value).toLowerCase())
  ));
}

function unresolvedInternalGitScope(command: string): string | undefined {
  const scopeTokens = [
    /(?:^|[;&|\n])\s*(?:cd|chdir|pushd)\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/gi,
    /(?:^|\s)-C(?:=|\s*)?("[^"]*"|'[^']*'|[^\s;&|]+)/g,
    /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi,
  ];
  for (const pattern of scopeTokens) {
    for (const match of command.matchAll(pattern)) {
      const token = (match[1] ?? "").replace(/^["']|["']$/g, "");
      const normalized = normalizeAtPrefix(token).replace(/^(local:)\/(?!\/)/i, "$1//");
      if (INTERNAL_URL.test(normalized)) return token;
    }
  }
  return undefined;
}

function resolveOmpFilesystemSessionRoot(rawCwd: string): OmpFilesystemCwdResolution {
  const options = {
    platform: process.platform,
    env: process.env,
    home: homedir(),
  };
  const expanded = expandOmpFilesystemPath(rawCwd.replace(/^(local:)\/(?!\/)/i, "$1//"), options);
  if (INTERNAL_URL.test(expanded.replace(/^(local:)\/(?!\/)/i, "$1//"))) {
    return { ok: false, reason: `OMP session cwd ${JSON.stringify(rawCwd)} is still an internal URL` };
  }
  const pathApi = options.platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(expanded)) {
    return { ok: false, reason: `OMP session cwd ${JSON.stringify(rawCwd)} is not an absolute filesystem path` };
  }
  try {
    if (!statSync(expanded).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, reason: `OMP session cwd ${JSON.stringify(rawCwd)} is not an accessible filesystem directory` };
  }
  return { ok: true, cwd: expanded };
}

function evaluateUnresolvedScopeEnablement(
  ctx: ExtensionContextLike,
  env: Record<string, string | undefined>,
  enablementEvaluator: GuardEnablementEvaluator,
  unresolvedReason: string,
): ToolCallEventResultLike | undefined {
  const sessionRoot = resolveOmpFilesystemSessionRoot(ctx.cwd);
  if (!sessionRoot.ok) {
    return {
      block: true,
      reason: `semctx guarded mode: ${sessionRoot.reason}; guard enablement cannot be established, so the terminal Git operation is not authorized.`,
    };
  }
  try {
    const enabled = enablementEvaluator({
      command: "git commit",
      cwd: sessionRoot.cwd,
      sessionCwd: sessionRoot.cwd,
      env,
    });
    if (enabled === false) return undefined;
    if (enabled !== true) {
      return {
        block: true,
        reason: "semctx guarded mode: guard enablement evaluation returned an unknown result; terminal Git operation is not authorized.",
      };
    }
  } catch {
    return {
      block: true,
      reason: "semctx guarded mode: guard enablement evaluation failed; terminal Git operation is not authorized.",
    };
  }
  return { block: true, reason: `semctx guarded mode: ${unresolvedReason}; terminal Git operation is not authorized.` };
}

export function mergeOmpEnvironment(
  ambient: Record<string, string | undefined>,
  overlay: Record<string, string>,
  caseInsensitive = process.platform === "win32",
): Record<string, string | undefined> {
  const merged = { ...ambient };
  for (const [name, value] of Object.entries(overlay)) {
    if (caseInsensitive) {
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
      }
    }
    merged[name] = value;
  }
  return merged;
}

export function evaluateOmpToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  evaluator: GuardEvaluator = evaluateGuard,
  enablementEvaluator: GuardEnablementEvaluator = guardEnabledForInvocation,
): ToolCallEventResultLike | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = typeof event.input.command === "string" ? event.input.command : "";
  if (!isTerminalGitCommand(command)) return undefined;
  const callEnv = event.input.env;
  const structuredEnv = callEnv !== null && typeof callEnv === "object" && !Array.isArray(callEnv)
    ? Object.fromEntries(Object.entries(callEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const env = mergeOmpEnvironment(process.env, structuredEnv);
  if (explicitGuardOff(env)) return undefined;
  const rawCwd = typeof event.input.cwd === "string" ? event.input.cwd : ctx.cwd;
  const resolvedCwd = resolveOmpFilesystemCwd(rawCwd, ctx.cwd);
  if (!resolvedCwd.ok) {
    return evaluateUnresolvedScopeEnablement(
      ctx,
      env,
      enablementEvaluator,
      resolvedCwd.reason,
    );
  }
  const unresolvedScope = unresolvedInternalGitScope(command);
  if (unresolvedScope !== undefined) {
    return evaluateUnresolvedScopeEnablement(
      ctx,
      env,
      enablementEvaluator,
      `OMP did not expand internal URL Git scope ${JSON.stringify(unresolvedScope)} to a filesystem path`,
    );
  }
  const input = {
    command,
    cwd: resolvedCwd.cwd,
    sessionCwd: ctx.cwd,
    env,
    overriddenEnvKeys: Object.keys(structuredEnv),
  };
  try {
    const decision = evaluator(input) as ToolCallEventResultLike;
    return decision.block ? { block: true, reason: decision.reason } : undefined;
  } catch {
    try {
      if (!enablementEvaluator(input)) return undefined;
    } catch {
      // If enablement itself cannot be evaluated, only the explicit off switch can authorize.
      if (explicitGuardOff(env)) return undefined;
    }
    return {
      block: true,
      reason: "semctx guarded mode: guard evaluation failed; terminal Git operation is not authorized.",
    };
  }
}

export default function semctxGuardExtension(api: ExtensionAPILike): void {
  api.on("tool_call", (event, ctx) => {
    return evaluateOmpToolCall(event, ctx);
  });
}
