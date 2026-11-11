// Tests for the irc-bridge review fixes (close watchdog, bad server input, log levels, config validation,
// nick rejection, input caps, sweep timer, stale-lock handling at startup).
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { createConfigWatcher } from "../src/config-watch.js";
import { ConfigError, isValidHost, isValidSecret, loadConfig, type ConfigDeps, type FetchLike } from "../src/config.js";
import { CLOSE_WATCHDOG_MS, REGISTRATION_TIMEOUT_MS } from "../src/irc/client.js";
import { MAX_CHANNELS, MAX_MEMBERS } from "../src/irc/dispatch.js";
import type { SocketLike } from "../src/irc/socket.js";
import { createLogger } from "../src/log.js";
import { appPaths, type AppPaths } from "../src/paths.js";
import { FakeClock } from "./fakeClock.js";
import type { FakeIrcd } from "./fakeIrcd.js";
import { makeBridge } from "./helpers.js";

const CONFIG = { host: "irc.example.org", nick: "crew", secret: "s3cret" };

/** A socket whose close() is accepted but never reported by onclose. */
const stuckClose = (url: string, ircd: FakeIrcd): SocketLike => {
  const socket = ircd.connect(url);
  socket.close = () => undefined;
  return socket;
};

const warnings = (logs: readonly string[]): Array<Record<string, unknown>> =>
  logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["level"] === "warn");

describe("close watchdog (item 1)", () => {
  it("treats a socket that never fires onclose as closed after 5 s and backs off", () => {
    const { bridge, ircd, clock, store, advance, logs } = makeBridge({ createSocket: stuckClose });
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    advance(REGISTRATION_TIMEOUT_MS); // handshake timeout calls close(), which does nothing
    expect(store.state).toBe("connecting");
    advance(CLOSE_WATCHDOG_MS - 500);
    expect(store.state).toBe("connecting");
    advance(500);
    expect(store.state).toBe("reconnecting");
    expect(warnings(logs).some((w) => String(w["msg"]).includes("did not report its close"))).toBe(true);
    // The normal backoff then opens a new connection.
    advance(2_000);
    expect(ircd.totalConnections).toBe(2);
    expect(clock.pending).toBeGreaterThan(0);
  });

  it("detaches the old socket so a late onclose or message from it is ignored", () => {
    const { bridge, ircd, store, advance } = makeBridge({ createSocket: stuckClose });
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    const first = ircd.connections[0]?.socket;
    advance(REGISTRATION_TIMEOUT_MS + CLOSE_WATCHDOG_MS);
    expect(first?.onclose).toBeNull();
    expect(first?.onmessage).toBeNull();
    expect(store.state).toBe("reconnecting");
  });

  it("handles the idle timeout path (PING unanswered, close ignored)", () => {
    const { bridge, ircd, store, advance } = makeBridge({ createSocket: stuckClose });
    bridge.start(CONFIG);
    ircd.run();
    expect(store.state).toBe("registered");
    // The server goes silent: nothing it sends reaches the bridge any more.
    ircd.connections[0]!.socket!.deliver = () => undefined;
    advance(120_000 + 30_000);
    expect(store.state).toBe("registered"); // close() was called but nothing reported
    advance(CLOSE_WATCHDOG_MS);
    expect(store.state).toBe("reconnecting");
  });

  it("cancels the watchdog when onclose arrives in time (no warning, one reconnect)", () => {
    const { bridge, ircd, store, advance, logs } = makeBridge();
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    advance(REGISTRATION_TIMEOUT_MS);
    expect(store.state).toBe("reconnecting");
    advance(CLOSE_WATCHDOG_MS);
    expect(warnings(logs).some((w) => String(w["msg"]).includes("did not report its close"))).toBe(false);
  });

  it("lets a config change restart even when the old socket never confirms its close", () => {
    const { bridge, ircd, advance, store } = makeBridge({ createSocket: stuckClose });
    bridge.start(CONFIG);
    ircd.run();
    expect(store.state).toBe("registered");
    bridge.applyConfig({ ...CONFIG, host: "other.example.org" });
    ircd.run();
    expect(ircd.totalConnections).toBe(1);
    advance(CLOSE_WATCHDOG_MS);
    expect(ircd.totalConnections).toBe(2);
    expect(ircd.urls[1]).toBe("wss://other.example.org/ws");
  });
});

describe("bad server input (item 2)", () => {
  it("drops a PING whose token contains NUL without throwing and stays registered", () => {
    const { bridge, ircd, store, logs } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendFrame(ircd.last, "PING :ab\u0000cd\r\n");
    expect(() => ircd.run()).not.toThrow();
    expect(store.state).toBe("registered");
    const dropped = warnings(logs).filter((w) => String(w["msg"]).includes("could not be handled"));
    expect(dropped).toHaveLength(1);
    // The warning carries the kind of failure, never the line content.
    expect(JSON.stringify(dropped[0])).not.toContain("ab");
    expect(dropped[0]).toMatchObject({ command: "PING", error: "LineError:bad-char" });
    // The bridge still works afterwards.
    ircd.sendLines(ircd.last, ["PING :fine"]);
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PONG fine");
  });
});

describe("log level (item 3)", () => {
  it("does not write the line trace at the default info level", () => {
    const { bridge, ircd, logs } = makeBridge({ logLevel: "info" });
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, [":someone!u@h PRIVMSG #chan :secret channel text"]);
    ircd.run();
    const text = logs.join("\n");
    expect(text).not.toContain("secret channel text");
    expect(text).not.toContain("NICK crew");
    expect(text).not.toContain("Welcome");
  });

  it("writes the trace at debug level, with PASS still redacted", () => {
    const { bridge, ircd, logs } = makeBridge({ logLevel: "debug" });
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, [":someone!u@h PRIVMSG #chan :visible at debug"]);
    ircd.run();
    const text = logs.join("\n");
    expect(text).toContain("visible at debug");
    expect(text).toContain("PASS ***");
    expect(text).not.toContain("s3cret");
  });
});

describe("config validation (item 6)", () => {
  const APP_SECRET = "app-secret-aaaa1111";
  const make = (config: unknown): ConfigDeps => {
    const fetch: FetchLike = async (url) => ({ ok: true, status: 200, json: async () => (url.includes("/token") ? { token: "tok" } : config) });
    return { paths: appPaths("/app"), env: { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476" }, fetch, readFile: async () => APP_SECRET };
  };
  const invalid = async (config: unknown): Promise<ConfigError> => {
    try {
      await loadConfig(make(config));
    } catch (err) {
      if (err instanceof ConfigError) return err;
      throw err;
    }
    throw new Error("expected a ConfigError");
  };

  it("trims the secret", async () => {
    const result = await loadConfig(make({ host: "irc.example.org", nick: "crew", secret: "  padded\n" }));
    expect(result).toMatchObject({ kind: "ok", config: { secret: "padded" } });
  });

  it("treats a whitespace-only secret as unconfigured", async () => {
    expect((await loadConfig(make({ secret: " \n " }))).kind).toBe("unconfigured");
  });

  it.each([
    ["CR", "abc\rdef"],
    ["LF", "abc\ndef"],
    ["NUL", "abc\u0000def"],
    ["too long", "x".repeat(401)],
    ["too long in bytes", "é".repeat(201)],
  ])("rejects a secret with %s as a validate error that never echoes the secret", async (_name, secret) => {
    const err = await invalid({ host: "irc.example.org", nick: "crew", secret });
    expect(err.step).toBe("validate");
    expect(err.message).not.toContain(secret);
  });

  it("accepts a 400-byte secret", () => {
    expect(isValidSecret("x".repeat(400))).toBe(true);
    expect(isValidSecret("x".repeat(401))).toBe(false);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "8.8.8.8",
    "127.1",
    "2130706433",
    "0x7f.1",
    "::1",
    "2001:db8::1",
    "[::1]",
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "printer.local",
    "svc.internal",
    "Host.INTERNAL",
    "nodot",
    "a b.example.org",
    "irc.example.org:6697",
    "https://irc.example.org",
    "irc.example.org/ws",
    "host\nname.example.org",
    "1.2.3.4.5",
  ])("rejects the host %j", async (host) => {
    expect(isValidHost(host)).toBe(false);
    if (!/[\r\n\0]/.test(host)) {
      const err = await invalid({ host, nick: "crew", secret: "s3cret" });
      expect(err.step).toBe("validate");
    }
  });

  it.each(["irc.example.org", "35-172-120-185.sslip.io", "a.b.c.example.com", "Example.COM"])("accepts the host %j", (host) => {
    expect(isValidHost(host)).toBe(true);
  });

  it("an invalid config puts the bridge in config-invalid: socket closed, no reconnect loop, recovers on a fix", async () => {
    const { bridge, ircd, clock, store, advance } = makeBridge();
    let next: "ok" | "bad" = "ok";
    const logger = createLogger([], () => undefined);
    const watcher = createConfigWatcher({
      load: async () => {
        if (next === "bad") throw new ConfigError("validate", "host must be a bare hostname");
        return { kind: "ok", config: CONFIG, token: "t", appSecret: "a" };
      },
      bridge,
      clock,
      logger,
    });
    await watcher.poll();
    ircd.run();
    expect(store.state).toBe("registered");

    next = "bad";
    await watcher.poll();
    ircd.run();
    expect(store.state).toBe("config-invalid");
    expect(ircd.connections[0]?.open).toBe(false);
    advance(10 * 60_000);
    expect(ircd.totalConnections).toBe(1);
    expect(store.state).toBe("config-invalid");

    next = "ok";
    await watcher.poll();
    ircd.run();
    expect(store.state).toBe("registered");
    expect(ircd.totalConnections).toBe(2);
  });

  it("a gateway failure (not a validate error) keeps the running connection", async () => {
    const { bridge, ircd, clock, store } = makeBridge();
    let fail = false;
    const watcher = createConfigWatcher({
      load: async () => {
        if (fail) throw new ConfigError("config", "the gateway answered HTTP 500");
        return { kind: "ok", config: CONFIG, token: "t", appSecret: "a" };
      },
      bridge,
      clock,
      logger: createLogger([], () => undefined),
    });
    await watcher.poll();
    ircd.run();
    fail = true;
    await watcher.poll();
    ircd.run();
    expect(store.state).toBe("registered");
  });
});

describe("createSocket throws (item 7)", () => {
  it("goes through the backoff path instead of staying in connecting, then recovers", () => {
    let fail = true;
    const { bridge, ircd, store, advance } = makeBridge({
      createSocket: (url, d) => {
        if (fail) throw new Error("no WebSocket here");
        return d.connect(url);
      },
    });
    bridge.start(CONFIG);
    expect(store.state).toBe("reconnecting");
    advance(1_000);
    expect(store.state).toBe("reconnecting");
    fail = false;
    advance(2_000);
    ircd.run();
    expect(store.state).toBe("registered");
  });
});

describe("464 after registration (item 8)", () => {
  it("ignores it with a warning and stays registered", () => {
    const { bridge, ircd, store, logs } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, [":seance.local 464 crew :Password incorrect"]);
    ircd.run();
    expect(store.state).toBe("registered");
    expect(ircd.last.open).toBe(true);
    expect(warnings(logs).some((w) => String(w["msg"]).includes("464"))).toBe(true);
  });

  it("still means auth-failed before registration", () => {
    const { bridge, ircd, store } = makeBridge();
    ircd.accounts = {};
    bridge.start(CONFIG);
    ircd.run();
    expect(store.state).toBe("auth-failed");
  });
});

describe("nick rejected (item 9)", () => {
  const rejectNick = (numeric: string) => {
    const h = makeBridge();
    h.ircd.stallRegistration = true;
    h.ircd.hooks.push((m, conn, d) => {
      if (m.command === "NICK") d.reply(conn, `:seance.local ${numeric} * ${m.params[0] ?? ""} :Nickname problem`);
    });
    return h;
  };

  it.each(["432", "433"])("%s during registration enters nick-rejected and does not reconnect", (numeric) => {
    const { bridge, ircd, store, advance } = rejectNick(numeric);
    bridge.start(CONFIG);
    ircd.run();
    expect(store.state).toBe("nick-rejected");
    expect(ircd.connections[0]?.open).toBe(false);
    advance(10 * 60_000);
    expect(ircd.totalConnections).toBe(1);
    expect(store.state).toBe("nick-rejected");
  });

  it("an identical config changes nothing, a changed nick reconnects", () => {
    const { bridge, ircd, store } = rejectNick("433");
    bridge.start(CONFIG);
    ircd.run();
    bridge.applyConfig({ ...CONFIG });
    ircd.run();
    expect(ircd.totalConnections).toBe(1);
    ircd.hooks.length = 0;
    ircd.stallRegistration = false;
    ircd.accounts = { crew2: "s3cret" };
    bridge.applyConfig({ ...CONFIG, nick: "crew2" });
    ircd.run();
    expect(ircd.totalConnections).toBe(2);
    expect(store.state).toBe("registered");
  });

  it("433 after registration does not change the state", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, [":seance.local 433 crew crew2 :Nickname is already in use"]);
    ircd.run();
    expect(store.state).toBe("registered");
  });
});

describe("nick validation and caps (item 10)", () => {
  const registered = () => {
    const h = makeBridge({ rebuild: true });
    h.bridge.start(CONFIG);
    h.ircd.run();
    return h;
  };

  it("drops invalid nicks (comma lists, control characters, empty) from NAMES", () => {
    const { ircd, store } = registered();
    ircd.sendLines(ircd.last, [
      ":seance.local 353 crew = #c :@crew good,bad +ok2 a\u0001b 9starts-with-digit =x",
      ":seance.local 366 crew #c :End of /NAMES list.",
    ]);
    ircd.run();
    const nicks = [...(store.channel("#c")?.members.values() ?? [])].map((m) => m.nick).sort();
    expect(nicks).toEqual(["crew", "ok2"]);
  });

  it("drops a JOIN from an invalid nick", () => {
    const { ircd, store } = registered();
    ircd.sendLines(ircd.last, [":bad,nick!u@h JOIN #c", ":fine!u@h JOIN #c"]);
    ircd.run();
    expect([...(store.channel("#c")?.members.values() ?? [])].map((m) => m.nick)).toEqual(["fine"]);
  });

  it("never sends a WHOIS for an invalid nick", () => {
    const { rebuilder, ircd } = registered();
    for (const bad of ["a,b", "bad nick", "", "x\ry", "#chan"]) rebuilder?.requestWhois(bad);
    ircd.run();
    expect(ircd.lines.filter((l) => l.startsWith("WHOIS"))).toEqual([]);
    rebuilder?.requestWhois("good");
    ircd.run();
    expect(ircd.lines).toContain("WHOIS good");
  });

  it("caps stored channels at 500 and warns once", () => {
    const { ircd, store, logs } = registered();
    const lines = Array.from({ length: 600 }, (_, i) => `:seance.local 322 crew #c${i} 1 :t`);
    lines.push(":seance.local 323 crew :End of /LIST");
    ircd.sendLines(ircd.last, lines);
    ircd.run();
    expect(store.listChannels().length).toBeLessThanOrEqual(MAX_CHANNELS);
    expect(store.listChannels().length).toBe(MAX_CHANNELS);
    expect(warnings(logs).filter((w) => String(w["msg"]).startsWith("channel limit"))).toHaveLength(1);
  });

  it("does not create channels past the cap from JOIN or PRIVMSG either", () => {
    const { ircd, store } = registered();
    const lines = Array.from({ length: MAX_CHANNELS }, (_, i) => `:seance.local 322 crew #c${i} 1 :t`);
    lines.push(":seance.local 323 crew :End of /LIST");
    ircd.sendLines(ircd.last, lines);
    ircd.run();
    ircd.sendLines(ircd.last, [":x!u@h JOIN #extra", ":x!u@h PRIVMSG #extra2 :hi", ":seance.local 332 crew #extra3 :topic"]);
    ircd.run();
    expect(store.channel("#extra")).toBeUndefined();
    expect(store.channel("#extra2")).toBeUndefined();
    expect(store.channel("#extra3")).toBeUndefined();
    expect(store.allChannels().length).toBe(MAX_CHANNELS);
  });

  it("caps members per channel at 500 and warns once", () => {
    const { ircd, store, logs } = registered();
    const lines: string[] = [];
    for (let chunk = 0; chunk < 12; chunk++) {
      const names = Array.from({ length: 50 }, (_, i) => `n${chunk * 50 + i}`).join(" ");
      lines.push(`:seance.local 353 crew = #big :${names}`);
    }
    lines.push(":seance.local 366 crew #big :End of /NAMES list.");
    ircd.sendLines(ircd.last, lines);
    ircd.run();
    expect(store.channel("#big")?.members.size).toBe(MAX_MEMBERS);
    expect(warnings(logs).filter((w) => String(w["msg"]).startsWith("channel member limit"))).toHaveLength(1);
  });

  it("caps JOINs at 500 members as well", () => {
    const { ircd, store } = registered();
    const lines = Array.from({ length: 520 }, (_, i) => `:m${i}!u@h JOIN #big`);
    ircd.sendLines(ircd.last, lines);
    ircd.run();
    expect(store.channel("#big")?.members.size).toBe(MAX_MEMBERS);
  });

  it("logs how many nicks the WHOIS queue cap dropped during a rebuild", () => {
    const h = makeBridge({ rebuild: true });
    h.ircd.silentWhois = true;
    // 8 channels with 40 members each (a NAMES line must stay under 512 bytes): 320 distinct nicks.
    h.ircd.channels = Array.from({ length: 8 }, (_, c) => ({
      name: `#c${c}`,
      count: 41,
      topic: "",
      names: [...Array.from({ length: 40 }, (_, i) => `u${c * 40 + i}`), "crew"],
    }));
    h.bridge.start(CONFIG);
    h.ircd.run();
    h.advance(20_000); // the send queue releases one line per second after the first 8
    const dropped = warnings(h.logs).filter((w) => String(w["msg"]).includes("WHOIS queue is full"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.["dropped"]).toBeGreaterThan(0);
  });
});

describe("sweep timer and startup failures (items 4 and 11)", () => {
  const roots: string[] = [];
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const makePaths = (): AppPaths => {
    const root = mkdtempSync(path.join(os.tmpdir(), "seance-fix-"));
    roots.push(root);
    writeFileSync(path.join(root, "app.json"), "{}");
    return appPaths(root);
  };
  const deps = (paths: AppPaths, port: number, clock: FakeClock) => ({
    paths,
    env: { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476" },
    port,
    clock,
    logger: createLogger([], () => undefined),
    fetch: (async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes("/token") ? { token: "t" } : { secret: "" }) })) as FetchLike,
    readFile: async () => "app-secret",
  });

  it("sweeps channels left 10 minutes ago on a 60 s timer without any LIST, and stops the timer on stop()", async () => {
    const clock = new FakeClock();
    const app = await startApp(deps(makePaths(), 0, clock));
    const channel = app.store.ensureChannel("#old");
    app.store.markLeft(channel);
    clock.advance(9 * 60_000);
    expect(app.store.channel("#old")).toBeDefined();
    clock.advance(2 * 60_000);
    expect(app.store.channel("#old")).toBeUndefined();
    const before = clock.pending;
    await app.stop();
    expect(clock.pending).toBeLessThan(before);
    expect(clock.pending).toBe(0);
  });

  it("releases the lock when listen fails", async () => {
    const blocker = net.createServer();
    servers.push(blocker);
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port));
    });
    const paths = makePaths();
    await expect(startApp(deps(paths, port, new FakeClock()))).rejects.toThrow();
    expect(existsSync(paths.lockFile)).toBe(false);
  });
});
