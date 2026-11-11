import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer, listen } from "../src/http.js";
import { LATEST_PROTOCOL_VERSION, MAX_BODY_BYTES, createMcpRoute } from "../src/mcp/handler.js";
import { textResult, type ToolRegistry } from "../src/mcp/types.js";
import { createLogger } from "../src/log.js";

const GATEWAY = "http://127.0.0.1:5476";

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
  json(): unknown;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
});

const start = async (overrides: { gatewayOrigin?: string | undefined } = {}) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const registry: ToolRegistry = {
    list: () => [{ name: "echo", description: "Echo (stub).", inputSchema: { type: "object", additionalProperties: false } }],
    call: (name, args) => {
      if (name !== "echo") return undefined;
      calls.push({ name, args });
      return Promise.resolve(textResult("echoed", { args: args as Record<string, unknown> }));
    },
  };
  let port = 0;
  const server = createHttpServer({
    logger: createLogger([], () => undefined),
    routes: [
      createMcpRoute({
        port: () => port,
        gatewayOrigin: "gatewayOrigin" in overrides ? overrides.gatewayOrigin : GATEWAY,
        registry,
        logger: createLogger([], () => undefined),
      }),
    ],
  });
  servers.push(server);
  port = await listen(server, 0);
  return { port, calls };
};

const send = (port: number, method: string, path: string, body: string | undefined, headers: Record<string, string> = {}, hostOverride?: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: hostOverride ?? `127.0.0.1:${port}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers, json: () => JSON.parse(text) as unknown });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const rpc = (port: number, message: unknown, headers: Record<string, string> = {}) => send(port, "POST", "/mcp", JSON.stringify(message), headers);

describe("guard runs before the body is read", () => {
  it("answers 421 for a wrong Host even with an oversized body, and never runs a tool", async () => {
    const { port, calls } = await start();
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { pad: "x".repeat(MAX_BODY_BYTES + 1_000) } } });
    const reply = await send(port, "POST", "/mcp", big, {}, "evil.example");
    expect(reply.status).toBe(421);
    expect(reply.json()).toEqual({ error: "bad_host" });
    expect(calls).toHaveLength(0);
  });

  it("answers 421 for a Host without a port", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/mcp", "{}", {}, "127.0.0.1")).status).toBe(421);
  });

  it("accepts localhost:<port>", async () => {
    const { port } = await start();
    const reply = await send(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {}, `localhost:${port}`);
    expect(reply.status).toBe(200);
  });

  it("answers 403 for a foreign Origin and 403 for Origin: null", async () => {
    const { port } = await start();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(port, ping, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await rpc(port, ping, { Origin: "null" })).status).toBe(403);
  });

  it("accepts the gateway origin, also spelled localhost, and no Origin", async () => {
    const { port } = await start();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(port, ping, { Origin: GATEWAY })).status).toBe(200);
    expect((await rpc(port, ping, { Origin: "http://localhost:5476" })).status).toBe(200);
    expect((await rpc(port, ping)).status).toBe(200);
  });

  it("answers 403 to any Origin when the gateway origin is unset", async () => {
    const { port } = await start({ gatewayOrigin: undefined });
    expect((await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: GATEWAY })).status).toBe(403);
  });

  it("does not apply to /health", async () => {
    const { port } = await start();
    const reply = await send(port, "GET", "/health", undefined, {}, "anything.example");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"ok":true}');
  });
});

describe("HTTP status codes", () => {
  it.each(["GET", "DELETE", "PUT"])("answers 405 with Allow: POST for %s", async (method) => {
    const { port } = await start();
    const reply = await send(port, method, "/mcp", undefined);
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("POST");
  });

  it("answers 404 for other paths under /mcp", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/mcp/extra", "{}")).status).toBe(404);
  });

  it("answers 413 above 64 KiB and accepts exactly 64 KiB", async () => {
    const { port } = await start();
    const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const exact = `${base}${" ".repeat(MAX_BODY_BYTES - base.length)}`;
    expect(Buffer.byteLength(exact)).toBe(MAX_BODY_BYTES);
    expect((await send(port, "POST", "/mcp", exact)).status).toBe(200);
    expect((await send(port, "POST", "/mcp", `${exact} `)).status).toBe(413);
  });

  it("answers application/json with no session header", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(reply.headers["content-type"]).toMatch(/^application\/json/);
    expect(reply.headers["mcp-session-id"]).toBeUndefined();
    expect(reply.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("answers 202 with an empty body for a notification", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe("");
  });

  it("answers 202 for an unknown notification too", async () => {
    const { port } = await start();
    expect((await rpc(port, { jsonrpc: "2.0", method: "whatever/else" })).status).toBe(202);
  });
});

describe("initialize", () => {
  it.each(["2025-06-18", "2025-03-26", "2024-11-05"])("echoes the supported version %s", async (version) => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(reply.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "seance-crew", version: "0.1.0" } },
    });
  });

  it("answers the latest version for an unknown one", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((reply.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("ignores the MCP-Protocol-Version header", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2099-01-01" });
    expect(reply.status).toBe(200);
  });

  it("answers -32602 without protocolVersion", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((reply.json() as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("JSON-RPC errors", () => {
  it("answers -32700 for invalid JSON", async () => {
    const { port } = await start();
    const reply = await send(port, "POST", "/mcp", "{not json");
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("answers -32600 for a non-request", async () => {
    const { port } = await start();
    expect((await send(port, "POST", "/mcp", "5")).json()).toMatchObject({ id: null, error: { code: -32600 } });
    expect((await rpc(port, { id: 4, method: "ping" })).json()).toMatchObject({ id: 4, error: { code: -32600 } });
  });

  it("answers -32601 for an unknown method", async () => {
    const { port } = await start();
    expect((await rpc(port, { jsonrpc: "2.0", id: 2, method: "resources/list" })).json()).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it("answers -32602 for bad tools/call params and for an unknown tool", async () => {
    const { port } = await start();
    for (const params of [undefined, {}, { name: 5 }, { name: "echo", arguments: [] }, { name: "echo", arguments: "x" }, { name: "nope" }]) {
      const reply = await rpc(port, { jsonrpc: "2.0", id: 3, method: "tools/call", ...(params === undefined ? {} : { params }) });
      expect(reply.json()).toMatchObject({ id: 3, error: { code: -32602 } });
    }
  });
});

describe("tools", () => {
  it("lists the registry", async () => {
    const { port } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(reply.json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  });

  it("calls a tool with arguments, defaulting to {}", async () => {
    const { port, calls } = await start();
    const reply = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
    expect(reply.json()).toMatchObject({ result: { content: [{ type: "text", text: "echoed" }], structuredContent: { args: { a: 1 } } } });
    await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo" } });
    expect(calls.map((c) => c.args)).toEqual([{ a: 1 }, {}]);
  });
});

describe("batches", () => {
  it("answers each request and skips notifications", async () => {
    const { port } = await start();
    const reply = await rpc(port, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      7,
    ]);
    expect(reply.status).toBe(200);
    const body = reply.json() as Array<{ id: number | null }>;
    expect(body.map((r) => r.id)).toEqual([1, 2, null]);
  });

  it("answers 202 for a batch of notifications only", async () => {
    const { port } = await start();
    const reply = await rpc(port, [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "notifications/cancelled" }]);
    expect(reply.status).toBe(202);
    expect(reply.body).toBe("");
  });

  it("answers one -32600 for an empty batch", async () => {
    const { port } = await start();
    expect((await rpc(port, [])).json()).toMatchObject({ error: { code: -32600 } });
  });
});
