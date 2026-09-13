import { isAbsolute } from "node:path";
import { z } from "zod-v4";
import { explainControlHandoffV2 } from "@semantic-context/app-services/control-continuation";
import {
  ControlContinuationExplainRequestV1Schema,
  type ControlContinuationExplainRequestV1,
  type ControlContinuationExplainResultV1,
} from "@semantic-context/control-model/control-continuation";
import { serializeControlReport } from "@semantic-context/control-model/reconciliation";
import { mcpSchema } from "./schema-boundary";
import type { RepositoryRootResolver } from "./repository-root";
import type { ToolRegistrar } from "./tool-contract";

const MCP_EXPLAIN_REQUEST = mcpSchema(ControlContinuationExplainRequestV1Schema);
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

export function controlHandoffExplainTool(
  root: string,
  request: ControlContinuationExplainRequestV1,
): ControlContinuationExplainResultV1 {
  return explainControlHandoffV2(root, request);
}

export function registerControlContinuationTools(
  tools: ToolRegistrar,
  rootResolver: RepositoryRootResolver,
): void {
  tools.registerTool(
    "semctx_control_handoff_explain",
    {
      title: "Explain a Control Handoff v2 capsule",
      description:
        "Read-only, ephemeral explanation of one intact Control Handoff v2 capsule: its historical planning context plus dependency-by-dependency current applicability. Never mutates the capsule, never indexes or records anything, and grants no execution authority.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      strictInput: true,
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        request: MCP_EXPLAIN_REQUEST,
      },
    },
    ({ repositoryRoot, request }) => canonical(controlHandoffExplainTool(
      rootResolver.resolve(repositoryRoot),
      request as ControlContinuationExplainRequestV1,
    )),
  );
}

function canonical(value: unknown): TextResult {
  return { content: [{ type: "text", text: serializeControlReport(value) }] };
}
