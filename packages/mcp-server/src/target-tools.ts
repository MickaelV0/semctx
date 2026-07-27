/** MCP transport for immutable, non-authorizing target proposals. */

import { isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ProposeTargetArchitectureCommandV1Schema,
  proposeTargetArchitecture,
  type ProposeTargetArchitectureCommandV1,
  type TargetArchitectureProposalResultV1,
} from "@semantic-context/app-services";
import { serializeControlReport } from "@semantic-context/control-model";

const REPOSITORY_ROOT = z.string().min(1).refine(
  isAbsolute,
  "repositoryRoot must be absolute",
).describe(
  "absolute repository root; required on every call so plugin-cache launch directories cannot become implicit targets",
);

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function controlTargetProposeTool(
  root: string,
  command: ProposeTargetArchitectureCommandV1,
): TargetArchitectureProposalResultV1 {
  return proposeTargetArchitecture(root, command);
}

export function registerTargetTools(
  server: McpServer,
  boundRoot: string,
): void {
  server.registerTool(
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
        command: ProposeTargetArchitectureCommandV1Schema,
      },
    },
    async ({ repositoryRoot, command }) => {
      try {
        return canonical(controlTargetProposeTool(
          requestRoot(boundRoot, repositoryRoot),
          command as ProposeTargetArchitectureCommandV1,
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function requestRoot(_boundRoot: string, repositoryRoot: string): string {
  return resolve(repositoryRoot);
}

function canonical(value: unknown): TextResult {
  return { content: [{ type: "text", text: serializeControlReport(value) }] };
}

function errorResult(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
