// defineTool: ties a validator shape, a description and a run function into one ToolDef.
import { errorResult, type McpContext, type ToolDef, type ToolResult } from "./types.js";
import { object, type Infer, type Shape } from "./validate.js";

export interface ToolSpec<S extends Shape> {
  readonly name: string;
  readonly description: string;
  readonly shape: S;
  /** Runs only with validated arguments. */
  readonly run: (ctx: McpContext, args: Infer<S>) => Promise<ToolResult>;
}

export function defineTool<S extends Shape>(spec: ToolSpec<S>): ToolDef {
  const schema = object(spec.shape);
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: schema.jsonSchema(),
    async call(ctx, args) {
      const parsed = schema.parse(args);
      // A rejected call sends nothing to the server.
      if (!parsed.ok) return errorResult(`Invalid arguments for ${spec.name}: ${parsed.error}`);
      return spec.run(ctx, parsed.value);
    },
  };
}
