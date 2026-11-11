import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkLocalCaller, normalizeOrigin } from "../src/http/guard.js";

const PORT = 9101;
const GATEWAY = "http://127.0.0.1:5476";

// `gatewayOrigin` is passed through as is, so `undefined` really means "KIROCREW_GATEWAY_ORIGIN is unset".
const check = (headers: Record<string, string | string[] | undefined>, ...rest: [gatewayOrigin?: string | undefined]) =>
  checkLocalCaller({ headers }, { port: PORT, gatewayOrigin: rest.length === 0 ? GATEWAY : rest[0] });

describe("Host check", () => {
  it("passes 127.0.0.1:<port> and localhost:<port>, any case", () => {
    expect(check({ host: `127.0.0.1:${PORT}` })).toEqual({ ok: true });
    expect(check({ host: `localhost:${PORT}` })).toEqual({ ok: true });
    expect(check({ host: `LocalHost:${PORT}` })).toEqual({ ok: true });
  });

  it.each([
    ["wrong host", `evil.example:${PORT}`],
    ["no port", "127.0.0.1"],
    ["localhost no port", "localhost"],
    ["wrong port", "127.0.0.1:9100"],
    ["ipv6", `[::1]:${PORT}`],
    ["suffix", `127.0.0.1:${PORT}.evil.example`],
    ["prefix", `x127.0.0.1:${PORT}`],
    ["empty", ""],
  ])("answers 421 for %s", (_name, host) => {
    expect(check({ host })).toEqual({ ok: false, status: 421, code: "bad_host" });
  });

  it("answers 421 when Host is missing", () => {
    expect(check({})).toEqual({ ok: false, status: 421, code: "bad_host" });
  });

  it("answers 421 for a repeated Host header", () => {
    expect(check({ host: [`127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`] })).toEqual({ ok: false, status: 421, code: "bad_host" });
  });

  it("checks Host before Origin", () => {
    expect(check({ host: "evil.example", origin: "http://evil.example" }).ok).toBe(false);
    expect(check({ host: "evil.example", origin: "http://evil.example" })).toMatchObject({ status: 421 });
  });
});

describe("Origin check", () => {
  const host = `127.0.0.1:${PORT}`;

  it("passes when there is no Origin (curl, the MCP client)", () => {
    expect(check({ host })).toEqual({ ok: true });
  });

  it.each(["http://127.0.0.1:5476", "http://localhost:5476", "http://[::1]:5476"])("passes the gateway origin spelled %s", (origin) => {
    expect(check({ host, origin })).toEqual({ ok: true });
  });

  it("normalizes a trailing slash in the configured gateway origin", () => {
    expect(check({ host, origin: "http://localhost:5476" }, "http://127.0.0.1:5476/")).toEqual({ ok: true });
  });

  it.each([
    ["foreign origin", "http://evil.example"],
    ["foreign origin on gateway port", "http://evil.example:5476"],
    ["null origin", "null"],
    ["other port", "http://localhost:5477"],
    ["other scheme", "https://localhost:5476"],
    ["with path", "http://localhost:5476/x"],
    ["with trailing slash", "http://localhost:5476/"],
    ["credentials", "http://user@localhost:5476"],
    ["garbage", "not a url"],
    ["empty", ""],
    ["file", "file://localhost:5476"],
  ])("answers 403 for %s", (_name, origin) => {
    expect(check({ host, origin })).toEqual({ ok: false, status: 403, code: "bad_origin" });
  });

  it("answers 403 for any Origin when KIROCREW_GATEWAY_ORIGIN is unset or unusable", () => {
    expect(check({ host, origin: "http://127.0.0.1:5476" }, undefined)).toEqual({ ok: false, status: 403, code: "bad_origin" });
    expect(check({ host, origin: "http://127.0.0.1:5476" }, "")).toEqual({ ok: false, status: 403, code: "bad_origin" });
    expect(check({ host, origin: "http://127.0.0.1:5476" }, "garbage")).toEqual({ ok: false, status: 403, code: "bad_origin" });
  });

  it("still allows a request without Origin when the gateway origin is unset", () => {
    expect(check({ host }, undefined)).toEqual({ ok: true });
  });

  it("compares a non-loopback gateway origin exactly", () => {
    expect(check({ host, origin: "https://crew.example.org" }, "https://crew.example.org")).toEqual({ ok: true });
    expect(check({ host, origin: "https://other.example.org" }, "https://crew.example.org")).toMatchObject({ status: 403 });
    expect(check({ host, origin: "http://127.0.0.1:443" }, "https://crew.example.org")).toMatchObject({ status: 403 });
  });

  it("treats default ports as equal", () => {
    expect(normalizeOrigin("https://crew.example.org")).toEqual(normalizeOrigin("https://crew.example.org:443"));
  });
});

describe("Property: random Host strings", () => {
  it("never pass unless they match one of the two allowed values exactly (ignoring case)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (host) => {
        const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host.toLowerCase());
        expect(check({ host }).ok).toBe(allowed);
      }),
      { numRuns: 500 },
    );
  });

  it("never pass when built from allowed values with one character changed or appended", () => {
    fc.assert(
      fc.property(fc.constantFrom(`127.0.0.1:${PORT}`, `localhost:${PORT}`), fc.string({ minLength: 1, maxLength: 3 }), (base, extra) => {
        expect(check({ host: `${base}${extra}` }).ok).toBe(false);
        expect(check({ host: `${extra}${base}` }).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
