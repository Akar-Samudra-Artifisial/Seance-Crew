import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type RunningApp } from "../src/app.js";
import type { FetchLike } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { appPaths, type AppPaths } from "../src/paths.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";

const SECRET = "irc-secret-zzz999";
const APP_SECRET = "app-secret-yyy888";
const TOKEN = "token-xxx777";

const running: RunningApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const makePaths = (): AppPaths => {
  const root = mkdtempSync(path.join(os.tmpdir(), "seance-app-"));
  roots.push(root);
  writeFileSync(path.join(root, "app.json"), "{}");
  return appPaths(root);
};

const fetchWith = (config: Record<string, unknown>): FetchLike => async (url) => ({
  ok: true,
  status: 200,
  json: async () => (url.includes("/token") ? { token: TOKEN } : config),
});

const boot = async (opts: { paths?: AppPaths; config?: Record<string, unknown>; ircd?: FakeIrcd; env?: Record<string, string> } = {}) => {
  const paths = opts.paths ?? makePaths();
  const clock = new FakeClock();
  const ircd = opts.ircd ?? new FakeIrcd();
  const logs: string[] = [];
  const logger = createLogger([], (l) => logs.push(l), () => clock.now());
  const app = await startApp({
    paths,
    env: opts.env ?? { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476" },
    port: 0,
    clock,
    logger,
    fetch: fetchWith(opts.config ?? { host: "irc.example.org", nick: "crew", secret: "s3cret" }),
    readFile: async () => `${APP_SECRET}\n`,
    createSocket: (url) => ircd.connect(url),
    random: () => 0,
  });
  running.push(app);
  ircd.run();
  return { app, ircd, clock, logs, paths };
};

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}
const request = (port: number, method: string, url: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });

describe("GET /health", () => {
  it("answers exactly {\"ok\":true} with no credentials while the bridge is registered", async () => {
    const { app } = await boot();
    expect(app.store.state).toBe("registered");
    const reply = await request(app.port, "GET", "/health");
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"ok":true}');
    expect(reply.headers["content-type"]).toContain("application/json");
  });

  it("answers the same body in every bridge state", async () => {
    // unconfigured: no secret in the config
    const unconfigured = await boot({ config: { host: "irc.example.org", nick: "crew" } });
    expect(unconfigured.app.store.state).toBe("unconfigured");
    expect((await request(unconfigured.app.port, "GET", "/health")).body).toBe('{"ok":true}');

    // auth-failed: wrong secret
    const ircd = new FakeIrcd();
    ircd.accounts = { crew: "something-else" };
    const failed = await boot({ ircd });
    expect(failed.app.store.state).toBe("auth-failed");
    expect((await request(failed.app.port, "GET", "/health")).body).toBe('{"ok":true}');

    // reconnecting: the connection drops
    const dropped = await boot();
    dropped.ircd.drop(dropped.ircd.last);
    dropped.ircd.run();
    expect(dropped.app.store.state).toBe("reconnecting");
    expect((await request(dropped.app.port, "GET", "/health")).body).toBe('{"ok":true}');

    // no config at all: the gateway cannot be reached
    const broken = await boot({ env: {} });
    expect(broken.app.store.state).toBe("unconfigured");
    expect((await request(broken.app.port, "GET", "/health")).body).toBe('{"ok":true}');
  });

  it("answers HEAD without a body and rejects other methods with 405", async () => {
    const { app } = await boot();
    const head = await request(app.port, "HEAD", "/health");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("11");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const reply = await request(app.port, method, "/health");
      expect(reply.status).toBe(405);
      expect(reply.headers["allow"]).toBe("GET, HEAD");
    }
  });

  it("ignores a query string and 404s other paths", async () => {
    const { app } = await boot();
    expect((await request(app.port, "GET", "/health?x=1")).body).toBe('{"ok":true}');
    expect((await request(app.port, "GET", "/nope")).status).toBe(404);
    expect((await request(app.port, "GET", "/healthz")).status).toBe(404);
  });

  it("never contains state, counts, host, nick, error text, the secret or the token", async () => {
    const { app, logs } = await boot();
    const bodies = (await Promise.all(["/health", "/nope", "/health?a=b"].map((p) => request(app.port, "GET", p)))).map((r) => r.body);
    for (const body of bodies) {
      for (const forbidden of [SECRET, "s3cret", APP_SECRET, TOKEN, "irc.example.org", "crew", "registered", "uptime", "channels"]) {
        expect(body).not.toContain(forbidden);
      }
    }
    expect(logs.join("\n")).not.toContain("s3cret");
    expect(logs.join("\n")).not.toContain(APP_SECRET);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("Property 7: health is minimal and the secret never leaks", () => {
  it("keeps every log line free of the secrets across a full session", async () => {
    const { app, ircd, logs, clock } = await boot();
    ircd.drop(ircd.last);
    ircd.run();
    for (let i = 0; i < 6; i++) {
      clock.advance(500);
      ircd.run();
    }
    expect(app.store.state).toBe("registered");
    const text = logs.join("\n");
    for (const secret of ["s3cret", APP_SECRET, TOKEN]) expect(text).not.toContain(secret);
  });

  it("reports configuration errors without secrets and does not connect", async () => {
    const paths = makePaths();
    const clock = new FakeClock();
    const ircd = new FakeIrcd();
    const logs: string[] = [];
    const app = await startApp({
      paths,
      env: { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476" },
      port: 0,
      clock,
      logger: createLogger([], (l) => logs.push(l)),
      fetch: async (url) => {
        throw new Error(`boom ${url} ${APP_SECRET}`);
      },
      readFile: async () => APP_SECRET,
      createSocket: (u) => ircd.connect(u),
    });
    running.push(app);
    ircd.run();
    expect(ircd.totalConnections).toBe(0);
    expect(logs.join("\n")).toContain('step \\"token\\"');
    expect(logs.join("\n")).not.toContain(APP_SECRET);
  });
});

describe("startup and persistence", () => {
  it("writes only the lock file into data/ (no port file) and the lock is removed on stop", async () => {
    const { app, paths } = await boot();
    expect(readdirSync(paths.data)).toEqual(["bridge.lock"]);
    await app.stop();
    expect(readdirSync(paths.data)).toEqual([]);
  });

  it("a second instance on the same data directory gets duplicate-instance, opens no socket and still serves /health", async () => {
    const first = await boot();
    const second = await boot({ paths: first.paths });
    expect(second.app.store.state).toBe("duplicate-instance");
    expect(second.ircd.totalConnections).toBe(0);
    expect(second.app.lock).toBeNull();
    expect((await request(second.app.port, "GET", "/health")).body).toBe('{"ok":true}');
    // The first instance still holds the lock and its connection.
    expect(first.app.store.state).toBe("registered");
    expect(readdirSync(first.paths.data)).toEqual(["bridge.lock"]);
    await second.app.stop();
    expect(readdirSync(first.paths.data)).toEqual(["bridge.lock"]); // the duplicate must not remove the holder's lock
  });

  it("binds to loopback only", async () => {
    const { app } = await boot();
    const address = app.server.address();
    expect(typeof address === "object" && address !== null ? address.address : "").toBe("127.0.0.1");
  });
});
