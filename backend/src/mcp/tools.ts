// The tool catalog (fixed order) and the registry the HTTP handler calls.
import { exorciseTool, grantOpTool, sayTool, summonTool, whoisTool } from "./act-tools.js";
import { createGuardedRegistry, type RegistryOptions } from "./invoke.js";
import { creditsTool, listChannelsTool, readTool } from "./read-tools.js";
import type { McpContext, ToolDef, ToolRegistry } from "./types.js";

/** The eight tools, in the order tools/list returns them. */
export const TOOLS: readonly ToolDef[] = [listChannelsTool, readTool, sayTool, summonTool, grantOpTool, exorciseTool, whoisTool, creditsTool];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** The registry the HTTP handler calls: the catalog behind the concurrency cap and the central error mapping. */
export function createToolRegistry(ctx: McpContext, tools: readonly ToolDef[] = TOOLS, options: RegistryOptions = {}): ToolRegistry {
  return createGuardedRegistry(ctx, tools, options);
}
