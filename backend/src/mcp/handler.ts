// POST /mcp: stateless Streamable HTTP MCP. Guard first (before the body is read), then JSON-RPC dispatch.
import type http from "node:http";
import { checkLocalCaller } from "../http/guard.js";
import { pathnameOf, sendJson, type Route } from "../http.js";
import type { Logger } from "../log.js";
import { parseBody, RpcCode, rpcError, rpcResult, type RpcMessage, type RpcReply } from "./rpc.js";
import type { ToolRegistry } from "./types.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 20;
export const SERVER_NAME = "seance-crew";
/** Matches app.json. */
export const SERVER_VERSION = "0.1.0";

export interface McpHandlerDeps {
  /** The port the server listens on (known only after listen, hence a function). */
  readonly port: () => number;
  /** KIROCREW_GATEWAY_ORIGIN. */
  readonly gatewayOrigin: string | undefined;
  readonly registry: ToolRegistry;
  readonly logger: Logger;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read the body, giving up (null) as soon as more than `limit` bytes have arrived. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settle(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => settle(null));
    req.on("close", () => settle(Buffer.concat(chunks).toString("utf8")));
  });
}

function negotiateVersion(params: unknown): string | null {
  if (!isRecord(params) || typeof params["protocolVersion"] !== "string") return null;
  const wanted = params["protocolVersion"];
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(wanted) ? wanted : LATEST_PROTOCOL_VERSION;
}

const shorten = (text: string): string => (text.length > 60 ? `${text.slice(0, 60)}...` : text);

async function answer(message: RpcMessage, deps: McpHandlerDeps): Promise<RpcReply | null> {
  if (message.kind === "invalid") return rpcError(message.id, RpcCode.InvalidRequest, "Invalid Request");
  // Notifications and client responses never get a reply, known or not.
  if (message.kind === "notification" || message.kind === "response") return null;
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const version = negotiateVersion(params);
      if (version === null) return rpcError(id, RpcCode.InvalidParams, "initialize: params.protocolVersion must be a string");
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: deps.registry.list() });
    case "tools/call": {
      if (!isRecord(params) || typeof params["name"] !== "string") return rpcError(id, RpcCode.InvalidParams, "tools/call: params.name must be a string");
      const args = params["arguments"];
      if (args !== undefined && !isRecord(args)) return rpcError(id, RpcCode.InvalidParams, "tools/call: params.arguments must be an object");
      const name = params["name"];
      const pending = deps.registry.call(name, args ?? {});
      if (pending === undefined) return rpcError(id, RpcCode.InvalidParams, `Unknown tool: ${JSON.stringify(shorten(name))}`);
      return rpcResult(id, await pending);
    }
    default:
      return rpcError(id, RpcCode.MethodNotFound, `Method not found: ${JSON.stringify(shorten(method))}`);
  }
}

function sendAccepted(res: http.ServerResponse): void {
  res.writeHead(202, { "Content-Length": 0, "Cache-Control": "no-store" });
  res.end();
}

export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, deps: McpHandlerDeps): Promise<void> {
  // 1. Who is calling? Before anything else, and before the body is read.
  const guard = checkLocalCaller(req, { port: deps.port(), gatewayOrigin: deps.gatewayOrigin });
  if (!guard.ok) {
    sendJson(res, guard.status, { error: guard.code }, { Connection: "close" });
    return;
  }
  if (pathnameOf(req.url) !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
    return;
  }
  // 2. The body: refuse early on a declared size, and count while streaming for the rest.
  const tooLarge = (): void => {
    sendJson(res, 413, { error: "payload_too_large" }, { Connection: "close" });
    // Stop receiving once the answer is out.
    res.once("finish", () => req.destroy());
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    tooLarge();
    return;
  }
  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    tooLarge();
    return;
  }
  // 3. JSON-RPC.
  const parsed = parseBody(body);
  if (parsed.kind === "parse-error") {
    sendJson(res, 200, rpcError(null, RpcCode.ParseError, "Parse error"));
    return;
  }
  if (parsed.kind === "single") {
    const reply = await answer(parsed.message, deps);
    if (reply === null) sendAccepted(res);
    else sendJson(res, 200, reply);
    return;
  }
  if (parsed.messages.length > MAX_BATCH) {
    sendJson(res, 200, rpcError(null, RpcCode.InvalidRequest, `Invalid Request: a batch holds at most ${MAX_BATCH} messages`));
    return;
  }
  const replies = (await Promise.all(parsed.messages.map((m) => answer(m, deps)))).filter((r): r is RpcReply => r !== null);
  if (replies.length === 0) sendAccepted(res);
  else sendJson(res, 200, replies);
}

/** The route object for src/http.ts. Unexpected throws are logged by the router and answered with 500. */
export function createMcpRoute(deps: McpHandlerDeps): Route {
  return { prefix: "/mcp", handle: (req, res) => handleMcp(req, res, deps) };
}
