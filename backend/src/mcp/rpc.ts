// JSON-RPC 2.0 envelope handling for the MCP endpoint: parsing single and batch messages, building replies.

export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RpcId = string | number;

export interface RpcRequest {
  readonly kind: "request";
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
}

/** A message without an id: it gets no reply. */
export interface RpcNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

/** An element that is not a valid request object; `id` is echoed when it was usable, otherwise null. */
export interface RpcInvalid {
  readonly kind: "invalid";
  readonly id: RpcId | null;
}

/** A response object sent by the client (it has `result` or `error` and no `method`): accepted, never answered. */
export interface RpcResponse {
  readonly kind: "response";
}

export type RpcMessage = RpcRequest | RpcNotification | RpcInvalid | RpcResponse;

export type ParsedBody =
  | { readonly kind: "parse-error" }
  | { readonly kind: "single"; readonly message: RpcMessage }
  | { readonly kind: "batch"; readonly messages: readonly RpcMessage[] };

export interface RpcErrorReply {
  readonly jsonrpc: "2.0";
  readonly id: RpcId | null;
  readonly error: { readonly code: number; readonly message: string };
}

export interface RpcResultReply {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly result: unknown;
}

export type RpcReply = RpcErrorReply | RpcResultReply;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const usableId = (v: unknown): v is RpcId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Classify one decoded element. */
export function classify(value: unknown): RpcMessage {
  if (!isRecord(value)) return { kind: "invalid", id: null };
  if (value["jsonrpc"] === "2.0" && !("method" in value) && ("result" in value || "error" in value)) return { kind: "response" };
  const hasId = "id" in value;
  const id = usableId(value["id"]) ? value["id"] : null;
  if (value["jsonrpc"] !== "2.0" || typeof value["method"] !== "string" || value["method"] === "") {
    return { kind: "invalid", id };
  }
  if (!hasId) return { kind: "notification", method: value["method"], params: value["params"] };
  if (id === null) return { kind: "invalid", id: null };
  return { kind: "request", id, method: value["method"], params: value["params"] };
}

export function parseBody(text: string): ParsedBody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { kind: "parse-error" };
  }
  if (Array.isArray(decoded)) {
    // An empty batch is not a valid request.
    if (decoded.length === 0) return { kind: "single", message: { kind: "invalid", id: null } };
    return { kind: "batch", messages: decoded.map(classify) };
  }
  return { kind: "single", message: classify(decoded) };
}

export const rpcResult = (id: RpcId, result: unknown): RpcResultReply => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: RpcId | null, code: number, message: string): RpcErrorReply => ({ jsonrpc: "2.0", id, error: { code, message } });
