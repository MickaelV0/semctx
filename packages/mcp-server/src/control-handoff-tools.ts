import { isAbsolute } from "node:path";
import { z } from "zod-v4";
import {
  captureControlHandoffV2,
  resumeControlHandoffV2,
} from "@semantic-context/app-services/control-handoff";
import {
  ControlHandoffCaptureRequestV2Schema,
  ControlHandoffResumeRequestV2Schema,
  type ControlHandoffCaptureRequestV2,
  type ControlHandoffCaptureResultV2,
  type ControlHandoffResumeRequestV2,
  type ControlHandoffResumeResultV2,
} from "@semantic-context/control-model/control-handoff";
import { serializeControlReport } from "@semantic-context/control-model/reconciliation";
import { mcpSchema } from "./schema-boundary";
import type { RepositoryRootResolver } from "./repository-root";
import type { ToolRegistrar } from "./tool-contract";

const MCP_CAPTURE_REQUEST = mcpSchema(ControlHandoffCaptureRequestV2Schema);
const MCP_RESUME_REQUEST = mcpSchema(ControlHandoffResumeRequestV2Schema);
const REPOSITORY_ROOT = z.string().min(1).refine(
  isAbsolute,
  "repositoryRoot must be absolute",
).describe(
  "absolute repository root; required on every call so plugin-cache launch directories cannot become implicit targets",
);

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export function controlHandoffTool(
  root: string,
  request: ControlHandoffCaptureRequestV2,
): ControlHandoffCaptureResultV2 {
  return captureControlHandoffV2(root, request);
}

export function controlResumeHandoffTool(
  root: string,
  request: ControlHandoffResumeRequestV2,
): ControlHandoffResumeResultV2 {
  return resumeControlHandoffV2(root, request);
}

export function registerControlHandoffTools(
  tools: ToolRegistrar,
  rootResolver: RepositoryRootResolver,
): void {
  tools.registerTool(
    "semctx_control_handoff",
    {
      title: "Capture a Control Handoff v2 capsule",
      description:
        "Capture one deterministic, proof-bound Control Handoff v2 capsule in ignored repository working state. The shared application service derives and validates all repository observations; the transport grants no execution authority.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      strictInput: true,
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        request: MCP_CAPTURE_REQUEST,
      },
    },
    ({ repositoryRoot, request }) => canonical(controlHandoffTool(
      rootResolver.resolve(repositoryRoot),
      request as ControlHandoffCaptureRequestV2,
    )),
  );

  tools.registerTool(
    "semctx_control_resume",
    {
      title: "Resume an exact Control Handoff v2 capsule",
      description:
        "Read and revalidate exactly one Control Handoff v2 capsule by canonical hash. Stale or mismatched state propagates as a null capsule; the transport never repairs, upgrades, or reinterprets the shared result.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      strictInput: true,
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        request: MCP_RESUME_REQUEST,
      },
    },
    ({ repositoryRoot, request }) => canonical(controlResumeHandoffTool(
      rootResolver.resolve(repositoryRoot),
      request as ControlHandoffResumeRequestV2,
    )),
  );
}

function canonical(value: unknown): TextResult {
  return { content: [{ type: "text", text: serializeControlReport(value) }] };
}
