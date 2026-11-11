// Verifies the gateway's X-KiroCrew-Proxy signature (scheme v1, recorded in .kiro/steering/kirocrew.md):
//   header  = "<ts>:<sig>", ts = integer Unix seconds
//   msg     = "<ts>:<METHOD>:<target>:<sha256hex(body)>", target = the raw request-target as received
//   sig     = lowercase hex of HMAC-SHA256(key = KIROCREW_PROXY_SECRET, msg)
// Fails closed: anything malformed is a rejection, and an unset secret is a 503, never "skip verification".
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PROXY_HEADER = "x-kirocrew-proxy";
export const MAX_SKEW_SECONDS = 60;

export type ProxyAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403; readonly code: "invalid_proxy_signature" }
  | { readonly ok: false; readonly status: 503; readonly code: "proxy_secret_missing" };

export interface ProxyAuthInput {
  /** The raw header value, or undefined when absent (or sent more than once). */
  readonly header: string | undefined;
  readonly method: string;
  /** `req.url`: the raw request-target, path and query exactly as received. */
  readonly target: string;
  readonly body: Uint8Array;
  /** KIROCREW_PROXY_SECRET. */
  readonly secret: string | undefined;
  /** Current time in milliseconds. */
  readonly nowMs: number;
}

const REJECTED: ProxyAuthResult = { ok: false, status: 403, code: "invalid_proxy_signature" };

/** The expected signature for a message; exported for tests. */
export function signProxyRequest(secret: string, ts: string, method: string, target: string, body: Uint8Array): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${ts}:${method}:${target}:${bodyHash}`).digest("hex");
}

export function verifyProxyRequest(input: ProxyAuthInput): ProxyAuthResult {
  if (input.secret === undefined || input.secret === "") return { ok: false, status: 503, code: "proxy_secret_missing" };
  const header = input.header;
  if (header === undefined || header === "") return REJECTED;
  const colon = header.indexOf(":");
  if (colon === -1) return REJECTED;
  const ts = header.slice(0, colon);
  const sig = header.slice(colon + 1);
  if (!/^[0-9]+$/.test(ts) || sig === "") return REJECTED;
  if (Math.abs(input.nowMs / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return REJECTED;
  const expected = Buffer.from(signProxyRequest(input.secret, ts, input.method, input.target, input.body), "utf8");
  // Compare bytes, never strings: a non-ASCII signature must get a verdict, not an exception. timingSafeEqual needs
  // equal lengths; the expected length (64) is public, so returning early on a length mismatch leaks nothing.
  const presented = Buffer.from(sig, "utf8");
  if (presented.length !== expected.length) return REJECTED;
  return timingSafeEqual(expected, presented) ? { ok: true } : REJECTED;
}

export const REPLAY_WINDOW_MS = 120_000;
export const REPLAY_MAX_ENTRIES = 1_000;

/**
 * Remembers verified signatures for 120 s so the same signed request cannot be sent twice. The map is bounded: when
 * it is full after pruning, the oldest entry goes. Only signatures that already verified are stored, so an unsigned
 * caller cannot fill it. 120 s covers the ±60 s window on both sides of the signing time.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = REPLAY_WINDOW_MS,
    private readonly maxEntries: number = REPLAY_MAX_ENTRIES,
  ) {}

  get size(): number {
    return this.seen.size;
  }

  /** True when `signature` has not been used inside the window (and records it); false for a replay. */
  accept(signature: string, nowMs: number): boolean {
    for (const [key, expires] of this.seen) {
      // Insertion order is expiry order, so stop at the first live entry.
      if (expires > nowMs) break;
      this.seen.delete(key);
    }
    if (this.seen.has(signature)) return false;
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.set(signature, nowMs + this.windowMs);
    return true;
  }
}
