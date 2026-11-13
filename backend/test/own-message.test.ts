// demo-say-fixes Requirement 1: the messages `say` sends appear in the channel log, exactly once.
import { afterEach, describe, expect, it } from "vitest";
import { OWN_ECHO_MS, OWN_MARKER_LIMIT, Store } from "../src/irc/store.js";
import { SAY_LIMIT } from "../src/mcp/guards.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootMcp, cleanupMcp, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const world = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.channels = [{ name: "#fix", count: 2, topic: "", names: ["@crew", "coder"] }];
  return ircd;
};

/** The lines of #fix as the dashboard and `read` see them. */
const linesOf = (h: Awaited<ReturnType<typeof bootMcp>>, channel = "#fix") => h.app.store.channel(channel)?.ring.newest(50) ?? [];
const fromCrew = (h: Awaited<ReturnType<typeof bootMcp>>, text: string) => linesOf(h).filter((l) => l.from === "crew" && l.text === text);

describe("say puts the sent message in the channel log", () => {
  it("adds one privmsg line from our own nick with the text", async () => {
    const h = await bootMcp({ ircd: world() });
    const before = linesOf(h).length;
    const result = await h.call("say", { channel: "#fix", text: "fix the failing test" });
    expect(result.isError).toBeUndefined();
    expect(linesOf(h)).toHaveLength(before + 1);
    expect(linesOf(h).at(-1)).toMatchObject({ from: "crew", kind: "privmsg", text: "fix the failing test" });
  });

  it("keeps the result as it was: { sent: true, channel } and nothing else", async () => {
    const h = await bootMcp({ ircd: world() });
    const result = await h.call("say", { channel: "#fix", text: "hi" });
    expect(result.structuredContent).toEqual({ sent: true, channel: "#fix" });
  });

  it("shows it to the read tool and in /api/state lines", async () => {
    const h = await bootMcp({ ircd: world() });
    await h.call("say", { channel: "#fix", text: "hello coder" });
    expect(textOf(await h.call("read", { channel: "#fix" }))).toContain("hello coder");
    const lines = (await import("../src/api/state.js")).buildState(h.app.store, h.app.bridge).channels.find((c) => c.name === "#fix")?.lines ?? [];
    expect(lines.filter((l) => l.from === "crew" && l.text === "hello coder")).toHaveLength(1);
  });

  it("logs the message once when the server also echoes it", async () => {
    const h = await bootMcp({ ircd: world() });
    await h.call("say", { channel: "#fix", text: "once only" });
    h.ircd.sendLines(h.ircd.last, [":crew!u@h PRIVMSG #fix :once only"]);
    h.ircd.run();
    expect(fromCrew(h, "once only")).toHaveLength(1);
    // The marker is used up by the echo: a second identical line from us is a new message.
    h.ircd.sendLines(h.ircd.last, [":crew!u@h PRIVMSG #fix :once only"]);
    h.ircd.run();
    expect(fromCrew(h, "once only")).toHaveLength(2);
  });

  it("adds a same-text line from our nick that arrives after the 30 s window", async () => {
    const h = await bootMcp({ ircd: world() });
    await h.call("say", { channel: "#fix", text: "late" });
    h.advance(OWN_ECHO_MS + 1_000);
    h.ircd.sendLines(h.ircd.last, [":crew!u@h PRIVMSG #fix :late"]);
    h.ircd.run();
    expect(fromCrew(h, "late")).toHaveLength(2);
  });

  it("never swallows the same text from another nick", async () => {
    const h = await bootMcp({ ircd: world() });
    await h.call("say", { channel: "#fix", text: "same words" });
    h.ircd.sendLines(h.ircd.last, [":coder!u@h PRIVMSG #fix :same words"]);
    h.ircd.run();
    expect(linesOf(h).filter((l) => l.text === "same words").map((l) => l.from)).toEqual(["crew", "coder"]);
  });

  it("does not swallow an echo for another channel", async () => {
    const ircd = world();
    ircd.channels.push({ name: "#other", count: 1, topic: "", names: ["@crew"] });
    const h = await bootMcp({ ircd });
    await h.call("say", { channel: "#fix", text: "x" });
    h.ircd.sendLines(h.ircd.last, [":crew!u@h PRIVMSG #other :x"]);
    h.ircd.run();
    expect(linesOf(h, "#other").filter((l) => l.text === "x")).toHaveLength(1);
  });

  it("matches an echo that carries IRC formatting codes (the log text is cleaned the same way on both paths)", async () => {
    const h = await bootMcp({ ircd: world() });
    await h.call("say", { channel: "#fix", text: "blue text" });
    h.ircd.sendLines(h.ircd.last, [":crew!u@h PRIVMSG #fix :\u000312blue\u000f text"]);
    h.ircd.run();
    expect(fromCrew(h, "blue text")).toHaveLength(1);
  });
});

describe("no line for a message that was not sent", () => {
  it.each([
    ["an invalid text (control character)", { channel: "#fix", text: "a\u0007b" }],
    ["a text over 400 characters", { channel: "#fix", text: "a".repeat(401) }],
    ["a bad channel name", { channel: "fix", text: "hi" }],
  ])("%s", async (_name, args) => {
    const h = await bootMcp({ ircd: world() });
    const before = linesOf(h).length;
    expect((await h.call("say", args)).isError).toBe(true);
    expect(linesOf(h)).toHaveLength(before);
  });

  it("a rate-limited say adds no line", async () => {
    const h = await bootMcp({ ircd: world() });
    for (let i = 0; i < SAY_LIMIT; i += 1) expect((await h.call("say", { channel: "#fix", text: `m${i}` })).isError).toBeUndefined();
    const before = linesOf(h).length;
    const refused = await h.call("say", { channel: "#fix", text: "one too many" });
    expect(refused.isError).toBe(true);
    expect(linesOf(h)).toHaveLength(before);
    expect(fromCrew(h, "one too many")).toHaveLength(0);
  });

  it("a say while the bridge is not registered adds no line and creates no channel", async () => {
    const ircd = world();
    ircd.stallRegistration = true;
    const h = await bootMcp({ ircd });
    expect((await h.call("say", { channel: "#fix", text: "hi" })).isError).toBe(true);
    expect(h.app.store.channel("#fix")).toBeUndefined();
  });

  it("a say to a channel the store does not track is sent but creates no channel and no line", async () => {
    const h = await bootMcp({ ircd: world() });
    const before = h.app.store.allChannels().length;
    const result = await h.call("say", { channel: "#unknown", text: "anyone?" });
    expect(result.isError).toBeUndefined(); // the server may know the channel; we just do not track it
    h.advance(15_000);
    expect(h.sent().filter((l) => l.startsWith("PRIVMSG"))).toEqual(["PRIVMSG #unknown anyone?"]);
    expect(h.app.store.channel("#unknown")).toBeUndefined();
    expect(h.app.store.allChannels()).toHaveLength(before);
  });
});

describe("Store own-message markers", () => {
  const make = () => {
    const clock = new FakeClock();
    const store = new Store(clock);
    store.ownNick = "crew";
    store.ensureChannel("#a");
    return { clock, store };
  };

  it("returns null for an untracked channel and the line for a tracked one", () => {
    const { store } = make();
    expect(store.addOwnMessage("#nope", "x")).toBeNull();
    expect(store.addOwnMessage("#a", "x")).toMatchObject({ from: "crew", kind: "privmsg", text: "x" });
  });

  it("strips IRC formatting codes from the line, and an echo with codes still matches", () => {
    const { store } = make();
    expect(store.addOwnMessage("#a", "\u000312blue\u000f text")?.text).toBe("blue text");
    expect(store.consumeOwnEcho("#a", "\u0002blue\u0002 text")).toBe(true);
  });

  it("matches the channel case-insensitively and consumes the marker once", () => {
    const { store } = make();
    store.addOwnMessage("#a", "hello");
    expect(store.consumeOwnEcho("#A", "hello")).toBe(true);
    expect(store.consumeOwnEcho("#a", "hello")).toBe(false);
  });

  it("forgets a marker after 30 s", () => {
    const { clock, store } = make();
    store.addOwnMessage("#a", "old");
    clock.advance(OWN_ECHO_MS - 1);
    expect(store.consumeOwnEcho("#a", "old")).toBe(true);
    store.addOwnMessage("#a", "older");
    clock.advance(OWN_ECHO_MS);
    expect(store.consumeOwnEcho("#a", "older")).toBe(false);
  });

  it("keeps at most 20 markers: the oldest are forgotten first", () => {
    const { store } = make();
    for (let i = 0; i < OWN_MARKER_LIMIT + 5; i += 1) store.addOwnMessage("#a", `m${i}`);
    expect(store.consumeOwnEcho("#a", "m0")).toBe(false); // dropped
    expect(store.consumeOwnEcho("#a", "m4")).toBe(false); // dropped
    expect(store.consumeOwnEcho("#a", "m5")).toBe(true); // the oldest kept
    expect(store.consumeOwnEcho("#a", `m${OWN_MARKER_LIMIT + 4}`)).toBe(true);
    expect(OWN_MARKER_LIMIT).toBe(20);
  });
});
