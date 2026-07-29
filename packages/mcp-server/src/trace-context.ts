import {
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";

export interface RequestTrace {
  traceparent?: string;
  tracestate?: string;
}

const TRACEPARENT_PATTERN =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACESTATE_SIMPLE_KEY_PATTERN = /^[a-z][a-z0-9_*/-]{0,255}$/;
const TRACESTATE_TENANT_KEY_PATTERN =
  /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/;
const TRACESTATE_VALUE_PATTERN =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

function validTraceparent(value: unknown): string | undefined {
  return typeof value === "string" && TRACEPARENT_PATTERN.test(value)
    ? value
    : undefined;
}

function validTracestate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }
  const members = value.split(",");
  if (members.length > 32) return undefined;

  const keys = new Set<string>();
  for (const rawMember of members) {
    const member = rawMember.replace(/^[ \t]+|[ \t]+$/g, "");
    const separator = member.indexOf("=");
    if (separator <= 0 || separator !== member.lastIndexOf("=")) {
      return undefined;
    }

    const key = member.slice(0, separator).replace(/[ \t]+$/g, "");
    const memberValue = member.slice(separator + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    const validKey =
      TRACESTATE_SIMPLE_KEY_PATTERN.test(key)
      || TRACESTATE_TENANT_KEY_PATTERN.test(key);
    if (
      !validKey
      || !TRACESTATE_VALUE_PATTERN.test(memberValue)
      || keys.has(key)
    ) {
      return undefined;
    }
    keys.add(key);
  }

  return value;
}

/** Extract only validated W3C trace correlation fields; baggage is intentionally ignored. */
export function requestTrace(ctx: ServerContext): RequestTrace {
  const metadata = ctx.mcpReq._meta;
  const traceparent = validTraceparent(metadata?.[TRACEPARENT_META_KEY]);
  const tracestate = validTracestate(metadata?.[TRACESTATE_META_KEY]);
  return {
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}
