import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod-v4";

/**
 * Convert a business-layer Zod 3 schema into a Zod 4 schema before exposing it
 * to the MCP v2 SDK. The SDK therefore receives only its supported Standard
 * Schema boundary while the rest of the monorepo can remain on Zod 3.
 */
export function mcpSchema<Output, Input = Output>(
  schema: ZodType<Output, ZodTypeDef, Input>,
): z.ZodType<Output, Input> {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });

  return z.fromJSONSchema(
    jsonSchema as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodType<Output, Input>;
}
