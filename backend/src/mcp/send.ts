// Shared pieces of the tools that send lines: the registered-state check and LineError mapping.
import { LineError } from "../irc/line.js";
import type { Priority } from "../irc/queue.js";
import { errorResult, type McpContext, type ToolResult } from "./types.js";

/** An isError result when the bridge cannot send, otherwise null. Nothing has been sent when this returns a result. */
export function requireRegistered(ctx: McpContext): ToolResult | null {
  if (ctx.bridge.state === "registered") return null;
  return errorResult(`The bridge is ${ctx.bridge.state}, not registered, so nothing can be sent right now. Check the dashboard or the app config.`);
}

/** Map a LineError to an isError result with its stable code. */
export function lineErrorResult(err: LineError): ToolResult {
  const hint = err.code === "queue-full" ? " Wait a moment and try again." : "";
  return errorResult(`Could not send (${err.code}): ${err.message}.${hint}`);
}

/**
 * Send one validated line through the bridge queue. Returns an isError result on a LineError (nothing was sent),
 * null on success. Other errors propagate to the central handler.
 */
export function trySend(ctx: McpContext, command: string, params: readonly string[], priority: Priority = "normal"): ToolResult | null {
  try {
    ctx.bridge.send(command, params, { priority });
    return null;
  } catch (err) {
    if (err instanceof LineError) return lineErrorResult(err);
    throw err;
  }
}
