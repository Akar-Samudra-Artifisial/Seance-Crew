import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bool, channel, enumOf, int, nick, object, optional, string } from "../src/mcp/validate.js";

const errorOf = (r: { ok: boolean; error?: string }): string => (r.ok ? "" : (r.error ?? ""));

describe("string", () => {
  const f = string({ min: 1, max: 5 });
  it("accepts text within bounds", () => {
    expect(f.check("abc", "text")).toEqual({ ok: true, value: "abc" });
    expect(f.check("a", "text").ok).toBe(true);
    expect(f.check("abcde", "text").ok).toBe(true);
  });
  it("rejects too short, too long and non-strings, naming the property", () => {
    expect(errorOf(f.check("", "text"))).toMatch(/^text: .*at least 1/);
    expect(errorOf(f.check("abcdef", "text"))).toMatch(/^text: .*at most 5/);
    expect(errorOf(f.check(5, "text"))).toMatch(/^text: must be a string/);
    expect(errorOf(f.check(undefined, "text"))).toMatch(/^text:/);
  });
  it.each(["a\rb", "a\nb", "a\u0000b"])("rejects CR, LF and NUL (%j)", (value) => {
    expect(errorOf(string().check(value, "text"))).toMatch(/CR, LF or NUL/);
  });
  it("counts characters, not UTF-16 units", () => {
    expect(string({ max: 2 }).check("😀😀", "t").ok).toBe(true);
    expect(string({ max: 2 }).check("😀😀😀", "t").ok).toBe(false);
  });
  it("describes itself as JSON Schema", () => {
    expect(f.schema()).toEqual({ type: "string", minLength: 1, maxLength: 5 });
  });
});

describe("int", () => {
  const f = int({ min: 1, max: 200 });
  it("accepts integers in range", () => {
    expect(f.check(1, "limit").ok).toBe(true);
    expect(f.check(200, "limit").ok).toBe(true);
  });
  it.each([0, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, true])("rejects %j", (value) => {
    const r = f.check(value, "limit");
    expect(r.ok).toBe(false);
    expect(errorOf(r)).toMatch(/^limit:/);
  });
  it("describes itself", () => {
    expect(f.schema()).toEqual({ type: "integer", minimum: 1, maximum: 200 });
  });
});

describe("bool and enumOf", () => {
  it("accepts only booleans", () => {
    expect(bool().check(true, "confirm").ok).toBe(true);
    expect(bool().check(false, "confirm").ok).toBe(true);
    for (const v of ["true", 1, 0, null, {}]) expect(errorOf(bool().check(v, "confirm"))).toMatch(/^confirm: must be a boolean/);
  });
  it("accepts only listed values", () => {
    const f = enumOf(["+v", "-v", "+o", "-o"]);
    expect(f.check("+o", "mode").ok).toBe(true);
    expect(errorOf(f.check("+b", "mode"))).toMatch(/^mode: must be one of \+v, -v, \+o, -o/);
    expect(f.check(1, "mode").ok).toBe(false);
    expect(f.schema()).toEqual({ type: "string", enum: ["+v", "-v", "+o", "-o"] });
  });
});

describe("channel and nick", () => {
  it("use the vendored validators", () => {
    expect(channel().check("#fix-bug", "channel").ok).toBe(true);
    for (const v of ["fix-bug", "#", "#a b", "#a,b", "#a\u0007b", 5]) expect(errorOf(channel().check(v, "channel"))).toMatch(/^channel:/);
    expect(nick().check("coder", "agent").ok).toBe(true);
    for (const v of ["", "a b", "a,b", "9abc", "#chan", 5]) expect(errorOf(nick().check(v, "agent"))).toMatch(/^agent:/);
  });
  it("shorten long rejected values in the message", () => {
    const message = errorOf(channel().check(`x${"y".repeat(500)}`, "channel"));
    expect(message.length).toBeLessThan(120);
  });
});

describe("object", () => {
  const schema = object({ channel: channel(), limit: optional(int({ min: 1, max: 200 })), text: string({ min: 1, max: 10 }) });

  it("returns the typed value and leaves absent optionals out", () => {
    const r = schema.parse({ channel: "#c", text: "hi" });
    expect(r).toEqual({ ok: true, value: { channel: "#c", text: "hi" } });
    if (r.ok) expect("limit" in r.value).toBe(false);
  });

  it("treats an explicit undefined optional as absent but still validates present ones", () => {
    expect(schema.parse({ channel: "#c", text: "hi", limit: undefined }).ok).toBe(true);
    expect(errorOf(schema.parse({ channel: "#c", text: "hi", limit: 0 }))).toMatch(/^limit:/);
  });

  it("names the missing property", () => {
    expect(errorOf(schema.parse({ channel: "#c" }))).toBe("text: is required");
  });

  it.each([null, [], "x", 5, true])("rejects a non-object (%j)", (value) => {
    expect(errorOf(schema.parse(value))).toMatch(/must be an object/);
  });

  it("rejects unknown properties", () => {
    expect(errorOf(schema.parse({ channel: "#c", text: "hi", extra: 1 }))).toMatch(/unknown property "extra"/);
  });

  it("does not let prototype keys through", () => {
    const polluted = JSON.parse('{"channel":"#c","text":"hi","__proto__":{"x":1}}') as unknown;
    expect(schema.parse(polluted).ok).toBe(false);
    expect(errorOf(schema.parse({ channel: "#c", text: "hi", constructor: 1 }))).toMatch(/unknown property/);
  });

  it("produces JSON Schema with required and additionalProperties false", () => {
    expect(schema.jsonSchema()).toEqual({
      type: "object",
      properties: {
        channel: { type: "string", minLength: 2, maxLength: 200, pattern: "^#", description: "Channel name, for example #fix-bug" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        text: { type: "string", minLength: 1, maxLength: 10 },
      },
      required: ["channel", "text"],
      additionalProperties: false,
    });
  });

  it("omits required when every field is optional", () => {
    expect(object({ a: optional(bool()) }).jsonSchema()).toEqual({ type: "object", properties: { a: { type: "boolean" } }, additionalProperties: false });
  });

  it("accepts an empty object for a schema without fields", () => {
    expect(object({}).parse({}).ok).toBe(true);
    expect(object({}).parse({ a: 1 }).ok).toBe(false);
  });
});

describe("Property: unknown keys always fail", () => {
  const schema = object({ channel: channel(), text: optional(string({ max: 10 })) });
  it("rejects any extra key, whatever its value", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== "channel" && k !== "text"),
        fc.anything(),
        (key, value) => {
          const input = Object.defineProperty({ channel: "#c" } as Record<string, unknown>, key, { value, enumerable: true, configurable: true, writable: true });
          expect(schema.parse(input).ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
