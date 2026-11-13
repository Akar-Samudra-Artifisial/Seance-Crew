// demo-say-fixes Requirement 2: a refusal from the server is logged once and shown in the channel log.
import { afterEach, describe, expect, it } from "vitest";
import { buildState } from "../src/api/state.js";
import { cleanServerText, REFUSAL_REASON_MAX } from "../src/irc/dispatch.js";
import type { BridgeEvent } from "../src/irc/store.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootMcp, cleanupMcp, MCP_SECRET, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const NUMERICS = ["403", "404", "441", "442", "443", "461", "471", "472", "473", "474", "475", "481", "482"] as const;

const world = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.channels = [{ name: "#fix", count: 2, topic: "", names: ["@crew", "coder"] }];
  return ircd;
};

type Harness = Awaited<ReturnType<typeof bootMcp>>;

/** The refusal entries the bridge wrote to its log (parsed JSON lines). */
const refusalLogs = (h: Harness): Array<Record<string, unknown>> =>
  h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["msg"] === "server refused a command");

const serverLines = (h: Harness, channel = "#fix") => (h.app.store.channel(channel)?.ring.newest(50) ?? []).filter((l) => l.from === "server" && l.kind === "system");

/** The server sends a numeric to us, then the fake network runs. */
const refuse = (h: Harness, numeric: string, target: string, text: string): void => {
  h.ircd.sendLines(h.ircd.last, [`:seance.local ${numeric} crew ${target} :${text}`]);
  h.ircd.run();
};

describe("a rejected say", () => {
  it("is logged once at warn and shown in the channel log, to read and to the dashboard state", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "PRIVMSG") d.reply(conn, `:seance.local 404 crew ${m.params[0] ?? ""} :Cannot send to channel`);
    });
    const h = await bootMcp({ ircd });
    await h.call("say", { channel: "#fix", text: "fix the failing test" });
    h.advance(2_000);

    const entries = refusalLogs(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "warn", numeric: "404", target: "#fix", reason: "Cannot send to channel" });

    // Our own message first, then the refusal, so the log reads as it happened.
    const lines = h.app.store.channel("#fix")?.ring.newest(10) ?? [];
    const own = lines.findIndex((l) => l.from === "crew" && l.text === "fix the failing test");
    const refused = lines.findIndex((l) => l.text === "Server refused (404): Cannot send to channel");
    expect(own).toBeGreaterThanOrEqual(0);
    expect(refused).toBeGreaterThan(own);
    expect(lines[refused]).toMatchObject({ from: "server", kind: "system" });

    expect(textOf(await h.call("read", { channel: "#fix" }))).toContain("Server refused (404): Cannot send to channel");
    const state = buildState(h.app.store, h.app.bridge).channels.find((c) => c.name === "#fix");
    expect(state?.lines.filter((l) => l.text.startsWith("Server refused (404)"))).toHaveLength(1);
  });
});

describe("every refusal numeric", () => {
  it.each(NUMERICS)("%s for a tracked channel: one warn entry and one system line", async (numeric) => {
    const h = await bootMcp({ ircd: world() });
    const before = serverLines(h).length;
    refuse(h, numeric, "#fix", "Not allowed here");
    expect(refusalLogs(h)).toHaveLength(1);
    expect(refusalLogs(h)[0]).toMatchObject({ level: "warn", numeric, target: "#fix", reason: "Not allowed here" });
    expect(serverLines(h)).toHaveLength(before + 1);
    expect(serverLines(h).at(-1)?.text).toBe(`Server refused (${numeric}): Not allowed here`);
  });

  it("is still emitted as the internal server-error event, so summon, grant_op and exorcise keep working", async () => {
    const h = await bootMcp({ ircd: world() });
    const events: BridgeEvent[] = [];
    h.app.store.onAny((e) => events.push(e));
    refuse(h, "482", "#fix", "You're not channel operator");
    expect(events.filter((e) => e.type === "server-error")).toEqual([{ type: "server-error", numeric: "482", target: "#fix", text: "You're not channel operator" }]);
  });

  it("a refused grant_op is reported by the tool and also appears in the channel log", async () => {
    const ircd = world();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "MODE") d.reply(conn, `:seance.local 482 crew ${m.params[0] ?? ""} :You're not channel operator`);
    });
    const h = await bootMcp({ ircd });
    const result = await h.call("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("482");
    expect(serverLines(h).map((l) => l.text)).toContain("Server refused (482): You're not channel operator");
  });
});

describe("a refusal that names no tracked channel", () => {
  it("a nick target (441) is logged and adds no line anywhere", async () => {
    const h = await bootMcp({ ircd: world() });
    const lines = h.app.store.allChannels().map((c) => c.ring.newest(50).length);
    refuse(h, "441", "coder", "They aren't on that channel");
    expect(refusalLogs(h)).toHaveLength(1);
    expect(refusalLogs(h)[0]).toMatchObject({ numeric: "441", target: "coder" });
    expect(h.app.store.allChannels().map((c) => c.ring.newest(50).length)).toEqual(lines);
  });

  it("a command-name target (461) is logged and adds no line anywhere", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "461", "KICK", "Not enough parameters");
    expect(refusalLogs(h)[0]).toMatchObject({ numeric: "461", target: "KICK" });
    expect(serverLines(h)).toHaveLength(0);
  });

  it("a channel the store does not track is logged but not created", async () => {
    const h = await bootMcp({ ircd: world() });
    const count = h.app.store.allChannels().length;
    refuse(h, "404", "#ghost", "Cannot send to channel");
    expect(refusalLogs(h)).toHaveLength(1);
    expect(h.app.store.channel("#ghost")).toBeUndefined();
    expect(h.app.store.allChannels()).toHaveLength(count);
  });

  it("a refusal with no target at all (481) is logged without throwing", async () => {
    const h = await bootMcp({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [":seance.local 481 crew :Permission Denied- You're not an IRC operator"]);
    h.ircd.run();
    expect(refusalLogs(h)).toHaveLength(1);
    expect(h.app.store.state).toBe("registered");
  });
});

describe("the reason is untrusted text", () => {
  it("strips control characters and formatting codes, and cuts a long reason", async () => {
    const h = await bootMcp({ ircd: world() });
    const long = "x".repeat(300);
    refuse(h, "404", "#fix", `\u0002bold\u0002 \u000312blue\u000f\u0007 bell \u202Eevil ${long}`);
    const line = serverLines(h).at(-1)?.text ?? "";
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
    expect(line).toContain("Server refused (404): bold blue bell evil ");
    expect(line.length).toBeLessThanOrEqual("Server refused (404): ".length + REFUSAL_REASON_MAX);
    expect((refusalLogs(h)[0]?.["reason"] as string).length).toBeLessThanOrEqual(REFUSAL_REASON_MAX);
    expect(h.logs.join("\n")).not.toContain("\u0007");
  });

  it("never writes the secret, even when the server repeats it", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", `Cannot send, your password ${MCP_SECRET} is wrong`);
    expect(h.logs.join("\n")).not.toContain(MCP_SECRET);
    expect(serverLines(h).map((l) => l.text).join("\n")).not.toContain(MCP_SECRET);
  });

  it("says so when the server gave no reason", async () => {
    const h = await bootMcp({ ircd: world() });
    refuse(h, "404", "#fix", " ");
    expect(serverLines(h).at(-1)?.text).toBe("Server refused (404): no reason given");
  });
});

describe("cleanServerText", () => {
  it("cleans, collapses spaces and cuts with an ellipsis", () => {
    expect(cleanServerText("  a \t b\u0000c  ", 50)).toBe("a b c");
    expect(cleanServerText("abcdefghij", 5)).toBe("abcd…");
    expect(cleanServerText("abcde", 5)).toBe("abcde");
    expect(cleanServerText("", 5)).toBe("");
  });
});
