import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertChannel, assertNick, buildLine, byteLength, LineError } from "../src/irc/line.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof LineError ? err.code : "other";
  }
};

describe("buildLine", () => {
  it("builds a simple line with a trailing parameter", () => {
    expect(buildLine("PRIVMSG", ["#c", "hello world"])).toBe("PRIVMSG #c :hello world\r\n");
    expect(buildLine("nick", ["crew"])).toBe("NICK crew\r\n");
  });

  it("accepts a line of exactly 512 bytes and rejects 513", () => {
    const prefix = "PRIVMSG #c :";
    const fits = "a ".repeat((512 - 2 - prefix.length) / 2);
    const line = buildLine("PRIVMSG", ["#c", fits]);
    expect(byteLength(line)).toBe(512);
    expect(codeOf(() => buildLine("PRIVMSG", ["#c", `${fits}a`]))).toBe("too-long");
  });

  it("counts UTF-8 bytes, not characters", () => {
    const prefix = "PRIVMSG #c :";
    const budget = 512 - 2 - prefix.length;
    const ghosts = "👻".repeat(Math.floor(budget / 4));
    expect(byteLength(buildLine("PRIVMSG", ["#c", ghosts]))).toBeLessThanOrEqual(512);
    expect(codeOf(() => buildLine("PRIVMSG", ["#c", "👻".repeat(Math.floor(budget / 4) + 1)]))).toBe("too-long");
    expect(codeOf(() => buildLine("PRIVMSG", ["#c", "é".repeat(budget)]))).toBe("too-long");
  });

  it.each([
    ["CR", "hi\rQUIT"],
    ["LF", "hi\nQUIT :x"],
    ["CRLF", "hi\r\nJOIN #evil"],
    ["NUL", "hi\0there"],
  ])("rejects %s inside a parameter", (_name, text) => {
    expect(codeOf(() => buildLine("PRIVMSG", ["#c", text]))).toBe("bad-char");
    expect(codeOf(() => buildLine("PRIVMSG", [text, "x"]))).toBe("bad-char");
  });

  it("rejects bad commands and malformed non-last parameters", () => {
    expect(codeOf(() => buildLine("PRIV MSG", ["#c", "x"]))).toBe("bad-command");
    expect(codeOf(() => buildLine("", []))).toBe("bad-command");
    expect(codeOf(() => buildLine("KICK", ["#c d", "x", "y"]))).toBe("bad-param");
    expect(codeOf(() => buildLine("KICK", ["", "x", "y"]))).toBe("bad-param");
  });
});

describe("assertNick and assertChannel", () => {
  it("accepts valid and rejects invalid names with stable codes", () => {
    expect(assertNick("coder")).toBe("coder");
    expect(assertChannel("#crew-demo")).toBe("#crew-demo");
    expect(codeOf(() => assertNick("bad nick"))).toBe("bad-nick");
    expect(codeOf(() => assertNick("a\r\nb"))).toBe("bad-nick");
    expect(codeOf(() => assertNick(""))).toBe("bad-nick");
    expect(codeOf(() => assertChannel("nochannel"))).toBe("bad-channel");
    expect(codeOf(() => assertChannel("#a,#b"))).toBe("bad-channel");
  });
});

describe("Property 1: outbound lines are always valid", () => {
  it("either throws LineError or yields <= 512 bytes with one trailing CRLF and no inner CR, LF or NUL", () => {
    const command = fc.constantFrom("PRIVMSG", "NOTICE", "KICK", "MODE", "INVITE", "WHOIS", "LIST");
    const text = fc.string({ unit: "binary", maxLength: 300 });
    fc.assert(
      fc.property(command, fc.array(text, { maxLength: 17 }), (cmd, params) => {
        let line: string;
        try {
          line = buildLine(cmd, params);
        } catch (err) {
          expect(err).toBeInstanceOf(LineError);
          return;
        }
        expect(byteLength(line)).toBeLessThanOrEqual(512);
        expect(line.endsWith("\r\n")).toBe(true);
        const body = line.slice(0, -2);
        expect(/[\r\n\0]/.test(body)).toBe(false);
        expect(line.split("\r\n").length).toBe(2);
      }),
      { numRuns: 500 },
    );
  });
});
