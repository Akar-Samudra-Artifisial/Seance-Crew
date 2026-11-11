// Boots the whole app (bridge + /mcp) against the fake ircd on a loopback port, for MCP tests.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startApp, type RunningApp } from "../src/app.js";
import type { FetchLike } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { SummaryProvider, ToolResult } from "../src/mcp/types.js";
import { appPaths } from "../src/paths.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";

export const MCP_SECRET = "irc-secret-mcp-4711";
export const MCP_APP_SECRET = "app-secret-mcp-0815";
export const MCP_TOKEN = "token-mcp-2342";

export interface McpHarness {
  readonly app: RunningApp;
  readonly ircd: FakeIrcd;
  readonly clock: FakeClock;
  readonly logs: string[];
  readonly port: number;
  /** Advance the fake clock in 500 ms steps, letting the in-process network settle. */
  advance(ms: number): void;
  /** POST a JSON-RPC message to /mcp with a valid Host header; returns status and parsed JSON. */
  rpc(message: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
  /** Call a tool and return its result (throws on a JSON-RPC error). The fake network runs while the call is pending. */
  call(name: string, args?: unknown): Promise<ToolResult>;
  /** Lines the bridge sent to the server on its latest connection, excluding the handshake. */
  sent(): string[];
  stop(): Promise<void>;
}

const roots: string[] = [];
const apps: RunningApp[] = [];

/** Everything one harness wrote to its log or answered over /mcp, kept to prove that no secret ever appeared in it. */
interface Captured {
  readonly logs: string[];
  readonly responses: string[];
}
const captured: Captured[] = [];

/**
 * Stops every booted app, removes the temp dirs, and then fails the test if the Séance secret, the app secret or the
 * gateway token showed up in any log line or any /mcp response of any harness (Req 6.4, 7.2).
 */
export async function cleanupMcp(): Promise<void> {
  for (const app of apps.splice(0)) await app.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  const leaks: string[] = [];
  for (const { logs, responses } of captured.splice(0)) {
    const text = `${logs.join("\n")}\n${responses.join("\n")}`;
    for (const [name, value] of [["Séance secret", MCP_SECRET], ["app secret", MCP_APP_SECRET], ["gateway token", MCP_TOKEN]] as const) {
      if (text.includes(value)) leaks.push(name);
    }
  }
  if (leaks.length > 0) throw new Error(`secret hygiene: ${[...new Set(leaks)].join(", ")} appeared in a log line or an MCP response`);
}

export interface BootOptions {
  readonly ircd?: FakeIrcd;
  readonly summary?: SummaryProvider;
  readonly gatewayOrigin?: string;
}

export async function bootMcp(options: BootOptions = {}): Promise<McpHarness> {
  const root = mkdtempSync(path.join(os.tmpdir(), "seance-mcp-"));
  roots.push(root);
  writeFileSync(path.join(root, "app.json"), "{}");
  const clock = new FakeClock();
  const ircd = options.ircd ?? new FakeIrcd();
  ircd.accounts = { ...ircd.accounts, crew: MCP_SECRET };
  const logs: string[] = [];
  const responses: string[] = [];
  captured.push({ logs, responses });
  const fetch: FetchLike = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes("/token") ? { token: MCP_TOKEN } : { host: "irc.example.org", nick: "crew", secret: MCP_SECRET }),
  });
  const app = await startApp({
    paths: appPaths(root),
    env: { KIROCREW_GATEWAY_ORIGIN: options.gatewayOrigin ?? "http://127.0.0.1:5476" },
    port: 0,
    clock,
    logger: createLogger([], (l) => logs.push(l), () => clock.now(), "debug"),
    fetch,
    readFile: async () => `${MCP_APP_SECRET}\n`,
    createSocket: (url) => ircd.connect(url),
    random: () => 0,
    ...(options.summary === undefined ? {} : { summary: options.summary }),
  });
  apps.push(app);
  ircd.run();

  const advance = (ms: number): void => {
    for (let left = ms; left > 0; left -= 500) {
      clock.advance(Math.min(500, left));
      ircd.run();
    }
  };

  const rpc = (message: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const text = JSON.stringify(message);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: app.port,
          method: "POST",
          path: "/mcp",
          headers: { Host: `127.0.0.1:${app.port}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            responses.push(raw);
            resolve({ status: res.statusCode ?? 0, body: raw === "" ? undefined : (JSON.parse(raw) as unknown) });
          });
        },
      );
      req.on("error", reject);
      req.end(text);
    });

  let nextId = 1;
  const call = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const reply = rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
    // The in-process network only moves when run() is called, so keep pumping it while the HTTP call is pending.
    let done = false;
    void reply.then(
      () => { done = true; },
      () => { done = true; },
    );
    while (!done) {
      ircd.run();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Lines queued just before the reply was written still have to reach the fake server.
    ircd.run();
    const outcome = await reply;
    const body = outcome.body as { result?: ToolResult; error?: { code: number; message: string } };
    if (body.error !== undefined) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined) throw new Error("no result");
    return body.result;
  };

  return {
    app,
    ircd,
    clock,
    logs,
    port: app.port,
    advance,
    rpc,
    call,
    sent: () => ircd.last.received.filter((l) => !/^(PASS|NICK|USER) /.test(l)),
    stop: () => app.stop(),
  };
}

/** Make the fake server echo every channel MODE with a member argument back, like a real server does. */
export function echoModes(ircd: FakeIrcd): void {
  ircd.hooks.push((m, conn, d) => {
    if (m.command === "MODE" && m.params.length >= 3) d.reply(conn, `:crew!u@h MODE ${m.params.join(" ")}`);
  });
}

/** Make the fake server echo every KICK to the channel. */
export function echoKicks(ircd: FakeIrcd): void {
  ircd.hooks.push((m, conn, d) => {
    if (m.command === "KICK") d.reply(conn, `:crew!u@h KICK ${m.params[0] ?? ""} ${m.params[1] ?? ""} :${m.params[2] ?? ""}`);
  });
}

/** Poll (real time) until `condition` holds; fails after `timeoutMs`. */
export async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Text of a tool result (first content item). */
export const textOf = (result: ToolResult): string => result.content.map((c) => c.text).join("\n");
