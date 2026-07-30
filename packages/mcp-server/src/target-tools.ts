/** MCP transport for immutable, non-authorizing target proposals. */

import { isAbsolute } from "node:path";
import { z } from "zod-v4";
import {
  ProposeTargetArchitectureCommandV1Schema,
  proposeTargetArchitecture,
  type ProposeTargetArchitectureCommandV1,
  type TargetArchitectureProposalResultV1,
} from "@semantic-context/app-services";
import { serializeControlReport } from "@semantic-context/control-model";
import { mcpSchema } from "./schema-boundary";
import type { RepositoryRootResolver } from "./repository-root";
import type { ToolRegistrar } from "./tool-contract";

const MCP_PROPOSE_TARGET_ARCHITECTURE_COMMAND_V1 = mcpSchema(
  ProposeTargetArchitectureCommandV1Schema,
);
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

export function controlTargetProposeTool(
  root: string,
  command: ProposeTargetArchitectureCommandV1,
): TargetArchitectureProposalResultV1 {
  return proposeTargetArchitecture(root, command);
}

export function registerTargetTools(
  tools: ToolRegistrar,
  rootResolver: RepositoryRootResolver,
): void {
  tools.registerTool(
    "semctx_control_target_propose",
    {
      title: "Propose a target architecture",
      description:
        "Creates one immutable, agent-authored Plane-B target proposal bound to the current FRESH commit and graph seal. "
        + "The proposal remains hypothetical and non-certifying; it does not accept the target or grant execution authority.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        command: MCP_PROPOSE_TARGET_ARCHITECTURE_COMMAND_V1,
      },
    },
    ({ repositoryRoot, command }) => canonical(controlTargetProposeTool(
      rootResolver.resolve(repositoryRoot),
      command as ProposeTargetArchitectureCommandV1,
    )),
  );
}

function canonical(value: unknown): TextResult {
  return { content: [{ type: "text", text: serializeControlReport(value) }] };
}
