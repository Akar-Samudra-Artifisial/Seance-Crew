// Boots the whole app on the fake ircd and calls /api/* over a real loopback socket, signing requests like the gateway.
import http from "node:http";
import { signProxyRequest } from "../src/api/proxyAuth.js";
import { bootMcp, type BootOptions, type McpHarness } from "./mcpHelpers.js";

export const PROXY_SECRET = "test-proxy-secret-not-real";

export interface ApiReply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  /** Parsed JSON, or undefined for an empty body. */
  readonly json: unknown;
}

export interface ApiRequest {
  readonly method?: string;
  readonly path: string;
  /** Sent as is (a string is sent verbatim, anything else as JSON). */
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Sign with the harness secret (default true). */
  readonly sign?: boolean;
  /** Secret used to sign (default PROXY_SECRET). */
  readonly signWith?: string;
  /** Seconds added to the signing timestamp. */
  readonly tsOffset?: number;
  readonly host?: string;
  /** Content-Type; default application/json for requests with a body. */
  readonly contentType?: string | null;
}

export interface ApiHarness extends McpHarness {
  api(request: ApiRequest): Promise<ApiReply>;
}

export async function bootApi(options: BootOptions & { readonly unsetSecret?: boolean } = {}): Promise<ApiHarness> {
  const h = await bootMcp({ ...options, ...(options.unsetSecret === true ? {} : { proxySecret: options.proxySecret ?? PROXY_SECRET }) });
  const api = (request: ApiRequest): Promise<ApiReply> =>
    new Promise((resolve, reject) => {
      const method = request.method ?? "GET";
      const payload = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      const bytes = Buffer.from(payload ?? "", "utf8");
      const headers: Record<string, string> = { Host: request.host ?? `127.0.0.1:${h.port}` };
      if (payload !== undefined) {
        headers["Content-Length"] = String(bytes.length);
        if (request.contentType !== null) headers["Content-Type"] = request.contentType ?? "application/json";
      }
      if (request.sign !== false) {
        const ts = String(Math.floor(h.clock.now() / 1000) + (request.tsOffset ?? 0));
        headers["X-KiroCrew-Proxy"] = `${ts}:${signProxyRequest(request.signWith ?? PROXY_SECRET, ts, method, request.path, bytes)}`;
      }
      Object.assign(headers, request.headers);
      const req = http.request({ host: "127.0.0.1", port: h.port, method, path: request.path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json: raw === "" ? undefined : (JSON.parse(raw) as unknown) });
        });
      });
      req.on("error", reject);
      req.end(bytes.length > 0 ? bytes : undefined);
    });
  return { ...h, api };
}

/**
 * Run `api` while pumping the fake network, like McpHarness.call does for tools: the actions wait for server replies
 * that only arrive when the fake ircd runs.
 */
export async function pump<T>(h: McpHarness, work: Promise<T>): Promise<T> {
  let done = false;
  void work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    h.ircd.run();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  h.ircd.run();
  return work;
}
