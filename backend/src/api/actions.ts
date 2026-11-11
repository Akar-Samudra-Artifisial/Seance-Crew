// The four POST actions of the dashboard. They validate with the same field validators as the MCP tools and then run
// the MCP tools themselves through the shared registry, so the rate limits, per-channel locks, waiters and the
// `confirm` rule are one implementation for both surfaces.
import type { Store } from "../irc/store.js";
import type { ToolRegistry, ToolResult } from "../mcp/types.js";
import { channel, confirmFlag, enumOf, nick, object, optional, string, type Infer, type ObjectSchema, type Shape } from "../mcp/validate.js";

export interface ApiOutcome {
  readonly status: number;
  readonly body: unknown;
}

export interface ActionDeps {
  readonly store: Store;
  readonly registry: ToolRegistry;
}

const fail = (status: number, code: string, message: string): ApiOutcome => ({ status, body: { error: { code, message } } });

export const CONFIRM_REQUIRED_MESSAGE = "confirm: true is required. Nothing was sent.";

const MODES = ["+v", "-v", "+o", "-o"] as const;
const itemId = () => string({ min: 1, max: 64, description: "Inbox item id" });

const summonShape = { channel: channel(), agent: optional(nick("Agent nick, default coder")) } satisfies Shape;
const grantShape = {
  channel: channel(),
  agent: nick("Nick of the agent"),
  mode: enumOf(MODES, "Mode change to apply"),
  confirm: confirmFlag("Must be true"),
  inboxId: optional(itemId()),
} satisfies Shape;
const exorciseShape = {
  channel: channel(),
  agent: nick("Nick of the agent"),
  reason: optional(string({ max: 200, description: "Kick reason" })),
  confirm: confirmFlag("Must be true"),
} satisfies Shape;
const dismissShape = { id: itemId() } satisfies Shape;

const summonSchema = object(summonShape);
const grantSchema = object(grantShape);
const exorciseSchema = object(exorciseShape);
const dismissSchema = object(dismissShape);

/** Map the text of a failed tool result to an HTTP status and a stable code. */
export function classifyToolError(text: string): ApiOutcome {
  if (text.startsWith("Invalid arguments")) return fail(422, "invalid_request", text);
  if (text.startsWith("confirm: true is required")) return fail(400, "confirm_required", text);
  if (/^The bridge is [^,;]*, not registered/.test(text)) return fail(409, "not_registered", text);
  if (text.startsWith("Rate limit:")) return fail(429, "rate_limited", text);
  if (text.startsWith("busy:")) return fail(503, "busy", text);
  if (text.startsWith("Could not send (")) return fail(text.includes("(queue-full)") ? 503 : 422, text.includes("(queue-full)") ? "queue_full" : "invalid_line", text);
  if (text.startsWith("internal error")) return fail(500, "internal_error", text);
  if (/^The bridge is [^;]*; the connection was lost/.test(text)) return fail(502, "connection_lost", text);
  // Everything else is the server saying no (an invite, mode or kick refusal) or not answering in time.
  return fail(502, "server_refused", text);
}

const textOf = (result: ToolResult): string => result.content.map((c) => c.text).join("\n");

async function callTool(deps: ActionDeps, name: string, args: Record<string, unknown>): Promise<{ ok: true; data: Readonly<Record<string, unknown>> } | { ok: false; outcome: ApiOutcome }> {
  const pending = deps.registry.call(name, args);
  if (pending === undefined) return { ok: false, outcome: fail(500, "internal_error", `tool ${name} is not available`) };
  const result = await pending;
  if (result.isError === true) return { ok: false, outcome: classifyToolError(textOf(result)) };
  return { ok: true, data: result.structuredContent ?? {} };
}

function parse<S extends Shape>(schema: ObjectSchema<S>, body: unknown): { ok: true; value: Infer<S> } | { ok: false; outcome: ApiOutcome } {
  const parsed = schema.parse(body);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, outcome: fail(422, "invalid_request", parsed.error) };
}

export async function summon(deps: ActionDeps, body: unknown): Promise<ApiOutcome> {
  const parsed = parse(summonSchema, body);
  if (!parsed.ok) return parsed.outcome;
  const { channel: channelName, agent } = parsed.value;
  // The signed-in owner typing an agent name into the form is the human agreement the MCP tool asks for.
  const called = await callTool(deps, "summon", { channel: channelName, ...(agent === undefined ? {} : { agent }), confirm: true });
  if (!called.ok) return called.outcome;
  const waitedSec = called.data["waitedSec"];
  return { status: 200, body: { ready: called.data["ready"] === true, ...(typeof waitedSec === "number" ? { waitedSec } : {}) } };
}

export async function grantOp(deps: ActionDeps, body: unknown): Promise<ApiOutcome> {
  const parsed = parse(grantSchema, body);
  if (!parsed.ok) return parsed.outcome;
  const { channel: channelName, agent, mode, confirm } = parsed.value;
  if (confirm !== true) return fail(400, "confirm_required", CONFIRM_REQUIRED_MESSAGE);
  // The inbox is resolved by the grant_op tool itself, with the same rule as over MCP: only a successful +o closes
  // the open items of that channel and agent. `inboxId` is only a hint from the page and never resolves anything by
  // itself, so a stale or mismatched id (other channel, other agent, a +v) leaves every item as it was.
  const called = await callTool(deps, "grant_op", { channel: channelName, agent, mode, confirm: true });
  if (!called.ok) return called.outcome;
  return { status: 200, body: { ok: true } };
}

export async function exorcise(deps: ActionDeps, body: unknown): Promise<ApiOutcome> {
  const parsed = parse(exorciseSchema, body);
  if (!parsed.ok) return parsed.outcome;
  const { channel: channelName, agent, reason, confirm } = parsed.value;
  if (confirm !== true) return fail(400, "confirm_required", CONFIRM_REQUIRED_MESSAGE);
  const called = await callTool(deps, "exorcise", { channel: channelName, agent, ...(reason === undefined ? {} : { reason }), confirm: true });
  if (!called.ok) return called.outcome;
  return { status: 200, body: { ok: true, closed: called.data["sessionClosed"] === true } };
}

export function dismissInbox(deps: ActionDeps, body: unknown): ApiOutcome {
  const parsed = parse(dismissSchema, body);
  if (!parsed.ok) return parsed.outcome;
  return deps.store.dismiss(parsed.value.id) ? { status: 200, body: { ok: true } } : fail(404, "not_found", `No open inbox item ${parsed.value.id}.`);
}
