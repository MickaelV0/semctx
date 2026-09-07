import {
  OBSERVE_EVENT,
  REPORT_EVENT,
  normalizeHookEnvelope,
  processLifecycleEnvelope,
} from "../semctx-lifecycle.mjs";

/**
 * Oh My Pi does not load `hooks/hooks.json` (ADR 0015). This factory is the in-process equivalent
 * of Claude/Codex PostToolUse + Stop: observe Semctx MCP tools, then emit the shadow
 * `before_completion` advisory on stderr at end of turn.
 *
 * Measured tool names on this host are `mcp__semctx_semctx_<canonical>` (plugin `semctx` + server
 * `semctx`, 38/38 tools). Observation is source-non-collecting: only the tool name, session id and
 * cwd are forwarded. Handlers never return `{ block: true }` and never throw out of the adapter.
 */

type LifecycleCtx = {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
};

type PiApi = {
  on(event: string, handler: (event: { toolName?: string }, ctx: LifecycleCtx) => Promise<unknown>): void;
};

function dispatch(eventName: string, ctx: LifecycleCtx, toolName?: string): void {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    const envelope = normalizeHookEnvelope({
      hook_event_name: eventName,
      session_id: typeof id === "string" && id.length > 0 ? id : null,
      cwd: typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : null,
      tool_name: toolName,
    });
    processLifecycleEnvelope(envelope);
  } catch {
    // Advisory only: a throw from this handler must never fail a tool or a turn.
  }
}

/** @param pi Oh My Pi extension API */
export default function semctxLifecycle(pi: PiApi) {
  pi.on("tool_result", async (event, ctx) => {
    dispatch(OBSERVE_EVENT, ctx, event?.toolName);
  });
  pi.on("turn_end", async (_event, ctx) => {
    dispatch(REPORT_EVENT, ctx);
  });
}
