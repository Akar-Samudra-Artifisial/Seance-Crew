// refusal-hardening: the three Minor findings from the review of `onRefusal`.
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/irc/store.js";
import { cutText, REFUSAL_REASON_MAX, REFUSAL_TARGET_MAX, refusalKey } from "../src/irc/dispatch.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootMcp, cleanupMcp, MCP_SECRET, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

type Harness = Awaited<ReturnType<typeof bootMcp>>;

const world = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.channels = [{ name: "#fix", count: 2, topic: "", names: ["@crew", "coder"] }];
  return ircd;
};

const refusalLogs = (h: Harness): Array<Record<string, unknown>> =>
  h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["msg"] === "server refused a command");

const serverLines = (h: Harness, channel = "#fix") => (h.app.store.channel(channel)?.ring.newest(200) ?? []).filter((l) => l.from === "server" && l.kind === "system");

/** The server sends `<numeric> crew <params…> :<text>` and the fake network runs. */
const refuse = (h: Harness, numeric: string, params: string, text: string): void => {
  h.ircd.sendLines(h.ircd.last, [`:seance.local ${numeric} crew ${params} :${text}`]);
  h.ircd.run();
};

/** Every prefix of the secret from 6 characters up: none may appear anywhere a refusal is reported. */
const secretPieces = (): string[] => Array.from({ length: MCP_SECRET.length - 5 }, (_, i) => MCP_SECRET.slice(0, i + 6));
const expectNoSecret = (text: string): void => {
  for (const piece of secretPieces()) expect(text, piece).not.toContain(piece);
};

describe("redact before cutting (Requirement 1)", () => {
  it("cutText keeps the cut as it was", () => {
    expect(cutText("abcdefghij", 5)).toBe("abcd…");
    expect(cutText("abcde", 5)).toBe("abcde");
  });

  it.each([
    ["starts just before the reason cut", REFUSAL_REASON_MAX - 8],
    ["straddles the reason cut in the middle", REFUSAL_REASON_MAX - 10],
    ["starts at the first character", 0],
    ["sits well after the cut", REFUSAL_REASON_MAX + 20],
  ])("a secret that %s is fully redacted in the log entry and in the channel line", async (_name, start) => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", `${"x".repeat(start)}${MCP_SECRET} and more words after it`);
    const entry = refusalLogs(h).at(-1);
    expect(entry).toBeDefined();
    const line = serverLines(h).at(-1)?.text ?? "";
    expectNoSecret(JSON.stringify(entry));
    expectNoSecret(line);
    expectNoSecret(h.logs.join("\n"));
    if (start < REFUSAL_REASON_MAX) expect(line).toContain("***");
    expect(line.length).toBeLessThanOrEqual("Server refused (404): ".length + REFUSAL_REASON_MAX);
  });

  it("a secret that straddles the target cut is fully redacted in the log entry", async () => {
    const h = await bootMcp({ ircd: world() });
    // A refusal with a long single-token target (461 names a command in real life; a hostile server can send anything).
    h.ircd.sendLines(h.ircd.last, [`:seance.local 461 crew ${"a".repeat(REFUSAL_TARGET_MAX - 8)}${MCP_SECRET} :Not enough parameters`]);
    h.ircd.run();
    const entry = refusalLogs(h).at(-1);
    expect(entry).toBeDefined();
    expectNoSecret(JSON.stringify(entry));
    expectNoSecret(h.logs.join("\n"));
    expect(String(entry?.["target"]).length).toBeLessThanOrEqual(REFUSAL_TARGET_MAX);
  });

  it("a secret split by a control character or a formatting code is also redacted", async () => {
    const h = await bootMcp({ ircd: world() });
    const split = `${MCP_SECRET.slice(0, 7)}\u0002${MCP_SECRET.slice(7, 12)}\u000312${MCP_SECRET.slice(12)}`;
    refuse(h, "404", "#fix", `Cannot send ${split} to the channel`);
    expectNoSecret(JSON.stringify(refusalLogs(h).at(-1)));
    expectNoSecret(serverLines(h).at(-1)?.text ?? "");
  });

  it("still cuts the reason to 120 characters", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", "w".repeat(400));
    expect(String(refusalLogs(h).at(-1)?.["reason"]).length).toBe(REFUSAL_REASON_MAX);
    expect(serverLines(h).at(-1)?.text.length).toBe("Server refused (404): ".length + REFUSAL_REASON_MAX);
  });

  it("the tool results stay clean too: a refused grant_op mentions no secret", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, `:seance.local 482 crew ${m.params[0] ?? ""} :${MCP_SECRET}`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    expectNoSecret(textOf(result));
    expectNoSecret(h.logs.join("\n"));
  });
});

describe("441 and 443 name the nick first (Requirement 2)", () => {
  it.each([
    ["441", "They aren't on that channel"],
    ["443", "is already on channel"],
  ])("%s produces one line in the channel of the third parameter, naming the nick", async (numeric, text) => {
    const h = await bootMcp({ ircd: world() });
    const before = serverLines(h).length;
    refuse(h, numeric, "coder #fix", text);
    expect(serverLines(h)).toHaveLength(before + 1);
    expect(serverLines(h).at(-1)?.text).toBe(`Server refused (${numeric}): coder: ${text}`);
    expect(serverLines(h).at(-1)).toMatchObject({ from: "server", kind: "system" });
    expect(refusalLogs(h)).toHaveLength(1);
    expect(refusalLogs(h)[0]).toMatchObject({ level: "warn", numeric, target: "#fix", nick: "coder", reason: text });
  });

  it("the channel line is also what read returns", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", "coder #fix", "They aren't on that channel");
    expect(textOf(await h.call("read", { channel: "#fix" }))).toContain("Server refused (441): coder: They aren't on that channel");
  });

  it.each(["441", "443"])("%s for a channel the store does not track is logged only: no line, no new channel", async (numeric) => {
    const h = await bootMcp({ ircd: world() });
    const count = h.app.store.allChannels().length;
    refuse(h, numeric, "coder #ghost", "Whatever");
    expect(refusalLogs(h)).toHaveLength(1);
    expect(refusalLogs(h)[0]).toMatchObject({ target: "#ghost", nick: "coder" });
    expect(h.app.store.channel("#ghost")).toBeUndefined();
    expect(h.app.store.allChannels()).toHaveLength(count);
    expect(serverLines(h)).toHaveLength(0);
  });

  it("a 441 with no channel parameter is logged with the nick as target and adds no line", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", "coder", "They aren't on that channel");
    expect(refusalLogs(h)[0]).toMatchObject({ numeric: "441", target: "coder" });
    expect(refusalLogs(h)[0]).not.toHaveProperty("nick");
    expect(serverLines(h)).toHaveLength(0);
  });

  it("other numerics keep the old shape: the channel is the second parameter and there is no nick", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "442", "#fix", "You're not on that channel");
    expect(serverLines(h).at(-1)?.text).toBe("Server refused (442): You're not on that channel");
    expect(refusalLogs(h)[0]).not.toHaveProperty("nick");
  });

  it("the nick is cleaned and cannot carry the secret", async () => {
    const h = await bootMcp({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [`:seance.local 441 crew ${MCP_SECRET} #fix :nope`]);
    h.ircd.run();
    expectNoSecret(JSON.stringify(refusalLogs(h).at(-1)));
    expectNoSecret(serverLines(h).at(-1)?.text ?? "");
  });

  it("keeps the server-error payload as before: target is the second parameter, for every numeric", async () => {
    const h = await bootMcp({ ircd: world() });
    const events: Array<{ numeric: string; target: string; text: string }> = [];
    h.app.store.on("server-error", (e) => events.push({ numeric: e.numeric, target: e.target, text: e.text }));
    refuse(h, "441", "coder #fix", "They aren't on that channel");
    refuse(h, "443", "coder #fix", "is already on channel");
    refuse(h, "482", "#fix", "You're not channel operator");
    expect(events).toEqual([
      { numeric: "441", target: "coder", text: "They aren't on that channel" },
      { numeric: "443", target: "coder", text: "is already on channel" },
      { numeric: "482", target: "#fix", text: "You're not channel operator" },
    ]);
  });
});

describe("the tools that wait on a refusal still resolve (Requirement 2.4)", () => {
  it("summon: a 442 for the channel ends the wait with the refusal text", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "INVITE") d.reply(conn, `:seance.local 442 crew ${m.params[1] ?? ""} :You're not on that channel`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("summon", { channel: "#fix" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("442");
    expect(serverLines(h).map((l) => l.text)).toContain("Server refused (442): You're not on that channel");
  });

  it("grant_op: a 482 for the channel ends the wait", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, `:seance.local 482 crew ${m.params[0] ?? ""} :You're not channel operator`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("482");
  });

  it("exorcise: a 441 that names the agent first (<nick> <channel>) ends the wait", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, `:seance.local 441 crew ${m.params[1] ?? ""} ${m.params[0] ?? ""} :They aren't on that channel`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("exorcise", { channel: "#fix", agent: "coder", confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("441");
    // And the channel log now shows why, which it did not before.
    expect(serverLines(h).map((l) => l.text)).toContain("Server refused (441): coder: They aren't on that channel");
  });
});

describe("identical refusals are rate limited (Requirement 3)", () => {
  it("20 identical refusals within 10 s give one warn and one line; the next after the window says how many were held back", async () => {
    const h = await bootMcp({ ircd: world() });
    for (let i = 0; i < 20; i += 1) {
      refuse(h, "404", "#fix", "Cannot send to channel");
      h.clock.advance(400); // 8 s in total, all inside the window
    }
    expect(refusalLogs(h)).toHaveLength(1);
    expect(serverLines(h)).toHaveLength(1);
    expect(serverLines(h)[0]?.text).toBe("Server refused (404): Cannot send to channel");
    expect(refusalLogs(h)[0]).not.toHaveProperty("suppressed");

    h.clock.advance(10_000); // the window has closed
    refuse(h, "404", "#fix", "Cannot send to channel");
    expect(refusalLogs(h)).toHaveLength(2);
    expect(refusalLogs(h)[1]).toMatchObject({ numeric: "404", reason: "Cannot send to channel (19 more suppressed)", suppressed: 19 });
    expect(serverLines(h)).toHaveLength(2);
    expect(serverLines(h)[1]?.text).toBe("Server refused (404): Cannot send to channel (19 more suppressed)");
  });

  it("the count is not cut off with the reason", async () => {
    const h = await bootMcp({ ircd: world() });
    const long = "w".repeat(300);
    refuse(h, "404", "#fix", long);
    refuse(h, "404", "#fix", long);
    h.clock.advance(11_000);
    refuse(h, "404", "#fix", long);
    const text = serverLines(h).at(-1)?.text ?? "";
    expect(text.endsWith(" (1 more suppressed)")).toBe(true);
    expect(text).toContain("…");
  });

  it("different numerics and different channels are not suppressed", async () => {
    const ircd = world();
    ircd.channels.push({ name: "#other", count: 1, topic: "", names: ["@crew"] });
    const h = await bootMcp({ ircd });
    refuse(h, "404", "#fix", "a");
    refuse(h, "403", "#fix", "b");
    refuse(h, "404", "#other", "c");
    refuse(h, "441", "coder #fix", "d");
    expect(refusalLogs(h)).toHaveLength(4);
    expect(serverLines(h, "#fix")).toHaveLength(3);
    expect(serverLines(h, "#other")).toHaveLength(1);
  });

  it("the channel name is compared without case", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", "a");
    refuse(h, "404", "#FIX", "a");
    expect(refusalLogs(h)).toHaveLength(1);
  });

  it("every refusal still emits the server-error event, reported or not", async () => {
    const h = await bootMcp({ ircd: world() });
    const events: BridgeEvent[] = [];
    h.app.store.onAny((e) => events.push(e));
    for (let i = 0; i < 20; i += 1) refuse(h, "404", "#fix", "Cannot send to channel");
    expect(events.filter((e) => e.type === "server-error")).toHaveLength(20);
    expect(refusalLogs(h)).toHaveLength(1);
  });

  it("a waiting tool sees its reply even while the same refusal is being suppressed", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, `:seance.local 482 crew ${m.params[0] ?? ""} :You're not channel operator`);
    });
    const h = await bootMcp({ ircd });
    for (let i = 0; i < 5; i += 1) refuse(h, "482", "#fix", "You're not channel operator"); // the key is already in its window
    const result = await h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("482");
    expect(refusalLogs(h)).toHaveLength(1);
  });

  it("uses the injectable clock: no real time passes and nothing is left pending", async () => {
    const h = await bootMcp({ ircd: world() });
    const pending = h.clock.pending;
    for (let i = 0; i < 30; i += 1) refuse(h, "404", "#fix", "x");
    expect(h.clock.pending).toBe(pending);
  });
});

describe("the global limit and safe eviction (Requirement 5)", () => {
  const summaries = (h: Harness) => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => typeof r["msg"] === "string" && (r["msg"] as string).includes("refusal reports suppressed (global limit)"));

  it("200 refusals for 200 different targets within 10 s give at most 20 reports and one global summary after the window", async () => {
    const h = await bootMcp({ ircd: world() });
    const events: BridgeEvent[] = [];
    h.app.store.onAny((e) => events.push(e));
    for (let i = 0; i < 200; i += 1) {
      refuse(h, "404", `#target${i}`, "Cannot send to channel");
      h.clock.advance(40); // 8 s in total
    }
    expect(refusalLogs(h)).toHaveLength(20);
    expect(summaries(h)).toHaveLength(0); // nothing is written while the budget is used up
    expect(events.filter((e) => e.type === "server-error")).toHaveLength(200); // every reply still reaches the waiters

    h.clock.advance(10_000);
    refuse(h, "404", "#after", "Cannot send to channel");
    expect(summaries(h)).toHaveLength(1);
    expect(summaries(h)[0]).toMatchObject({ level: "warn", msg: "180 refusal reports suppressed (global limit)", suppressed: 180 });
    expect(refusalLogs(h)).toHaveLength(21);
    // The summary comes first, then the report it belongs to.
    const order = h.logs.map((l) => (JSON.parse(l) as { msg: string }).msg);
    expect(order.indexOf("180 refusal reports suppressed (global limit)")).toBeLessThan(order.lastIndexOf("server refused a command"));
  });

  it("the summary is log only: no channel line, and it is written once", async () => {
    const h = await bootMcp({ ircd: world() });
    for (let i = 0; i < 30; i += 1) refuse(h, "404", `#t${i}`, "x");
    h.clock.advance(11_000);
    refuse(h, "404", "#fix", "y");
    refuse(h, "403", "#fix", "z");
    expect(summaries(h)).toHaveLength(1);
    expect(serverLines(h).map((l) => l.text).join("\n")).not.toContain("global limit");
  });

  it("a tracked channel's key is not reset by a flood of other targets while its window is open", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", "Cannot send to channel"); // the tracked channel's key opens
    for (let i = 0; i < 250; i += 1) refuse(h, "404", `#flood${i}`, "x"); // 250 new keys: far more than the 100 the map holds
    h.clock.advance(5_000);
    refuse(h, "404", "#fix", "Cannot send to channel"); // still inside its window
    expect(serverLines(h)).toHaveLength(1);
    expect(refusalLogs(h).filter((r) => r["target"] === "#fix")).toHaveLength(1);
  });

  it("the held count of an expired key that is dropped reaches the next global summary", async () => {
    const h = await bootMcp({ ircd: world() });
    // 20 reports in one window, each its own key; the first key also holds back 6 repeats.
    refuse(h, "404", "#fix", "loud");
    for (let i = 0; i < 6; i += 1) refuse(h, "404", "#fix", "loud");
    for (let i = 0; i < 19; i += 1) refuse(h, "404", `#k${i}`, "x");
    // 120 more keys in a later window fill the map (100 keys) and force the old, expired ones out.
    h.clock.advance(11_000);
    for (let i = 0; i < 20; i += 1) refuse(h, "404", `#late${i}`, "x");
    h.clock.advance(11_000);
    for (let i = 0; i < 20; i += 1) refuse(h, "404", `#later${i}`, "x");
    h.clock.advance(11_000);
    for (let i = 0; i < 20; i += 1) refuse(h, "404", `#latest${i}`, "x");
    h.clock.advance(11_000);
    for (let i = 0; i < 20; i += 1) refuse(h, "404", `#final${i}`, "x");
    h.clock.advance(11_000);
    refuse(h, "404", "#last", "x");
    refuse(h, "404", "#last2", "x");
    // The map held exactly 100 keys (20 per window, five windows). #last needed room, so the oldest expired key (#fix, with
    // 6 repeats held back) was dropped and its count went to the one summary that comes with the next report.
    expect(summaries(h)).toHaveLength(1);
    expect(summaries(h)[0]).toMatchObject({ msg: "6 refusal reports suppressed (global limit)", suppressed: 6 });
    expect(refusalLogs(h).map((r) => r["target"])).toContain("#last");
    expect(refusalLogs(h).map((r) => r["target"])).toContain("#last2");
  });

  it("the Séance secret never appears in a summary", async () => {
    const h = await bootMcp({ ircd: world() });
    for (let i = 0; i < 40; i += 1) refuse(h, "404", `#t${i}`, MCP_SECRET);
    h.clock.advance(11_000);
    refuse(h, "404", "#fix", "again");
    expectNoSecret(h.logs.join("\n"));
  });
});

describe("441 and 443 keys (Requirement 6) and a bounded key (Requirement 5.6)", () => {
  it("two different nicks in the same channel are both reported", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", "coder #fix", "They aren't on that channel");
    refuse(h, "441", "reviewer #fix", "They aren't on that channel");
    expect(refusalLogs(h)).toHaveLength(2);
    expect(serverLines(h).map((l) => l.text)).toEqual([
      "Server refused (441): coder: They aren't on that channel",
      "Server refused (441): reviewer: They aren't on that channel",
    ]);
    // The same nick again, in the same window, is still held back; the case of the nick does not matter.
    refuse(h, "441", "CODER #fix", "They aren't on that channel");
    expect(refusalLogs(h)).toHaveLength(2);
  });

  it("443 is keyed by nick too", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "443", "coder #fix", "is already on channel");
    refuse(h, "443", "reviewer #fix", "is already on channel");
    expect(serverLines(h)).toHaveLength(2);
  });

  it("an invalid nick is left out of the key, the log entry and the line, and the channel is still used", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", "bad\u0007nick #fix", "They aren't on that channel");
    expect(serverLines(h).at(-1)?.text).toBe("Server refused (441): They aren't on that channel");
    expect(refusalLogs(h)[0]).toMatchObject({ numeric: "441", target: "#fix" });
    expect(refusalLogs(h)[0]).not.toHaveProperty("nick");
    // Two different invalid nicks share the nickless key, so the second is held back.
    refuse(h, "441", "also,bad #fix", "They aren't on that channel");
    expect(refusalLogs(h)).toHaveLength(1);
  });

  it("a nick longer than the nick limit is not used either", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", `${"n".repeat(60)} #fix`, "They aren't on that channel");
    expect(refusalLogs(h)[0]).not.toHaveProperty("nick");
  });

  it("refusalKey stays bounded for a 5,000 character target, and ignores case", () => {
    const key = refusalKey("404", "#" + "A".repeat(5_000), "");
    expect(key.length).toBeLessThanOrEqual("404 ".length + REFUSAL_TARGET_MAX);
    expect(key).toBe(`404 #${"a".repeat(REFUSAL_TARGET_MAX - 1)}`);
    const withNick = refusalKey("441", "#" + "B".repeat(5_000), "Coder");
    expect(withNick.length).toBeLessThanOrEqual("441 ".length + REFUSAL_TARGET_MAX + 1 + 30);
    expect(withNick.endsWith(" coder")).toBe(true);
  });

  it("a refusal with a 5,000 character target is reported with a cut target and does not grow the key", async () => {
    const h = await bootMcp({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [`:seance.local 461 crew ${"T".repeat(5_000)} :Not enough parameters`]);
    h.ircd.run();
    expect(String(refusalLogs(h)[0]?.["target"]).length).toBeLessThanOrEqual(REFUSAL_TARGET_MAX);
  });

  it("a different numeric in the same channel is still its own key", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "441", "coder #fix", "a");
    refuse(h, "443", "coder #fix", "b");
    refuse(h, "442", "#fix", "c");
    expect(serverLines(h)).toHaveLength(3);
  });
});
