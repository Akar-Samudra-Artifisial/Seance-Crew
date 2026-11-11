import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { signProxyRequest } from "../src/api/proxyAuth.js";
import { API_PATHS } from "../src/api/routes.js";
import type { State } from "../src/api/state.js";
import { bootApi, PROXY_SECRET } from "./apiHelpers.js";
import { cleanupMcp, MCP_SECRET } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const errorOf = (json: unknown): { code: string; message: string } => (json as { error: { code: string; message: string } }).error;

describe("local-caller guard on /api/*", () => {
  it("answers a foreign Host with 421, even for a correctly signed request", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/state", host: "evil.example:80" });
    expect(reply.status).toBe(421);
    expect(errorOf(reply.json).code).toBe("bad_host");
  });

  it("answers a foreign Origin with 403 bad_origin", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/state", headers: { Origin: "http://evil.example" } });
    expect(reply.status).toBe(403);
    expect(errorOf(reply.json).code).toBe("bad_origin");
  });

  it("accepts the gateway origin, and a request without Origin", async () => {
    const h = await bootApi();
    expect((await h.api({ path: "/api/state", headers: { Origin: "http://localhost:5476" } })).status).toBe(200);
    expect((await h.api({ path: "/api/state" })).status).toBe(200);
  });

  it("checks the guard before the signature (a bad Host with no signature is 421, not 403)", async () => {
    const h = await bootApi();
    expect((await h.api({ path: "/api/state", host: "evil.example:80", sign: false })).status).toBe(421);
  });
});

describe("proxy signature on /api/*", () => {
  it("answers 403 invalid_proxy_signature when the header is missing", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/state", sign: false });
    expect(reply.status).toBe(403);
    expect(errorOf(reply.json).code).toBe("invalid_proxy_signature");
  });

  it("answers 403 for a bad, expired, future or wrongly keyed signature", async () => {
    const h = await bootApi();
    for (const request of [
      { path: "/api/state", sign: false, headers: { "X-KiroCrew-Proxy": "garbage" } },
      { path: "/api/state", sign: false, headers: { "X-KiroCrew-Proxy": `${Math.floor(h.clock.now() / 1000)}:${"0".repeat(64)}` } },
      { path: "/api/state", tsOffset: -120 },
      { path: "/api/state", tsOffset: 120 },
      { path: "/api/state", signWith: "another-secret" },
    ]) {
      const reply = await h.api(request);
      expect(reply.status).toBe(403);
      expect(errorOf(reply.json).code).toBe("invalid_proxy_signature");
    }
  });

  it("rejects a signature made for another path or method", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/summary", sign: false, headers: { "X-KiroCrew-Proxy": signedHeader(h.clock.now(), "GET", "/api/state") } });
    expect(reply.status).toBe(403);
  });

  it("answers 200 for a valid signed request", async () => {
    const h = await bootApi();
    expect((await h.api({ path: "/api/state" })).status).toBe(200);
  });

  it("fails closed with 503 proxy_secret_missing when KIROCREW_PROXY_SECRET is unset, signed or not", async () => {
    const h = await bootApi({ unsetSecret: true });
    for (const sign of [true, false]) {
      const reply = await h.api({ path: "/api/state", sign });
      expect(reply.status).toBe(503);
      expect(errorOf(reply.json).code).toBe("proxy_secret_missing");
    }
  });

  it("does not leak the proxy secret in any response or log line", async () => {
    const h = await bootApi();
    const replies = [await h.api({ path: "/api/state" }), await h.api({ path: "/api/state", sign: false }), await h.api({ path: "/api/nope" })];
    const text = [...replies.map((r) => r.raw), ...h.logs].join("\n");
    expect(text).not.toContain(PROXY_SECRET);
  });
});

describe("GET /api/state", () => {
  it("returns the full state with no-store, and never the Séance secret", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/state" });
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["content-type"]).toContain("application/json");
    const state = reply.json as State;
    expect(state.bridge.state).toBe("registered");
    expect(state.bridge.nick).toBe("crew");
    expect(state.bridge.host).toBe("irc.example.org");
    expect(state.revision).toBe(h.app.store.revision);
    expect(reply.raw).not.toContain(MCP_SECRET);
  });

  it("answers { changed: false } for the current revision and the full state after a change", async () => {
    const h = await bootApi();
    const first = (await h.api({ path: "/api/state" })).json as State;
    const same = await h.api({ path: `/api/state?since=${first.revision}` });
    expect(same.json).toEqual({ changed: false, revision: first.revision, bootId: first.bootId });
    h.app.store.addLine("#new", "bob", "privmsg", "hello");
    const after = await h.api({ path: `/api/state?since=${first.revision}` });
    const state = after.json as State;
    expect(state.revision).toBeGreaterThan(first.revision);
    expect(state.channels.map((c) => c.name)).toContain("#new");
  });

  it("answers the full state for a revision from before a restart (ahead of the store)", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/state?since=999999" });
    expect((reply.json as State).revision).toBe(h.app.store.revision);
  });

  it("carries a random per-process bootId in the full state and in { changed: false }", async () => {
    const h = await bootApi();
    const first = (await h.api({ path: "/api/state" })).json as State;
    expect(first.bootId).toMatch(/^[0-9a-f-]{36}$/);
    const again = (await h.api({ path: "/api/state" })).json as State;
    expect(again.bootId).toBe(first.bootId);
    const same = (await h.api({ path: `/api/state?since=${first.revision}` })).json as { bootId: string };
    expect(same.bootId).toBe(first.bootId);
  });

  it("answers 422 for a malformed since", async () => {
    const h = await bootApi();
    for (const since of ["abc", "-1", "1.5", "", "99999999999999999999"]) {
      const reply = await h.api({ path: `/api/state?since=${since}` });
      expect(reply.status).toBe(422);
      expect(errorOf(reply.json).code).toBe("invalid_since");
    }
  });
});

describe("replayed signatures", () => {
  const dismiss = { method: "POST", path: "/api/inbox/dismiss", body: { id: "i404" } } as const;

  it("rejects the same signed POST used a second time with 403 replayed_signature", async () => {
    const h = await bootApi();
    const first = await h.api(dismiss);
    expect(first.status).toBe(404); // a valid request for an unknown item
    const second = await h.api(dismiss);
    expect(second.status).toBe(403);
    expect(errorOf(second.json).code).toBe("replayed_signature");
  });

  it("accepts the same POST again once the clock has moved on (a new signature)", async () => {
    const h = await bootApi();
    expect((await h.api(dismiss)).status).toBe(404);
    h.clock.advance(1_000);
    expect((await h.api(dismiss)).status).toBe(404);
  });

  it("does not remember a request that failed verification", async () => {
    const h = await bootApi();
    expect((await h.api({ ...dismiss, signWith: "wrong" })).status).toBe(403);
    expect((await h.api(dismiss)).status).toBe(404);
  });

  it("allows an identical signed GET twice in the same second (the same poll can repeat)", async () => {
    const h = await bootApi();
    expect((await h.api({ path: "/api/state" })).status).toBe(200);
    expect((await h.api({ path: "/api/state" })).status).toBe(200);
  });
});

describe("GET /api/summary", () => {
  it("returns { summary: null } when there is none", async () => {
    const h = await bootApi();
    const reply = await h.api({ path: "/api/summary" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ summary: null });
  });

  it("returns the latest summary from the injected provider", async () => {
    const summary = { date: "2026-11-10", generatedAt: 1, totalCredits: 4.5, channels: [{ name: "#a", used: 4.5, total: 10 }], stale: false };
    const h = await bootApi({ summary: { latest: () => summary } });
    expect((await h.api({ path: "/api/summary" })).json).toEqual({ summary });
  });
});

describe("routing, methods and bodies", () => {
  it("answers 404 for an unknown signed path, and 403 for the same path unsigned", async () => {
    const h = await bootApi();
    const signed = await h.api({ path: "/api/nope" });
    expect(signed.status).toBe(404);
    expect(errorOf(signed.json)).toEqual({ code: "not_found", message: expect.any(String) });
    expect((await h.api({ path: "/api/nope", sign: false })).status).toBe(403);
  });

  it("answers 405 with Allow for a wrong method", async () => {
    const h = await bootApi();
    const post = await h.api({ method: "POST", path: "/api/state", body: {} });
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET");
    const del = await h.api({ method: "DELETE", path: "/api/summon" });
    expect(del.status).toBe(405);
    expect(del.headers["allow"]).toBe("POST");
  });

  it("uses one error body shape: { error: { code, message } }", async () => {
    const h = await bootApi();
    for (const reply of [await h.api({ path: "/api/nope" }), await h.api({ path: "/api/state", sign: false }), await h.api({ method: "PUT", path: "/api/state" })]) {
      expect(Object.keys(reply.json as object)).toEqual(["error"]);
      expect(Object.keys(errorOf(reply.json)).sort()).toEqual(["code", "message"]);
    }
  });

  it("answers 413 for a body over 16 KiB", async () => {
    const h = await bootApi();
    const reply = await h.api({ method: "POST", path: "/api/summon", body: JSON.stringify({ channel: "#a", agent: "x".repeat(17 * 1024) }) });
    expect(reply.status).toBe(413);
    expect(errorOf(reply.json).code).toBe("payload_too_large");
  });

  it("answers 413 for an oversize body that does not declare its length", async () => {
    const h = await bootApi();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.port, method: "POST", path: "/api/summon", headers: { Host: `127.0.0.1:${h.port}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (err) => {
        // The server may close the socket right after answering; the status is what counts.
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
        reject(err);
      });
      req.write("x".repeat(20 * 1024));
      req.end();
    });
    expect(status).toBe(413);
  });

  it("answers 400 for a POST with the wrong content type", async () => {
    const h = await bootApi();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      h.clock.advance(1_000); // a new second, so each POST has its own signature (an identical one is a replay)
      const reply = await h.api({ method: "POST", path: "/api/summon", body: { channel: "#a" }, contentType });
      expect(reply.status).toBe(400);
      expect(errorOf(reply.json).code).toBe("bad_content_type");
    }
  });

  it("accepts application/json with a charset", async () => {
    const h = await bootApi();
    const reply = await h.api({ method: "POST", path: "/api/inbox/dismiss", body: { id: "i404" }, contentType: "application/json; charset=utf-8" });
    expect(reply.status).toBe(404);
  });

  it("answers 400 bad_json for a body that is not JSON", async () => {
    const h = await bootApi();
    const reply = await h.api({ method: "POST", path: "/api/summon", body: "{nope" });
    expect(reply.status).toBe(400);
    expect(errorOf(reply.json).code).toBe("bad_json");
  });

  it("keeps /health free of credentials", async () => {
    const h = await bootApi();
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: h.port, path: "/health" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        })
        .on("error", reject);
    });
    expect(reply).toEqual({ status: 200, body: '{"ok":true}' });
  });

  it("serves exactly the paths the route table lists", () => {
    expect([...API_PATHS].sort()).toEqual(["/api/exorcise", "/api/grant-op", "/api/inbox/dismiss", "/api/state", "/api/summary", "/api/summon"]);
  });
});

// A header signed for a different request than the one actually sent.
function signedHeader(nowMs: number, method: string, target: string): string {
  const ts = String(Math.floor(nowMs / 1000));
  return `${ts}:${signProxyRequest(PROXY_SECRET, ts, method, target, Buffer.alloc(0))}`;
}
