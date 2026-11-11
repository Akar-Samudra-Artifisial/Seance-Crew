import { describe, expect, it } from "vitest";
import { stripFormatting } from "../src/irc/format.js";
import { parseNotice } from "../src/irc/notices.js";

describe("stripFormatting", () => {
  it("removes a colour code together with its digits (the observed line)", () => {
    expect(stripFormatting("\x0312I couldn't write the file")).toBe("I couldn't write the file");
  });

  it("removes style bytes", () => {
    expect(stripFormatting("\x02a\x1db\x1fc\x1ed\x11e\x16f\x0fg")).toBe("abcdefg");
  });

  it("removes colour with background, and only up to two digits each", () => {
    expect(stripFormatting("\x034,12x")).toBe("x");
    expect(stripFormatting("\x03123")).toBe("3");
    expect(stripFormatting("\x03,5x")).toBe(",5x");
    expect(stripFormatting("a\x03b")).toBe("ab");
  });

  it("removes hex colours with optional background", () => {
    expect(stripFormatting("\x04FF0000red")).toBe("red");
    expect(stripFormatting("\x04ff0000,00FF00both")).toBe("both");
    expect(stripFormatting("\x04plain")).toBe("plain");
  });

  it("leaves other text alone", () => {
    expect(stripFormatting("1,2,3 done")).toBe("1,2,3 done");
  });
});

describe("a denial as a channel notice from the agent", () => {
  const parse = (prefix: string, text: string) => parseNotice({ prefix, target: "#dev", text }, "crew");

  it("parses when the sender is the agent named in the text", () => {
    expect(parse("coder!coder@seance.local", "ops: coder denied Creating NOTES.md: needs-op")).toEqual({
      kind: "denied",
      agent: "coder",
      action: "Creating NOTES.md",
      reason: "needs-op",
      channel: "#dev",
    });
  });

  it("is case-insensitive about the nick", () => {
    expect(parse("Coder!c@h", "ops: coder denied X: needs-op")).toMatchObject({ kind: "denied", channel: "#dev" });
  });

  it("rejects a sender who names somebody else, a bare server prefix, and a service nick", () => {
    expect(parse("mallory!m@evil", "ops: coder denied X: needs-op")).toBeNull();
    expect(parse("seance.local", "ops: coder denied X: needs-op")).toBeNull();
    expect(parse("ChanServ!ChanServ@services.seance.local", "ops: coder denied X: needs-op")).toBeNull();
  });
});
