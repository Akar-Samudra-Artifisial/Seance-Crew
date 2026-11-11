// Central guard around every tool call: concurrency cap and error mapping (Req 7.2, 7.4).
import { errorResult, type McpContext, type ToolDef, type ToolInfo, type ToolRegistry } from "./types.js";

export const MAX_CONCURRENT_CALLS = 8;
export const BUSY_MESSAGE = `busy: ${MAX_CONCURRENT_CALLS} tool calls are already running. Try again in a moment.`;
export const INTERNAL_ERROR_MESSAGE = "internal error: the tool failed unexpectedly. Details are in the app log.";

export interface RegistryOptions {
  readonly maxConcurrent?: number;
}

export function createGuardedRegistry(ctx: McpContext, tools: readonly ToolDef[], options: RegistryOptions = {}): ToolRegistry {
  const limit = options.maxConcurrent ?? MAX_CONCURRENT_CALLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const info: readonly ToolInfo[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  let running = 0;
  return {
    list: () => info,
    call: (name, args) => {
      const tool = byName.get(name);
      if (tool === undefined) return undefined;
      if (running >= limit) return Promise.resolve(errorResult(BUSY_MESSAGE));
      running += 1;
      const run = async () => {
        try {
          return await tool.call(ctx, args);
        } catch (err) {
          // No stack and no error text in the result; the logger redacts the secret and token in what it writes.
          ctx.logger.error("tool call failed", { tool: name, error: err });
          return errorResult(INTERNAL_ERROR_MESSAGE);
        } finally {
          running -= 1;
        }
      };
      return run();
    },
  };
}
