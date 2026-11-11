// Small HTTP helpers for /api/*: the JSON error shape and a byte-exact body reader (the proxy signature covers the bytes).
import type http from "node:http";
import { sendJson } from "../http.js";

export const MAX_BODY_BYTES = 16 * 1024;

export function sendError(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

/** Read the raw body, giving up (null) as soon as more than `limit` bytes have arrived. */
export function readBodyBytes(req: http.IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | null): void => {
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
    req.on("end", () => settle(Buffer.concat(chunks)));
    req.on("error", () => settle(null));
    req.on("close", () => settle(Buffer.concat(chunks)));
  });
}
