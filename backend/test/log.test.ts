import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel, type LogLevel } from "../src/log.js";
import { parsePort, PortError } from "../src/port.js";

const capture = (secrets: string[], level: LogLevel = "debug") => {
  const lines: string[] = [];
  const logger = createLogger(secrets, (l) => lines.push(l), () => 1, level);
  return { logger, lines };
};

describe("log level", () => {
  it("defaults to info: debug lines are dropped, info and above are written", () => {
    const lines: string[] = [];
    const logger = createLogger([], (l) => lines.push(l), () => 1);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(["info", "warn", "error"]);
  });

  it("honours every minimum level", () => {
    for (const [level, expected] of [["debug", 4], ["info", 3], ["warn", 2], ["error", 1]] as const) {
      const { logger, lines } = capture([], level);
      logger.debug("x");
      logger.info("x");
      logger.warn("x");
      logger.error("x");
      expect(lines).toHaveLength(expected);
    }
  });

  it("parseLogLevel accepts the four levels and falls back to info", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(" error ")).toBe("error");
    expect(parseLogLevel("info")).toBe("info");
    for (const bad of [undefined, "", "trace", "verbose", "1"]) expect(parseLogLevel(bad)).toBe("info");
  });

  it("still redacts PASS lines at debug level", () => {
    const { logger, lines } = capture(["s3cret"], "debug");
    logger.debug("-> PASS crew:s3cret");
    expect(lines.join("")).toContain("PASS ***");
    expect(lines.join("")).not.toContain("s3cret");
  });
});

describe("createLogger", () => {
  it("replaces secret values in the message and in fields", () => {
    const { logger, lines } = capture(["hunter2-secret"]);
    logger.info("login with hunter2-secret failed", { detail: "x hunter2-secret y", nested: { a: ["hunter2-secret"] } });
    const out = lines.join("\n");
    expect(out).not.toContain("hunter2-secret");
    expect(out).toContain("***");
  });

  it("redacts PASS lines with credentials", () => {
    const { logger, lines } = capture([]);
    logger.debug("PASS crew:abc123");
    logger.debug("sent PASS crew:abc123 to server");
    logger.debug("multi\nPASS other:zzz\nrest");
    const out = lines.join("\n");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).toContain("PASS ***");
  });

  it("redacts secrets added later and secrets inside Error values", () => {
    const { logger, lines } = capture([]);
    logger.addSecret("tok-9f8e7d");
    logger.error("request failed", { err: new Error("GET /config?token=tok-9f8e7d failed") });
    expect(lines.join("")).not.toContain("tok-9f8e7d");
  });

  it("redacts longer secrets before shorter overlapping ones", () => {
    const { logger } = capture(["abc", "abcdef"]);
    expect(logger.redact("x abcdef y")).toBe("x *** y");
  });

  it("ignores empty secrets and leaves ordinary text alone", () => {
    const { logger } = capture([""]);
    expect(logger.redact("nothing to hide")).toBe("nothing to hide");
  });

  it("writes one JSON object per line with level and message", () => {
    const { logger, lines } = capture([]);
    logger.warn("hello", { a: 1 });
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "warn", msg: "hello", a: 1, ts: 1 });
  });
});

describe("parsePort", () => {
  it("accepts a valid port", () => {
    expect(parsePort({ PORT: "9101" })).toBe(9101);
  });

  it.each([undefined, "", "  ", "abc", "0", "65536", "-1", "12.5", "99999999"])("rejects %j with a clear error", (value) => {
    const env: Record<string, string | undefined> = { PORT: value };
    expect(() => parsePort(env)).toThrow(PortError);
    expect(() => parsePort(env)).toThrow(/PORT/);
  });
});
