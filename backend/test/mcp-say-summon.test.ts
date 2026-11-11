import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootMcp, cleanupMcp, eventually, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const structured = (r: { structuredContent?: Readonly<Record<string, unknown>> }) => r.structuredContent as Record<string, unknown>;

/** Lines the bridge sent after `baseline` (the handshake and rebuild are excluded by the caller). */
const since = (all: readonly string[], baseline: number): string[] => all.slice(baseline);

describe("say", () => {
  it("sends exactly one PRIVMSG and returns { sent: true }", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    const result = await h.call("say", { channel: "#fix", text: "hello there" });
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ sent: true, channel: "#fix" });
    expect(since(h.sent(), base)).toEqual(["PRIVMSG #fix :hello there"]);
  });

  it("accepts 400 ASCII characters and rejects 401", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    expect((await h.call("say", { channel: "#fix", text: "a".repeat(400) })).isError).toBeUndefined();
    expect((await h.call("say", { channel: "#fix", text: "a".repeat(401) })).isError).toBe(true);
    expect(since(h.sent(), base)).toHaveLength(1);
  });

  it("rejects multibyte text that would push the line over 512 bytes and sends nothing", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    const result = await h.call("say", { channel: "#fix", text: "é".repeat(300) }); // 300 chars, 600 bytes
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too-long");
    expect(since(h.sent(), base)).toEqual([]);
  });

  it("accepts multibyte text that fits", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    expect((await h.call("say", { channel: "#fix", text: "é".repeat(200) })).isError).toBeUndefined();
    expect(since(h.sent(), base)).toHaveLength(1);
  });

  it.each([
    ["empty", { channel: "#fix", text: "" }],
    ["CR", { channel: "#fix", text: "a\rb" }],
    ["LF injection", { channel: "#fix", text: "hi\nQUIT :bye" }],
    ["NUL", { channel: "#fix", text: "a\u0000b" }],
    ["bad channel", { channel: "fix", text: "hi" }],
    ["channel with comma", { channel: "#a,#b", text: "hi" }],
    ["missing text", { channel: "#fix" }],
    ["number text", { channel: "#fix", text: 5 }],
    ["extra key", { channel: "#fix", text: "hi", target: "x" }],
  ])("refuses %s without sending", async (_name, args) => {
    const h = await bootMcp();
    const base = h.sent().length;
    const result = await h.call("say", args);
    expect(result.isError).toBe(true);
    expect(since(h.sent(), base)).toEqual([]);
  });

  it("states the bridge state and sends nothing when not registered", async () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const h = await bootMcp({ ircd });
    const result = await h.call("say", { channel: "#fix", text: "hi" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connecting");
    expect(ircd.allLines.some((l) => l.startsWith("PRIVMSG"))).toBe(false);
  });

  it("goes through the send queue: a flood is rate limited, not dropped", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    for (let i = 0; i < 12; i++) await h.call("say", { channel: "#fix", text: `m${i}` });
    expect(since(h.sent(), base).length).toBeLessThan(12);
    h.advance(10_000);
    expect(since(h.sent(), base)).toHaveLength(12);
  });

  it("Property: any text either is refused or becomes one valid PRIVMSG line (no CR, LF, NUL; at most 512 bytes)", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 450 }), async (text) => {
        const result = await h.call("say", { channel: "#fix", text });
        if (result.isError !== true) accepted += 1;
        h.advance(1_000);
      }),
      { numRuns: 80 },
    );
    const lines = since(h.sent(), base);
    expect(lines).toHaveLength(accepted);
    for (const line of lines) {
      expect(line.startsWith("PRIVMSG #fix")).toBe(true);
      expect(/[\r\n\0]/.test(line)).toBe(false);
      expect(Buffer.byteLength(line) + 2).toBeLessThanOrEqual(512);
    }
  });
});

const inviteHook = (ircd: FakeIrcd, reply: (nick: string, channel: string) => string | null): void => {
  ircd.hooks.push((m, conn, d) => {
    if (m.command !== "INVITE") return;
    const line = reply(m.params[0] ?? "", m.params[1] ?? "");
    if (line !== null) d.reply(conn, line);
  });
};

const readyNotice = (agent: string, channel: string) => `:ChanServ!c@s NOTICE ${channel} :${agent} is ready`;

describe("summon", () => {
  it("sends INVITE coder <channel> by default and returns ready: true", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const base = h.sent().length;
    const result = await h.call("summon", { channel: "#fix" });
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ ready: true, channel: "#fix", agent: "coder" });
    expect(since(h.sent(), base).filter((l) => l.startsWith("INVITE"))).toEqual(["INVITE coder #fix"]);
  });

  it("invites a named agent", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const base = h.sent().length;
    const result = await h.call("summon", { channel: "#fix", agent: "reviewer", confirm: true });
    expect(structured(result)["ready"]).toBe(true);
    expect(since(h.sent(), base).filter((l) => l.startsWith("INVITE"))).toEqual(["INVITE reviewer #fix"]);
  });

  it("ignores the ready notice of another agent or channel and times out after 20 s with ready: false", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (_nick, channel) => `${readyNotice("someone-else", channel)}\r\n${readyNotice("coder", "#other")}`);
    const h = await bootMcp({ ircd });
    const pending = h.call("summon", { channel: "#fix" });
    await eventually(() => h.sent().includes("INVITE coder #fix"));
    h.clock.advance(19_999);
    h.clock.advance(1);
    const result = await pending;
    expect(result.isError, textOf(result)).toBeUndefined();
    expect(structured(result)).toMatchObject({ ready: false, waitedSec: 20, agent: "coder" });
  });

  it.each(["482", "473"])("maps %s to an error that points at SEANCE_INVITERS", async (numeric) => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (_n, channel) => `:seance.local ${numeric} crew ${channel} :refused`);
    const h = await bootMcp({ ircd });
    const result = await h.call("summon", { channel: "#fix" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SEANCE_INVITERS");
    expect(textOf(result)).toContain(numeric);
  });

  it("maps 403 (unknown channel) and 442 (not in the channel)", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (_n, channel) => `:seance.local 403 crew ${channel} :No such channel`);
    const h = await bootMcp({ ircd });
    const unknownChannel = await h.call("summon", { channel: "#nowhere" });
    expect(unknownChannel.isError).toBe(true);
    expect(textOf(unknownChannel)).toContain("#nowhere");
    await cleanupMcp();

    const ircd2 = new FakeIrcd();
    inviteHook(ircd2, (_n, channel) => `:seance.local 442 crew ${channel} :You're not on that channel`);
    const h2 = await bootMcp({ ircd: ircd2 });
    const notIn = await h2.call("summon", { channel: "#fix" });
    expect(notIn.isError).toBe(true);
    expect(textOf(notIn)).toContain("442");
  });

  it("does not mistake the 401 of a WHOIS for a refused invite", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd }); // no whois entry for coder: the ready notice triggers a WHOIS that answers 401
    const result = await h.call("summon", { channel: "#fix" });
    expect(result.isError).toBeUndefined();
    expect(structured(result)["ready"]).toBe(true);
  });

  it("removes its listeners and timers after every outcome", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const count = () => ["ready", "server-error", "state"].reduce((n, t) => n + h.app.store.listenerCount(t as "ready"), 0);
    const listeners = count();
    const timers = h.clock.pending;
    await h.call("summon", { channel: "#fix" });
    expect(count()).toBe(listeners);
    expect(h.clock.pending).toBe(timers);
  });

  it("stops waiting when the connection drops", async () => {
    const ircd = new FakeIrcd();
    const h = await bootMcp({ ircd });
    const pending = h.call("summon", { channel: "#fix" });
    await eventually(() => h.sent().includes("INVITE coder #fix"));
    ircd.drop(ircd.last);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/connection was lost/);
  });

  it("refuses when not registered, and for invalid arguments, without sending", async () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const stalled = await bootMcp({ ircd });
    expect((await stalled.call("summon", { channel: "#fix" })).isError).toBe(true);
    expect(ircd.allLines.some((l) => l.startsWith("INVITE"))).toBe(false);
    await cleanupMcp();

    const h = await bootMcp();
    for (const args of [{}, { channel: "fix" }, { channel: "#fix", agent: "a b" }, { channel: "#fix", agent: "x\r\nQUIT" }, { channel: "#fix", agent: "" }]) {
      expect((await h.call("summon", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(h.ircd.allLines.some((l) => l.startsWith("INVITE"))).toBe(false);
  });
});

describe("summon joins first (Séance only accepts INVITE from a member)", () => {
  const cmds = (lines: readonly string[]): string[] => lines.filter((l) => /^(JOIN|INVITE) /.test(l));

  it("not a member: sends JOIN, waits for our JOIN and 366, then INVITE", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const base = h.sent().length;
    const result = await h.call("summon", { channel: "#fresh" });
    expect(result.isError).toBeUndefined();
    expect(structured(result)["ready"]).toBe(true);
    expect(cmds(since(h.sent(), base))).toEqual(["JOIN #fresh", "INVITE coder #fresh"]);
  });

  it("already a member: sends INVITE only", async () => {
    const ircd = new FakeIrcd();
    ircd.channels = [{ name: "#fix", topic: "", count: 1, names: ["@crew"] }];
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const base = h.sent().length;
    const result = await h.call("summon", { channel: "#fix" });
    expect(result.isError).toBeUndefined();
    expect(cmds(since(h.sent(), base))).toEqual(["INVITE coder #fix"]);
  });

  it.each(["471", "473", "474", "475", "403"])("JOIN refused with %s: clear error and no INVITE", async (numeric) => {
    const ircd = new FakeIrcd();
    ircd.joinRefusals["#closed"] = numeric;
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    const result = await h.call("summon", { channel: "#closed" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`(${numeric})`);
    expect(textOf(result)).toContain("No invite was sent");
    expect(ircd.allLines.some((l) => l.startsWith("INVITE"))).toBe(false);
  });

  it("times out after 10 s when the server never answers the JOIN, and sends no INVITE", async () => {
    const ircd = new FakeIrcd();
    ircd.joinRefusals["#silent"] = ""; // the fake never answers this JOIN
    const h = await bootMcp({ ircd });
    const pending = h.call("summon", { channel: "#silent" });
    await eventually(() => h.sent().includes("JOIN #silent"));
    h.clock.advance(10_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
    expect(ircd.allLines.some((l) => l.startsWith("INVITE"))).toBe(false);
  });

  it("does not re-join after a reconnect", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootMcp({ ircd });
    await h.call("summon", { channel: "#fresh" });
    ircd.drop(ircd.last);
    h.advance(60_000);
    expect(ircd.connections.length).toBeGreaterThan(1);
    expect(ircd.last.received.some((l) => l.startsWith("JOIN"))).toBe(false);
  });
});

describe("summon guard (review fix 6)", () => {
  const readyHook = (): FakeIrcd => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    return ircd;
  };

  it.each([
    ["missing", {}],
    ["false", { confirm: false }],
    ["string true", { confirm: "true" }],
    ["number 1", { confirm: 1 }],
  ])("refuses an agent other than coder with confirm %s and sends nothing", async (_name, extra) => {
    const h = await bootMcp({ ircd: readyHook() });
    const result = await h.call("summon", { channel: "#fix", agent: "reviewer", ...extra });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("confirm: true is required");
    expect(textOf(result)).toContain("coder");
    expect(h.ircd.allLines.some((l) => l.startsWith("INVITE"))).toBe(false);
  });

  it("needs no confirm for coder, in any spelling", async () => {
    const h = await bootMcp({ ircd: readyHook() });
    expect((await h.call("summon", { channel: "#fix", agent: "Coder" })).isError).toBeUndefined();
  });

  it("allows 3 summons per channel per 10 minutes and explains the limit", async () => {
    const h = await bootMcp({ ircd: readyHook() });
    for (let i = 0; i < 3; i++) {
      h.advance(2_000);
      expect((await h.call("summon", { channel: "#fix" })).isError, `call ${i + 1}`).toBeUndefined();
    }
    const base = h.ircd.allLines.filter((l) => l.startsWith("INVITE")).length;
    const fourth = await h.call("summon", { channel: "#fix" });
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/Rate limit: summon is limited to 3 calls per channel per 10 minutes/);
    expect(h.ircd.allLines.filter((l) => l.startsWith("INVITE"))).toHaveLength(base);
    // Another channel has its own budget; the window slides after 10 minutes.
    h.advance(2_000);
    expect((await h.call("summon", { channel: "#other" })).isError).toBeUndefined();
    h.advance(10 * 60_000);
    expect((await h.call("summon", { channel: "#fix" })).isError).toBeUndefined();
  });

  it("does not count refused calls against the limit", async () => {
    const h = await bootMcp({ ircd: readyHook() });
    for (let i = 0; i < 5; i++) await h.call("summon", { channel: "#fix", agent: "reviewer" }); // unconfirmed
    h.advance(2_000);
    expect((await h.call("summon", { channel: "#fix" })).isError).toBeUndefined();
  });

  it("advertises confirm in the schema without requiring it", async () => {
    const h = await bootMcp();
    const reply = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (reply.body as { result: { tools: Array<{ name: string; description: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }> } }).result.tools;
    const summon = tools.find((t) => t.name === "summon");
    expect(summon?.inputSchema.properties["confirm"]).toBeDefined();
    expect(summon?.inputSchema.required).toEqual(["channel"]);
    expect(summon?.description).toContain("confirm: true");
  });
});

describe("say rate limit (review fix 6)", () => {
  it("allows 20 lines per minute in total, across channels, and explains the limit", async () => {
    const h = await bootMcp();
    const base = h.sent().length;
    for (let i = 0; i < 20; i++) {
      const r = await h.call("say", { channel: i % 2 === 0 ? "#fix" : "#other", text: `m${i}` });
      expect(r.isError, `line ${i + 1}`).toBeUndefined();
    }
    const refused = await h.call("say", { channel: "#fix", text: "one too many" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Rate limit: say is limited to 20 lines per minute in total/);
    h.advance(30_000);
    expect((await h.call("say", { channel: "#fix", text: "still too soon" })).isError).toBe(true);
    h.advance(31_000);
    expect((await h.call("say", { channel: "#fix", text: "now fine" })).isError).toBeUndefined();
    h.advance(60_000);
    expect(h.sent().slice(base).filter((l) => l.startsWith("PRIVMSG"))).toHaveLength(21);
  });

  it("does not count lines that failed validation", async () => {
    const h = await bootMcp();
    for (let i = 0; i < 30; i++) await h.call("say", { channel: "#fix", text: "" });
    expect((await h.call("say", { channel: "#fix", text: "ok" })).isError).toBeUndefined();
  });
});
