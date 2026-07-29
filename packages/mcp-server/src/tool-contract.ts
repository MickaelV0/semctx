import {
  type CallToolResult,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import { TOOL_OUTPUT_SCHEMAS } from "./tool-output-schemas";
import { requestTrace, type RequestTrace } from "./trace-context";

const TOOL_NAMES = [
  "semctx_verify_change",
  "semctx_inspect",
  "semctx_prepare_task",
  "semctx_semantic_check",
  "semctx_semantic_slice",
  "semctx_change_open",
  "semctx_change_update",
  "semctx_change_verify",
  "semctx_change_close",
  "semctx_semantic_inspect",
  "semctx_handoff",
  "semctx_resume",
  "semctx_control_status",
  "semctx_control_authority",
  "semctx_control_trace",
  "semctx_control_graph",
  "semctx_control_traversal",
  "semctx_control_refinement_coverage",
  "semctx_control_impact",
  "semctx_control_explain_why",
  "semctx_control_compare_architecture",
  "control_authorize_transition",
  "control_authorize_step",
  "control_authorize_deletion",
  "semctx_control_plan",
  "semctx_control_bind_scope",
  "semctx_control_frame_task",
  "semctx_control_plan_change",
  "semctx_control_reconcile_diff",
  "semctx_control_target_propose",
  "semctx_control_explorer",
] as const;

export type SemctxToolName = (typeof TOOL_NAMES)[number];

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const WRITER_NAMES = new Set<SemctxToolName>([
  "semctx_prepare_task",
  "semctx_change_open",
  "semctx_change_update",
  "semctx_change_close",
  "semctx_handoff",
  "semctx_control_target_propose",
]);

const TOOL_EFFECTS = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, WRITER_NAMES.has(name) ? WRITER : READ_ONLY]),
) as Record<SemctxToolName, ToolAnnotations>;

type ToolResult = CallToolResult & {
  isError?: boolean;
  structuredContent?: unknown;
};

type ToolConfig<InputArgs extends z.ZodRawShape> = {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  icons?: Array<Record<string, unknown>>;
  _meta?: Record<string, unknown>;
};

type ToolCallback<InputArgs extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<InputArgs>>,
  ctx: ServerContext,
) => ToolResult | Promise<ToolResult>;

function outputValidationError(
  name: SemctxToolName,
  issues: ReadonlyArray<{ path?: PropertyKey[]; message?: string }>,
): Error {
  const details = issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path?.length ? issue.path.map(String).join(".") : "<root>";
      return `${path}: ${issue.message ?? "invalid value"}`;
    })
    .join("; ");
  return new Error(
    `${name} produced output that does not match its public schema`
      + (details ? ` (${details})` : ""),
  );
}

function withStructuredContent(
  name: SemctxToolName,
  outputSchema: z.ZodType,
  result: ToolResult,
): ToolResult {
  if (result.isError === true) {
    return result;
  }

  const text = result.content.find((item) => item.type === "text");
  let structuredContent = result.structuredContent;

  if (text?.type === "text") {
    try {
      structuredContent = JSON.parse(text.text);
    } catch {
      throw new Error(`${name} produced a successful result without valid JSON text`);
    }
  } else if (structuredContent === undefined) {
    throw new Error(`${name} produced a successful result without structured content`);
  }

  const validation = outputSchema.safeParse(structuredContent);
  if (!validation.success) {
    throw outputValidationError(name, validation.error.issues);
  }

  return { ...result, structuredContent };
}

export interface ToolRegistrarOptions {
  onRequestContext?: (trace: RequestTrace) => void;
}

/** One registration boundary for metadata, effects, tracing, and structured results. */
export class ToolRegistrar {
  constructor(
    private readonly server: McpServer,
    private readonly options: ToolRegistrarOptions = {},
  ) {}

  registerTool<InputArgs extends z.ZodRawShape>(
    name: SemctxToolName,
    config: ToolConfig<InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const outputSchema = config.outputSchema ?? TOOL_OUTPUT_SCHEMAS[name];
    const configuredUi =
      typeof config._meta?.["ui"] === "object" && config._meta["ui"] !== null
        ? config._meta["ui"] as Record<string, unknown>
        : {};
    const registerTool = this.server.registerTool.bind(this.server) as unknown as (
      toolName: string,
      toolConfig: Record<string, unknown>,
      toolCallback: (args: unknown, ctx: ServerContext) => Promise<ToolResult>,
    ) => RegisteredTool;

    return registerTool(
      name,
      {
        ...config,
        outputSchema,
        annotations: TOOL_EFFECTS[name],
        _meta: {
          ...config._meta,
          ui: {
            ...configuredUi,
            visibility: configuredUi["visibility"] ?? ["model"],
          },
        },
      },
      async (args, ctx) => {
        this.options.onRequestContext?.(requestTrace(ctx));
        return withStructuredContent(
          name,
          outputSchema,
          await callback(args as z.infer<z.ZodObject<InputArgs>>, ctx),
        );
      },
    );
  }
}
