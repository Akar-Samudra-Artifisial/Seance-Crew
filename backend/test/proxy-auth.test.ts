import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPLAY_WINDOW_MS, ReplayGuard, signProxyRequest, verifyProxyRequest, type ProxyAuthInput } from "../src/api/proxyAuth.js";

interface Vector {
  readonly name: string;
  readonly method: string;
  readonly target: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly header: string;
}
const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "proxy-vectors.json"), "utf8")) as {
  secret: string;
  ts: number;
  vectors: Vector[];
};
const vector = (name: string): Vector => {
  const v = fixture.vectors.find((x) => x.name === name);
  if (v === undefined) throw new Error(`no vector ${name}`);
  return v;
};
const inputFor = (v: Vector, patch: Partial<ProxyAuthInput> = {}): ProxyAuthInput => ({
  header: v.header,
  method: v.method,
  target: v.target,
  body: Buffer.from(v.body, "utf8"),
  secret: fixture.secret,
  nowMs: fixture.ts * 1000,
  ...patch,
});
const rejected = { ok: false, status: 403, code: "invalid_proxy_signature" };

describe("verifyProxyRequest with the gateway's own vectors", () => {
  for (const v of fixture.vectors) {
    it(`accepts ${v.name}`, () => {
      expect(verifyProxyRequest(inputFor(v))).toEqual({ ok: true });
    });
    it(`signs ${v.name} exactly like the gateway`, () => {
      const sig = signProxyRequest(fixture.secret, String(fixture.ts), v.method, v.target, Buffer.from(v.body, "utf8"));
      expect(`${fixture.ts}:${sig}`).toBe(v.header);
    });
  }

  it("uses the empty-body hash e3b0c442… for an empty body", () => {
    expect(vector("empty-body").bodySha256.startsWith("e3b0c442")).toBe(true);
    expect(verifyProxyRequest(inputFor(vector("empty-body")))).toEqual({ ok: true });
  });

  it("rejects the wrong secret", () => {
    expect(verifyProxyRequest(inputFor(vector("get-with-query"), { secret: "another-secret" }))).toEqual(rejected);
  });

  it("rejects a tampered body", () => {
    expect(verifyProxyRequest(inputFor(vector("post-with-body"), { body: Buffer.from('{"channel":"#other"}') }))).toEqual(rejected);
  });

  it("rejects a tampered path", () => {
    expect(verifyProxyRequest(inputFor(vector("get-with-query"), { target: "/api/summary?since=3" }))).toEqual(rejected);
  });

  it("rejects a tampered query", () => {
    expect(verifyProxyRequest(inputFor(vector("get-with-query"), { target: "/api/state?since=4" }))).toEqual(rejected);
  });

  it("rejects a decoded query: the raw request-target is what is signed", () => {
    expect(verifyProxyRequest(inputFor(vector("percent-encoded-query"), { target: "/api/state?since=3&note=a b+cé" }))).toEqual(rejected);
  });

  it("rejects a different method", () => {
    expect(verifyProxyRequest(inputFor(vector("get-with-query"), { method: "POST" }))).toEqual(rejected);
  });

  it("rejects an expired timestamp and a future one, accepts the ±60 s edges", () => {
    const v = vector("get-with-query");
    expect(verifyProxyRequest(inputFor(v, { nowMs: (fixture.ts + 61) * 1000 }))).toEqual(rejected);
    expect(verifyProxyRequest(inputFor(v, { nowMs: (fixture.ts - 61) * 1000 }))).toEqual(rejected);
    expect(verifyProxyRequest(inputFor(v, { nowMs: (fixture.ts + 60) * 1000 }))).toEqual({ ok: true });
    expect(verifyProxyRequest(inputFor(v, { nowMs: (fixture.ts - 60) * 1000 }))).toEqual({ ok: true });
  });

  it("rejects malformed headers", () => {
    const v = vector("get-with-query");
    const sig = v.header.split(":")[1] ?? "";
    for (const header of [undefined, "", "nocolon", `:${sig}`, `${fixture.ts}:`, `${fixture.ts}`, `abc:${sig}`, `-${fixture.ts}:${sig}`, `${fixture.ts}.5:${sig}`, ` ${fixture.ts}:${sig}`]) {
      expect(verifyProxyRequest(inputFor(v, { header }))).toEqual(rejected);
    }
  });

  it("rejects a non-digit timestamp even with a signature computed over it", () => {
    const v = vector("get-with-query");
    const sig = signProxyRequest(fixture.secret, "0x10", v.method, v.target, Buffer.alloc(0));
    expect(verifyProxyRequest(inputFor(v, { header: `0x10:${sig}`, nowMs: 16_000 }))).toEqual(rejected);
  });

  it("rejects a huge timestamp without throwing", () => {
    const v = vector("get-with-query");
    expect(verifyProxyRequest(inputFor(v, { header: `${"9".repeat(400)}:${"a".repeat(64)}` }))).toEqual(rejected);
  });

  it("gives a non-ASCII signature a verdict instead of throwing", () => {
    const v = vector("get-with-query");
    const ts = String(fixture.ts);
    for (const sig of ["é".repeat(32), "é".repeat(64), "\ud800".repeat(64), "𝔰".repeat(16), "a".repeat(63), "a".repeat(65)]) {
      expect(() => verifyProxyRequest(inputFor(v, { header: `${ts}:${sig}` }))).not.toThrow();
      expect(verifyProxyRequest(inputFor(v, { header: `${ts}:${sig}` }))).toEqual(rejected);
    }
  });

  it("answers 503 when the secret is unset or empty, before looking at the header", () => {
    const v = vector("get-with-query");
    const unset = { ok: false, status: 503, code: "proxy_secret_missing" };
    expect(verifyProxyRequest(inputFor(v, { secret: undefined }))).toEqual(unset);
    expect(verifyProxyRequest(inputFor(v, { secret: "" }))).toEqual(unset);
    expect(verifyProxyRequest(inputFor(v, { secret: undefined, header: undefined }))).toEqual(unset);
  });
});

describe("ReplayGuard", () => {
  it("accepts a signature once and rejects it for 120 s", () => {
    const guard = new ReplayGuard();
    expect(guard.accept("1700000000:aaa", 1_000)).toBe(true);
    expect(guard.accept("1700000000:aaa", 2_000)).toBe(false);
    expect(guard.accept("1700000000:aaa", 120_999)).toBe(false);
    expect(guard.accept("1700000000:bbb", 2_000)).toBe(true);
  });

  it("forgets a signature after the window", () => {
    const guard = new ReplayGuard();
    guard.accept("s", 1_000);
    expect(guard.accept("s", 1_000 + REPLAY_WINDOW_MS)).toBe(true);
  });

  it("is bounded: the oldest entry is evicted when the map is full", () => {
    const guard = new ReplayGuard(REPLAY_WINDOW_MS, 3);
    for (const s of ["a", "b", "c", "d"]) guard.accept(s, 1_000);
    expect(guard.size).toBe(3);
    expect(guard.accept("a", 1_001)).toBe(true); // evicted earlier, so it is accepted again
    expect(guard.accept("d", 1_001)).toBe(false);
  });

  it("prunes expired entries so the map does not grow without bound", () => {
    const guard = new ReplayGuard();
    for (let i = 0; i < 500; i++) guard.accept(`old-${i}`, 0);
    guard.accept("new", REPLAY_WINDOW_MS + 1);
    expect(guard.size).toBe(1);
  });
});
