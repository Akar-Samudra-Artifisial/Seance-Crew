// Local-caller guard shared by /mcp and /api/*: Host check (DNS rebinding) and Origin check (browsers).
// There is no credential on /mcp (the gateway sends none), see .kiro/steering/security.md.
import type { IncomingHttpHeaders } from "node:http";

export type GuardCode = "bad_host" | "bad_origin";

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 421 | 403; readonly code: GuardCode };

export interface GuardOptions {
  /** The port the server is listening on. */
  readonly port: number;
  /** KIROCREW_GATEWAY_ORIGIN, or undefined when it is not set. */
  readonly gatewayOrigin: string | undefined;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface OriginKey {
  readonly scheme: string;
  readonly host: string;
  readonly port: string;
}

/** Scheme, host and port of an origin, with the three loopback spellings folded into one host. Null if not an origin. */
export function normalizeOrigin(value: string): OriginKey | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // An Origin header is scheme://host[:port] only.
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (value.endsWith("/")) return null;
  const host = url.hostname.toLowerCase();
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  return { scheme: url.protocol, host: LOOPBACK_NAMES.has(host) ? "loopback" : host, port };
}

const single = (value: string | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);

export function checkLocalCaller(req: { readonly headers: IncomingHttpHeaders }, options: GuardOptions): GuardResult {
  const host = single(req.headers.host)?.toLowerCase();
  if (host === undefined || (host !== `127.0.0.1:${options.port}` && host !== `localhost:${options.port}`)) {
    return { ok: false, status: 421, code: "bad_host" };
  }
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return { ok: true };
  const origin = single(rawOrigin);
  const gateway = options.gatewayOrigin === undefined ? null : normalizeOrigin(options.gatewayOrigin.trim().replace(/\/+$/, ""));
  const presented = origin === undefined ? null : normalizeOrigin(origin);
  if (gateway === null || presented === null) return { ok: false, status: 403, code: "bad_origin" };
  if (presented.scheme !== gateway.scheme || presented.host !== gateway.host || presented.port !== gateway.port) {
    return { ok: false, status: 403, code: "bad_origin" };
  }
  return { ok: true };
}
