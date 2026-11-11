// node:http server and router. /health is answered first and needs no credentials.
// /mcp and /api/* are registered by mcp-tools and dashboard-ui behind their own guards.
import http from "node:http";
import type { Logger } from "./log.js";

export interface Route {
  /** Matches when the request path equals the prefix or continues with "/" after it. */
  readonly prefix: string;
  /** Handle the request; the route owns the response. */
  readonly handle: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
}

export interface HttpOptions {
  readonly logger: Logger;
  readonly routes?: readonly Route[];
}

const HEALTH_BODY = '{"ok":true}';

export function pathnameOf(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(HEALTH_BODY),
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : HEALTH_BODY);
}

export function createHttpServer(options: HttpOptions): http.Server {
  const routes = options.routes ?? [];
  return http.createServer((req, res) => {
    const pathname = pathnameOf(req.url);
    if (pathname === "/health") {
      handleHealth(req, res);
      return;
    }
    const route = routes.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
    if (route === undefined) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    Promise.resolve(route.handle(req, res)).catch((err: unknown) => {
      options.logger.error("route failed", { path: route.prefix, error: err });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
}

export function listen(server: http.Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
