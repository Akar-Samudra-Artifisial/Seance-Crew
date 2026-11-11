// Shared types of the MCP layer. Tools depend on McpContext only, so tests can run them against the fake ircd.
import type { Clock } from "../clock.js";
import type { SendOptions } from "../irc/client.js";
import type { BridgeState, Store } from "../irc/store.js";
import type { Logger } from "../log.js";
import type { JsonSchema } from "./validate.js";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolResult {
  /** Human-readable text; channel text inside is wrapped in <untrusted>. */
  readonly content: readonly TextContent[];
  /** Plain data; carries `untrusted: true` when it holds channel text. */
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/** The part of IrcBridge the tools use: its state and the validated, rate-limited send path. */
export interface McpBridge {
  readonly state: BridgeState;
  send(command: string, params: readonly string[], options?: SendOptions): void;
}

/** The latest daily summary (defined by the steward-agent spec). */
export type Summary = Readonly<Record<string, unknown>>;

export interface SummaryProvider {
  latest(): Summary | null;
}

export interface McpContext {
  readonly store: Store;
  readonly bridge: McpBridge;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Provided by steward-agent; absent means "no summary yet". */
  readonly summary?: SummaryProvider;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolDef extends ToolInfo {
  /** Validate `args` and run. Argument errors come back as `isError` results; nothing is sent in that case. */
  call(ctx: McpContext, args: unknown): Promise<ToolResult>;
}

/** What the HTTP handler needs from the tool layer. */
export interface ToolRegistry {
  list(): readonly ToolInfo[];
  /** Undefined when no tool has that name (a JSON-RPC -32602 for the caller). */
  call(name: string, args: unknown): Promise<ToolResult> | undefined;
}

export const textResult = (text: string, structured?: Readonly<Record<string, unknown>>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});

export const errorResult = (text: string, structured?: Readonly<Record<string, unknown>>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
  isError: true,
});
