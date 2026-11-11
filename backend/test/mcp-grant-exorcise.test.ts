import { afterEach, describe, expect, it } from "vitest";
import { CONFIRM_REFUSAL, DEFAULT_EXORCISE_REASON } from "../src/mcp/act-tools.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootMcp, cleanupMcp, echoKicks, echoModes, eventually, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const structured = (r: { structuredContent?: Readonly<Record<string, unknown>> }) => r.structuredContent as Record<string, unknown>;

const world = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.channels = [{ name: "#fix", count: 2, topic: "", names: ["@crew", "+coder"] }];
  ircd.whois = { coder: { info: ["model: claude"] } };
  echoModes(ircd);
  echoKicks(ircd);
  return ircd;
};

/** Lines sent after the harness settled, limited to commands of interest. */
const sentOf = (h: { sent(): string[] }, prefix: string): string[] => h.sent().filter((l) => l.startsWith(prefix));

const BAD_CONFIRM: Array<[string, Record<string, unknown>]> = [
  ["missing", {}],
  ["false", { confirm: false }],
  ["string true", { confirm: "true" }],
  ["number 1", { confirm: 1 }],
  ["null", { confirm: null }],
  ["object", { confirm: {} }],
  ["array", { confirm: [true] }],
];

describe("grant_op", () => {
  const args = (extra: Record<string, unknown> = {}) => ({ channel: "#fix", agent: "coder", mode: "+o", ...extra });

  it.each(BAD_CONFIRM)("refuses confirm %s with the confirmation message and sends nothing", async (_name, extra) => {
    const h = await bootMcp({ ircd: world() });
    const result = await h.call("grant_op", args(extra));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(CONFIRM_REFUSAL);
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it("sends exactly one MODE line with confirm: true", async () => {
    const h = await bootMcp({ ircd: world() });
    const result = await h.call("grant_op", args({ confirm: true }));
    expect(result.isError).toBeUndefined();
    expect(sentOf(h, "MODE")).toEqual(["MODE #fix +o coder"]);
    expect(structured(result)).toMatchObject({ applied: true, channel: "#fix", agent: "coder", mode: "+o" });
  });

  it.each(["+v", "-v", "+o", "-o"])("sends MODE #fix %s coder", async (mode) => {
    const h = await bootMcp({ ircd: world() });
    await h.call("grant_op", args({ mode, confirm: true }));
    expect(sentOf(h, "MODE")).toEqual([`MODE #fix ${mode} coder`]);
  });

  it("marks the open inbox items of that channel and agent as granted after +o, and leaves others alone", async () => {
    const h = await bootMcp({ ircd: world() });
    const ircd = h.ircd;
    ircd.sendLines(ircd.last, [
      ":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op",
      ":seance.local NOTICE crew :ops: other denied Edit file: needs-op",
    ]);
    ircd.run();
    const store = h.app.store;
    expect(store.openInbox()).toHaveLength(2); // "other" shares no channel with us, so its item has no channel
    const result = await h.call("grant_op", args({ confirm: true }));
    expect(structured(result)["inboxResolved"]).toBe(1);
    expect(store.inbox().find((i) => i.agent === "coder")?.status).toBe("granted");
    expect(store.inbox().find((i) => i.agent === "other")?.status).toBe("open");
    expect(textOf(result)).toContain("inbox");
  });

  it("does not touch the inbox for +v, -o or -v", async () => {
    const h = await bootMcp({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op"]);
    h.ircd.run();
    for (const mode of ["+v", "-v", "-o"]) {
      h.advance(2_000); // the send queue refills one token per second of fake time
      expect((await h.call("grant_op", args({ mode, confirm: true }))).isError).toBeUndefined();
    }
    expect(h.app.store.openInbox()).toHaveLength(1);
  });

  it("does not mark items granted when the call was refused", async () => {
    const h = await bootMcp({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op"]);
    h.ircd.run();
    await h.call("grant_op", args({ confirm: false }));
    await h.call("grant_op", args({ mode: "+b", confirm: true }));
    expect(h.app.store.openInbox()).toHaveLength(1);
  });

  it.each([
    ["bad mode", { mode: "+b" }],
    ["mode with space", { mode: "+o coder" }],
    ["bad channel", { channel: "fix" }],
    ["bad agent", { agent: "a b" }],
    ["CRLF agent", { agent: "coder\r\nQUIT" }],
    ["extra key", { extra: 1 }],
  ])("rejects %s without sending", async (_name, extra) => {
    const h = await bootMcp({ ircd: world() });
    const result = await h.call("grant_op", args({ confirm: true, ...extra }));
    expect(result.isError).toBe(true);
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it("states the bridge state when not registered", async () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const h = await bootMcp({ ircd });
    const result = await h.call("grant_op", args({ confirm: true }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connecting");
    expect(ircd.allLines.some((l) => l.startsWith("MODE"))).toBe(false);
  });
});

describe("exorcise", () => {
  const args = (extra: Record<string, unknown> = {}) => ({ channel: "#fix", agent: "coder", ...extra });
  const closeOnKick = (ircd: FakeIrcd, text = "session closed, worktree reset to abc1234"): void => {
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, `:ChanServ!c@s NOTICE ${m.params[0] ?? ""} :${text}`);
    });
  };

  it.each(BAD_CONFIRM)("refuses confirm %s with the confirmation message and sends nothing", async (_name, extra) => {
    const h = await bootMcp({ ircd: world() });
    const result = await h.call("exorcise", args(extra));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(CONFIRM_REFUSAL);
    expect(sentOf(h, "KICK")).toEqual([]);
  });

  it("kicks with the default reason and waits for the session-closed notice", async () => {
    const ircd = world();
    closeOnKick(ircd);
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", args({ confirm: true }));
    expect(result.isError).toBeUndefined();
    expect(sentOf(h, "KICK")).toEqual([`KICK #fix coder :${DEFAULT_EXORCISE_REASON}`]);
    expect(structured(result)).toMatchObject({ kicked: true, sessionClosed: true, cancelled: false, sha: "abc1234" });
  });

  it("uses a custom reason and reports a cancelled session", async () => {
    const ircd = world();
    closeOnKick(ircd, "session cancelled, worktree reset to def5678");
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", args({ reason: "all done here", confirm: true }));
    expect(sentOf(h, "KICK")).toEqual(["KICK #fix coder :all done here"]);
    expect(structured(result)).toMatchObject({ cancelled: true, sha: "def5678" });
  });

  it("accepts a 200 character reason and rejects 201 or line breaks", async () => {
    const ircd = world();
    closeOnKick(ircd);
    const h = await bootMcp({ ircd });
    expect((await h.call("exorcise", args({ reason: "r".repeat(200), confirm: true }))).isError).toBeUndefined();
    const before = sentOf(h, "KICK").length;
    for (const reason of ["r".repeat(201), "bye\r\nQUIT :x", "bye\nJOIN #x", "a\u0000b"]) {
      expect((await h.call("exorcise", args({ reason, confirm: true }))).isError, JSON.stringify(reason)).toBe(true);
    }
    expect(sentOf(h, "KICK")).toHaveLength(before);
  });

  it("times out after 10 seconds without error: the kick was sent, the session state is unknown", async () => {
    const h = await bootMcp({ ircd: world() });
    const pending = h.call("exorcise", args({ confirm: true }));
    await eventually(() => sentOf(h, "KICK").length === 1);
    h.clock.advance(9_999);
    h.clock.advance(1);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ kicked: true, sessionClosed: false, waitedSec: 10 });
  });

  it("maps a refused kick (482) to an error", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, ":seance.local 482 crew #fix :You're not channel operator");
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", args({ confirm: true }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("482");
  });

  it("ignores a session-closed notice of another channel", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, ":ChanServ!c@s NOTICE #other :session closed, worktree reset to abc1234");
    });
    const h = await bootMcp({ ircd });
    const pending = h.call("exorcise", args({ confirm: true }));
    await eventually(() => sentOf(h, "KICK").length === 1);
    h.clock.advance(10_000);
    expect(structured(await pending)["sessionClosed"]).toBe(false);
  });

  it("removes its listeners and timers", async () => {
    const ircd = world();
    closeOnKick(ircd);
    const h = await bootMcp({ ircd });
    const count = () => (["session-closed", "server-error", "state"] as const).reduce((n, t) => n + h.app.store.listenerCount(t), 0);
    const listeners = count();
    const timers = h.clock.pending;
    await h.call("exorcise", args({ confirm: true }));
    expect(count()).toBe(listeners);
    expect(h.clock.pending).toBe(timers);
  });

  it("stops waiting when the connection drops", async () => {
    const ircd = world();
    const h = await bootMcp({ ircd });
    const pending = h.call("exorcise", args({ confirm: true }));
    await eventually(() => sentOf(h, "KICK").length === 1);
    ircd.drop(ircd.last);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/connection was lost/);
  });

  it.each([
    ["bad channel", { channel: "fix" }],
    ["bad agent", { agent: "a,b" }],
    ["CRLF agent", { agent: "coder\r\nQUIT" }],
    ["extra key", { force: true }],
  ])("rejects %s without sending", async (_name, extra) => {
    const h = await bootMcp({ ircd: world() });
    expect((await h.call("exorcise", args({ confirm: true, ...extra }))).isError).toBe(true);
    expect(sentOf(h, "KICK")).toEqual([]);
  });

  it("states the bridge state when not registered", async () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", args({ confirm: true }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connecting");
    expect(ircd.allLines.some((l) => l.startsWith("KICK"))).toBe(false);
  });
});

describe("tool schemas for the confirm flag", () => {
  it("still advertise confirm as a required boolean", async () => {
    const h = await bootMcp();
    const reply = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (reply.body as { result: { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, { type: string }> } }> } }).result.tools;
    for (const name of ["grant_op", "exorcise"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema;
      expect(schema?.required).toContain("confirm");
      expect(schema?.properties["confirm"]?.type).toBe("boolean");
    }
  });
});

describe("grant_op waits for the server (review fix 1)", () => {
  const args = { channel: "#fix", agent: "coder", mode: "+o", confirm: true };
  const needsOp = (h: { ircd: FakeIrcd }) => {
    h.ircd.sendLines(h.ircd.last, [":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op"]);
    h.ircd.run();
  };

  it("accepted path: the inbox item is resolved only once the MODE arrives", async () => {
    const ircd = world();
    // Answer only after the test has looked at the inbox.
    let release: (() => void) | undefined;
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") release = () => d.reply(conn, `:crew!u@h MODE ${m.params.join(" ")}`);
    });
    const h = await bootMcp({ ircd });
    needsOp(h);
    const pending = h.call("grant_op", args);
    await eventually(() => release !== undefined);
    expect(h.app.store.openInbox()).toHaveLength(1); // sent, not yet applied
    release?.();
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ applied: true, inboxResolved: 1 });
    expect(h.app.store.openInbox()).toHaveLength(0);
  });

  it("refused path (482): tool error naming the numeric, inbox untouched", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, ":seance.local 482 crew #fix :You're not channel operator");
    });
    const h = await bootMcp({ ircd });
    needsOp(h);
    const result = await h.call("grant_op", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("482");
    expect(h.app.store.openInbox()).toHaveLength(1);
  });

  it.each(["441", "403", "401"])("refused path (%s) is a tool error too", async (numeric) => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, `:seance.local ${numeric} crew ${numeric === "403" ? "#fix" : "coder"} :nope`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("grant_op", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(numeric);
  });

  it("timeout path: tool error after 5 s, inbox item stays open", async () => {
    const ircd = world();
    ircd.hooks.length = 0; // the server never answers
    const h = await bootMcp({ ircd });
    needsOp(h);
    const pending = h.call("grant_op", args);
    await eventually(() => sentOf(h, "MODE").length === 1);
    h.clock.advance(4_999);
    h.clock.advance(1);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No confirmation/);
    expect(h.app.store.openInbox()).toHaveLength(1);
  });

  it("ignores a MODE for another agent, another mode or another channel", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command !== "MODE") return;
      d.reply(conn, ":crew!u@h MODE #fix +o other");
      d.reply(conn, ":crew!u@h MODE #fix +v coder");
      d.reply(conn, ":crew!u@h MODE #elsewhere +o coder");
    });
    const h = await bootMcp({ ircd });
    needsOp(h);
    const pending = h.call("grant_op", args);
    await eventually(() => sentOf(h, "MODE").length === 1);
    h.clock.advance(5_000);
    expect((await pending).isError).toBe(true);
    expect(h.app.store.openInbox()).toHaveLength(1);
  });

  it("removes its listeners and timers in every path", async () => {
    const ircd = world();
    const h = await bootMcp({ ircd });
    const count = () => (["mode", "server-error", "state"] as const).reduce((n, t) => n + h.app.store.listenerCount(t), 0);
    const listeners = count();
    const timers = h.clock.pending;
    await h.call("grant_op", args);
    expect(count()).toBe(listeners);
    expect(h.clock.pending).toBe(timers);
  });
});

describe("serialized per channel (review fix 4)", () => {
  it("two parallel grant_op calls on one channel each get their own outcome", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command !== "MODE") return;
      if (m.params[2] === "coder") d.reply(conn, ":seance.local 482 crew #fix :You're not channel operator");
      else d.reply(conn, `:crew!u@h MODE ${m.params.join(" ")}`);
    });
    const h = await bootMcp({ ircd });
    const [refused, accepted] = await Promise.all([
      h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true }),
      h.call("grant_op", { channel: "#fix", agent: "reviewer", mode: "+v", confirm: true }),
    ]);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("482");
    expect(accepted.isError).toBeUndefined();
    expect(structured(accepted)).toMatchObject({ applied: true, agent: "reviewer" });
  });

  it("runs the second call only after the first one finished", async () => {
    const ircd = world();
    ircd.hooks.length = 0; // nothing answers: the first call waits for its timeout
    const h = await bootMcp({ ircd });
    const first = h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    await eventually(() => sentOf(h, "MODE").length === 1);
    const second = h.call("grant_op", { channel: "#fix", agent: "reviewer", mode: "+v", confirm: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sentOf(h, "MODE")).toEqual(["MODE #fix +v coder"]); // the second is still queued behind the first
    h.clock.advance(5_000);
    await first;
    await eventually(() => sentOf(h, "MODE").length === 2);
    h.clock.advance(5_000);
    await second;
    expect(sentOf(h, "MODE")).toEqual(["MODE #fix +v coder", "MODE #fix +v reviewer"]);
  });

  it("does not block other channels", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    const h = await bootMcp({ ircd });
    const slow = h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    await eventually(() => sentOf(h, "MODE").length === 1);
    const other = h.call("grant_op", { channel: "#other", agent: "coder", mode: "+v", confirm: true });
    await eventually(() => sentOf(h, "MODE").length === 2);
    h.clock.advance(5_000);
    await Promise.all([slow, other]);
  });
});

describe("exorcise matches the kicked agent (review fix 3)", () => {
  const noticeOnly = (ircd: FakeIrcd, channel = "#fix") => {
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, `:ChanServ!c@s NOTICE ${channel} :session closed, worktree reset to abc1234`);
    });
  };

  it("does not accept a session-closed notice when the agent was not seen leaving", async () => {
    const ircd = world();
    noticeOnly(ircd); // the notice arrives, but there is no KICK or PART line for coder
    const h = await bootMcp({ ircd });
    const pending = h.call("exorcise", { channel: "#fix", agent: "coder", confirm: true });
    await eventually(() => sentOf(h, "KICK").length === 1);
    h.clock.advance(10_000);
    expect(structured(await pending)).toMatchObject({ kicked: true, sessionClosed: false });
  });

  it("does not accept the kick of another agent", async () => {
    const ircd = world();
    noticeOnly(ircd);
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, ":crew!u@h KICK #fix someoneelse :bye");
    });
    const h = await bootMcp({ ircd });
    const pending = h.call("exorcise", { channel: "#fix", agent: "coder", confirm: true });
    await eventually(() => sentOf(h, "KICK").length === 1);
    h.clock.advance(10_000);
    expect(structured(await pending)["sessionClosed"]).toBe(false);
  });

  it("accepts the agent's PART as the sign that it left", async () => {
    const ircd = world();
    noticeOnly(ircd);
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, ":coder!u@h PART #fix :done");
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", { channel: "#fix", agent: "coder", confirm: true });
    expect(structured(result)).toMatchObject({ sessionClosed: true, sha: "abc1234" });
  });

  it("accepts the notice before the KICK line too (either order)", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command !== "KICK") return;
      d.reply(conn, ":ChanServ!c@s NOTICE #fix :session closed, worktree reset to abc1234");
      d.reply(conn, ":crew!u@h KICK #fix coder :bye");
    });
    const h = await bootMcp({ ircd });
    expect(structured(await h.call("exorcise", { channel: "#fix", agent: "coder", confirm: true }))["sessionClosed"]).toBe(true);
  });
});

describe("waiters are removed when sending throws (review fix 5)", () => {
  it("cleans up even for an error that is not a LineError", async () => {
    const h = await bootMcp({ ircd: world() });
    const store = h.app.store;
    const count = () => (["mode", "server-error", "session-closed", "line", "ready", "state"] as const).reduce((n, t) => n + store.listenerCount(t), 0);
    const before = count();
    const timers = h.clock.pending;
    const original = h.app.bridge.send.bind(h.app.bridge);
    h.app.bridge.send = () => {
      throw new TypeError("socket exploded");
    };
    for (const [name, a] of [
      ["grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true }],
      ["exorcise", { channel: "#fix", agent: "coder", confirm: true }],
      ["summon", { channel: "#fix" }],
      ["whois", { nick: "coder" }],
    ] as const) {
      const result = await h.call(name, a);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/internal error/);
      expect(count(), name).toBe(before);
      expect(h.clock.pending, name).toBe(timers);
    }
    h.app.bridge.send = original;
  });
});
