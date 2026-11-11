import { afterEach, describe, expect, it } from "vitest";
import { signProxyRequest } from "../src/api/proxyAuth.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { bootApi, PROXY_SECRET, pump, type ApiHarness } from "./apiHelpers.js";
import { cleanupMcp, echoKicks, echoModes, eventually } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const errorOf = (json: unknown): { code: string; message: string } => (json as { error: { code: string; message: string } }).error;
const sentOf = (h: { sent(): string[] }, prefix: string): string[] => h.sent().filter((l) => l.startsWith(prefix));

const world = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.channels = [{ name: "#fix", count: 2, topic: "", names: ["@crew", "+coder"] }];
  ircd.whois = { coder: { info: ["model: claude"] } };
  echoModes(ircd);
  echoKicks(ircd);
  return ircd;
};
const inviteHook = (ircd: FakeIrcd, reply: (nick: string, channel: string) => string | null): void => {
  ircd.hooks.push((m, conn, d) => {
    if (m.command !== "INVITE") return;
    const line = reply(m.params[0] ?? "", m.params[1] ?? "");
    if (line !== null) d.reply(conn, line);
  });
};
const readyNotice = (agent: string, channel: string) => `:ChanServ!c@s NOTICE ${channel} :${agent} is ready`;
const closeOnKick = (ircd: FakeIrcd): void => {
  ircd.hooks.push((m, conn, d) => {
    if (m.command === "KICK") d.reply(conn, `:ChanServ!c@s NOTICE ${m.params[0] ?? ""} :session closed, worktree reset to abc1234`);
  });
};
const post = (h: ApiHarness, path: string, body: unknown) => pump(h, h.api({ method: "POST", path, body }));

describe("POST /api/summon", () => {
  it("sends INVITE coder <channel> by default and answers { ready: true }", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/summon", { channel: "#fix" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ready: true });
    expect(sentOf(h, "INVITE")).toEqual(["INVITE coder #fix"]);
  });

  it("summons another agent without a confirm field: typing the name in the form is the agreement", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/summon", { channel: "#fix", agent: "reviewer" });
    expect(reply.json).toEqual({ ready: true });
    expect(sentOf(h, "INVITE")).toEqual(["INVITE reviewer #fix"]);
  });

  it("answers { ready: false, waitedSec } after 20 s without a ready notice", async () => {
    const h = await bootApi({ ircd: new FakeIrcd() });
    const pending = pump(h, h.api({ method: "POST", path: "/api/summon", body: { channel: "#fix" } }));
    await eventually(() => h.sent().includes("INVITE coder #fix"));
    h.clock.advance(20_000);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ready: false, waitedSec: 20 });
  });

  it.each(["482", "473"])("maps a refused invite (%s) to 502 server_refused", async (numeric) => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (_n, channel) => `:seance.local ${numeric} crew ${channel} :refused`);
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/summon", { channel: "#fix" });
    expect(reply.status).toBe(502);
    expect(errorOf(reply.json).code).toBe("server_refused");
    expect(errorOf(reply.json).message).toContain("SEANCE_INVITERS");
  });

  it("answers 409 not_registered and sends nothing while the bridge is not registered", async () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/summon", { channel: "#fix" });
    expect(reply.status).toBe(409);
    expect(errorOf(reply.json).code).toBe("not_registered");
    expect(sentOf(h, "INVITE")).toEqual([]);
  });

  it.each([
    ["no channel", {}],
    ["bad channel", { channel: "fix" }],
    ["channel with comma", { channel: "#a,#b" }],
    ["bad agent", { channel: "#fix", agent: "bad nick" }],
    ["unknown property", { channel: "#fix", extra: 1 }],
    ["array body", []],
    ["null body", null],
  ])("answers 422 for %s and sends nothing", async (_name, body) => {
    const h = await bootApi({ ircd: new FakeIrcd() });
    const reply = await post(h, "/api/summon", body);
    expect(reply.status).toBe(422);
    expect(errorOf(reply.json).code).toBe("invalid_request");
    expect(sentOf(h, "INVITE")).toEqual([]);
  });

  it("shares the 3-per-10-minutes limit with the MCP tool and answers 429", async () => {
    const ircd = new FakeIrcd();
    inviteHook(ircd, (nick, channel) => readyNotice(nick, channel));
    const h = await bootApi({ ircd });
    for (let i = 0; i < 2; i++) {
      h.advance(2_000); // the send queue releases one line per second
      expect((await post(h, "/api/summon", { channel: "#fix" })).status).toBe(200);
    }
    h.advance(2_000);
    expect((await h.call("summon", { channel: "#fix" })).isError).toBeUndefined();
    const fourth = await post(h, "/api/summon", { channel: "#fix" });
    expect(fourth.status).toBe(429);
    expect(errorOf(fourth.json).code).toBe("rate_limited");
  });
});

describe("POST /api/grant-op", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ channel: "#fix", agent: "coder", mode: "+o", ...extra });

  it.each([
    ["missing", {}],
    ["false", { confirm: false }],
    ["string true", { confirm: "true" }],
    ["number 1", { confirm: 1 }],
    ["null", { confirm: null }],
  ])("answers 400 confirm_required for confirm %s and sends nothing", async (_name, extra) => {
    const h = await bootApi({ ircd: world() });
    const reply = await post(h, "/api/grant-op", body(extra));
    expect(reply.status).toBe(400);
    expect(errorOf(reply.json).code).toBe("confirm_required");
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it.each(["+v", "-v", "+o", "-o"])("sends exactly MODE #fix %s coder with confirm: true", async (mode) => {
    const h = await bootApi({ ircd: world() });
    const reply = await post(h, "/api/grant-op", body({ mode, confirm: true }));
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true });
    expect(sentOf(h, "MODE")).toEqual([`MODE #fix ${mode} coder`]);
  });

  describe("inbox resolution follows the MCP grant_op rule", () => {
    const withItem = async () => {
      const ircd = world();
      ircd.channels = [{ name: "#fix", count: 3, topic: "", names: ["@crew", "+coder", "+reviewer"] }];
      const h = await bootApi({ ircd });
      h.ircd.sendLines(h.ircd.last, [":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op"]);
      h.ircd.run();
      const item = h.app.store.openInbox()[0];
      expect(item?.channel).toBe("#fix");
      const statusOf = () => h.app.store.inbox().find((i) => i.id === item?.id)?.status;
      return { h, id: item?.id, statusOf };
    };

    it("a refused +o leaves the item open", async () => {
      const { h, id, statusOf } = await withItem();
      h.ircd.hooks.length = 0;
      h.ircd.hooks.push((m, conn, d) => {
        if (m.command === "MODE") d.reply(conn, ":seance.local 482 crew #fix :You're not channel operator");
      });
      const reply = await post(h, "/api/grant-op", body({ mode: "+o", confirm: true, inboxId: id }));
      expect(reply.status).toBe(502);
      expect(statusOf()).toBe("open");
    });

    it("a successful +v does not resolve the item", async () => {
      const { h, id, statusOf } = await withItem();
      const reply = await post(h, "/api/grant-op", body({ mode: "+v", confirm: true, inboxId: id }));
      expect(reply.status).toBe(200);
      expect(statusOf()).toBe("open");
    });

    it("a successful +o for another agent does not resolve it, even with that inboxId", async () => {
      const { h, id, statusOf } = await withItem();
      const reply = await post(h, "/api/grant-op", body({ agent: "reviewer", mode: "+o", confirm: true, inboxId: id }));
      expect(reply.status).toBe(200);
      expect(statusOf()).toBe("open");
    });

    it("a successful +o for the item's channel and agent resolves it", async () => {
      const { h, id, statusOf } = await withItem();
      const reply = await post(h, "/api/grant-op", body({ mode: "+o", confirm: true, inboxId: id }));
      expect(reply.status).toBe(200);
      expect(statusOf()).toBe("granted");
    });

    it("a successful +o resolves it without an inboxId too (same rule as over MCP)", async () => {
      const { h, statusOf } = await withItem();
      await post(h, "/api/grant-op", body({ mode: "+o", confirm: true }));
      expect(statusOf()).toBe("granted");
    });

    it("an unknown inboxId resolves nothing and does not fail the grant", async () => {
      const { h, statusOf } = await withItem();
      const reply = await post(h, "/api/grant-op", body({ agent: "reviewer", mode: "+o", confirm: true, inboxId: "i999" }));
      expect(reply.status).toBe(200);
      expect(statusOf()).toBe("open");
    });
  });

  it("answers 409 not_registered and sends nothing", async () => {
    const ircd = world();
    ircd.stallRegistration = true;
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/grant-op", body({ confirm: true }));
    expect(reply.status).toBe(409);
    expect(errorOf(reply.json).code).toBe("not_registered");
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it.each([
    ["bad mode", { mode: "+x" }],
    ["mode with a space", { mode: "+o coder" }],
    ["bad channel", { channel: "fix" }],
    ["bad agent", { agent: "a b" }],
    ["unknown property", { extra: 1 }],
    ["empty inboxId", { inboxId: "" }],
  ])("answers 422 for %s and sends nothing", async (_name, extra) => {
    const h = await bootApi({ ircd: world() });
    const reply = await post(h, "/api/grant-op", body({ confirm: true, ...extra }));
    expect(reply.status).toBe(422);
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it("answers 502 when the server does not confirm the change within 5 s", async () => {
    const ircd = world();
    ircd.hooks.length = 0; // no echo
    const h = await bootApi({ ircd });
    const pending = pump(h, h.api({ method: "POST", path: "/api/grant-op", body: body({ confirm: true }) }));
    await eventually(() => sentOf(h, "MODE").length === 1);
    h.clock.advance(5_000);
    const reply = await pending;
    expect(reply.status).toBe(502);
    expect(errorOf(reply.json).code).toBe("server_refused");
  });
});

describe("POST /api/exorcise", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ channel: "#fix", agent: "coder", ...extra });

  it.each([
    ["missing", {}],
    ["false", { confirm: false }],
    ["string true", { confirm: "true" }],
  ])("answers 400 confirm_required for confirm %s and sends nothing", async (_name, extra) => {
    const h = await bootApi({ ircd: world() });
    const reply = await post(h, "/api/exorcise", body(extra));
    expect(reply.status).toBe(400);
    expect(errorOf(reply.json).code).toBe("confirm_required");
    expect(sentOf(h, "KICK")).toEqual([]);
  });

  it("kicks with the default reason and answers { ok: true, closed: true }", async () => {
    const ircd = world();
    closeOnKick(ircd);
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/exorcise", body({ confirm: true }));
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, closed: true });
    expect(sentOf(h, "KICK")).toEqual(["KICK #fix coder :exorcised by seance-crew"]);
  });

  it("passes a custom reason", async () => {
    const ircd = world();
    closeOnKick(ircd);
    const h = await bootApi({ ircd });
    await post(h, "/api/exorcise", body({ confirm: true, reason: "all done here" }));
    expect(sentOf(h, "KICK")).toEqual(["KICK #fix coder :all done here"]);
  });

  it("answers { ok: true, closed: false } when no session-closed notice arrives in 10 s", async () => {
    const h = await bootApi({ ircd: world() });
    const pending = pump(h, h.api({ method: "POST", path: "/api/exorcise", body: body({ confirm: true }) }));
    await eventually(() => sentOf(h, "KICK").length === 1);
    h.clock.advance(10_000);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, closed: false });
  });

  it("maps a refused kick (482) to 502", async () => {
    const ircd = world();
    ircd.hooks.length = 0;
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "KICK") d.reply(conn, ":seance.local 482 crew #fix :You're not channel operator");
    });
    const h = await bootApi({ ircd });
    const reply = await post(h, "/api/exorcise", body({ confirm: true }));
    expect(reply.status).toBe(502);
    expect(errorOf(reply.json).code).toBe("server_refused");
  });

  it("answers 409 not_registered and 422 for bad input, sending nothing", async () => {
    const stalled = world();
    stalled.stallRegistration = true;
    const h = await bootApi({ ircd: stalled });
    expect((await post(h, "/api/exorcise", body({ confirm: true }))).status).toBe(409);
    const h2 = await bootApi({ ircd: world() });
    expect((await post(h2, "/api/exorcise", body({ confirm: true, reason: "r".repeat(201) }))).status).toBe(422);
    expect((await post(h2, "/api/exorcise", body({ confirm: true, reason: "a\nQUIT" }))).status).toBe(422);
    expect(sentOf(h2, "KICK")).toEqual([]);
  });
});

describe("POST /api/inbox/dismiss", () => {
  it("dismisses an open item", async () => {
    const h = await bootApi({ ircd: world() });
    h.ircd.sendLines(h.ircd.last, [":seance.local NOTICE crew :ops: coder denied Run npm test: needs-op"]);
    h.ircd.run();
    const id = h.app.store.openInbox()[0]?.id ?? "";
    expect(id).not.toBe("");
    const reply = await post(h, "/api/inbox/dismiss", { id });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true });
    expect(h.app.store.inbox().find((i) => i.id === id)?.status).toBe("dismissed");
    // Dismissing it again is a 404: there is no open item any more (a new second, so the signature is new).
    h.advance(1_000);
    expect((await post(h, "/api/inbox/dismiss", { id })).status).toBe(404);
  });

  it("answers 404 for an unknown id and 422 for a bad body", async () => {
    const h = await bootApi({ ircd: world() });
    const unknown = await post(h, "/api/inbox/dismiss", { id: "i999" });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.json).code).toBe("not_found");
    for (const bad of [{}, { id: 5 }, { id: "" }, { id: "i1", extra: true }]) {
      expect((await post(h, "/api/inbox/dismiss", bad)).status).toBe(422);
    }
  });
});

describe("signature on the action routes", () => {
  it("sends nothing for an unsigned or wrongly signed POST", async () => {
    const h = await bootApi({ ircd: world() });
    const payload = { channel: "#fix", agent: "coder", mode: "+o", confirm: true };
    expect((await h.api({ method: "POST", path: "/api/grant-op", body: payload, sign: false })).status).toBe(403);
    expect((await h.api({ method: "POST", path: "/api/grant-op", body: payload, signWith: "other" })).status).toBe(403);
    expect(sentOf(h, "MODE")).toEqual([]);
  });

  it("rejects a body that was changed after signing", async () => {
    const h = await bootApi({ ircd: world() });
    const signedFor = JSON.stringify({ channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    const header = await signedHeaderFor(h, "POST", "/api/grant-op", signedFor);
    const swapped = JSON.stringify({ channel: "#fix", agent: "coder", mode: "+o", confirm: true });
    const reply = await h.api({ method: "POST", path: "/api/grant-op", body: swapped, sign: false, headers: { "X-KiroCrew-Proxy": header } });
    expect(reply.status).toBe(403);
    expect(sentOf(h, "MODE")).toEqual([]);
  });
});

async function signedHeaderFor(h: ApiHarness, method: string, target: string, body: string): Promise<string> {
  const ts = String(Math.floor(h.clock.now() / 1000));
  return `${ts}:${signProxyRequest(PROXY_SECRET, ts, method, target, Buffer.from(body, "utf8"))}`;
}
