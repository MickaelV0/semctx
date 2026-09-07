import { resolve } from "node:path";
import { evaluateBashGuard, shellQuote, synthesizeHubCommand } from "../semctx-guard.mjs";

/**
 * Oh My Pi emits `tool_call` before the tool runs, so `input` is the raw model argument object:
 * `cwd` is not yet resolved against the session directory and `env` is a structured map the host
 * passes as real child-process environment. Both are normalized here so the guard evaluates the
 * same effective command a shell would have received.
 *
 * Measured tool names: `bash` (lowercase) and `hub` (HubTool.name, no prefix). Hub `op: "start"`
 * carries `application` + `args` as sibling fields of `op` — there is no `command` string.
 * Hub `op: "restart"` carries only `name`; argv comes from the retained launch spec.
 */
type ToolCallEvent = {
  toolName?: string;
  input?: {
    command?: string;
    cwd?: string;
    env?: Record<string, unknown>;
    op?: string;
    application?: string;
    args?: string[];
    name?: string;
  };
};

type ToolCallCtx = { cwd?: string };

type PiApi = {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ToolCallCtx,
    ) => Promise<{ block: true; reason: string } | void>,
  ): void;
};

/**
 * The directory the command will actually run in. `ctx.cwd` is materialized per invocation and
 * follows session moves, so it is the correct anchor for a relative `input.cwd` — resolving against
 * `process.cwd()` would read a different repository whenever the host was launched elsewhere.
 *
 * Hub `op: "start"` accepts the same `cwd` field; Oh My Pi resolves it with `resolveToCwd(params.cwd
 * ?? session.cwd, session.cwd)` (`launch.ts` `commandSpec`). That is the process working directory,
 * equivalent to a bash `cd` prefix, and is handled here rather than inlined into the synthesized
 * command so `resolveGitCwd` stays the single cwd predicate.
 */
function commandCwd(event: ToolCallEvent, ctx: ToolCallCtx): string {
  const base = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  const requested = event?.input?.cwd;
  return typeof requested === "string" && requested ? resolve(base, requested) : base;
}

function baseCommand(event: ToolCallEvent): string {
  const name = String(event?.toolName ?? "").toLowerCase();
  // `op: "restart"` has no argv on the call; synthesizeHubCommand returns null and
  // evaluateBashGuard resolves `input.name` against the retained spec.
  if (name === "hub") return synthesizeHubCommand(event?.input) ?? "";
  return typeof event?.input?.command === "string" ? event.input.command : "";
}

/**
 * Structured `env` entries are invisible in the command string, so a `GIT_DIR=…` retargeting sent
 * as `env` would escape the checks its inline `NAME=value` equivalent fails. Prepending the
 * assignments reuses the existing detectors instead of adding a second policy. Hub `start` has the
 * same `env` map (`LaunchParams.env`).
 */
function effectiveCommand(event: ToolCallEvent): string {
  const command = baseCommand(event);
  const env = event?.input?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return command;
  const assignments = Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${shellQuote(String(value))}`)
    .join(" ");
  if (!assignments) return command;
  return command ? `${assignments} ${command}` : assignments;
}

/** @param pi Oh My Pi extension API */
export default function semctxGuard(pi: PiApi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const decision = evaluateBashGuard({
        toolName: event?.toolName,
        command: effectiveCommand(event),
        cwd: commandCwd(event, ctx),
        env: process.env,
        op: typeof event?.input?.op === "string" ? event.input.op : undefined,
        application: typeof event?.input?.application === "string" ? event.input.application : undefined,
        args: Array.isArray(event?.input?.args) ? event.input.args.map(String) : undefined,
        name: typeof event?.input?.name === "string" ? event.input.name : undefined,
      });
      if (decision.block) {
        return { block: true, reason: decision.reason };
      }
    } catch {
      // A throw here would block every bash/hub call, so an internal guard failure allows the tool.
    }
  });
}
