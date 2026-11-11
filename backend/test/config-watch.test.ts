import { describe, expect, it } from "vitest";
import { createConfigWatcher, CONFIG_POLL_MS } from "../src/config-watch.js";
import { ConfigError, type ConfigResult } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { makeBridge } from "./helpers.js";

type Next = ConfigResult | Error;

const ok = (secret: string, extra: { host?: string; nick?: string } = {}): ConfigResult => ({
  kind: "ok",
  config: { host: extra.host ?? "irc.example.org", nick: extra.nick ?? "crew", secret },
  token: "tok",
  appSecret: "app",
});
const unconfigured: ConfigResult = { kind: "unconfigured", host: "irc.example.org", nick: "crew", token: "tok", appSecret: "app" };

const setup = () => {
  const h = makeBridge();
  const logs: string[] = [];
  const logger = createLogger([], (l) => logs.push(l), () => h.clock.now());
  let next: Next = unconfigured;
  let loads = 0;
  const watcher = createConfigWatcher({
    load: async () => {
      loads += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    bridge: h.bridge,
    clock: h.clock,
    logger,
  });
  /** Advance time and let promises and the in-process network settle. */
  const tick = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 500) {
      h.clock.advance(Math.min(500, left));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      h.ircd.run();
    }
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    h.ircd.run();
  };
  return { ...h, logs, watcher, tick, settle, setNext: (n: Next) => (next = n), loads: () => loads };
};

describe("config watcher", () => {
  it("stays unconfigured and polls every 30 seconds until a secret appears, then connects", async () => {
    const s = setup();
    await s.watcher.start();
    expect(s.store.state).toBe("unconfigured");
    expect(s.loads()).toBe(1);
    await s.tick(CONFIG_POLL_MS * 3);
    expect(s.loads()).toBe(4);
    expect(s.ircd.totalConnections).toBe(0);

    s.setNext(ok("s3cret"));
    await s.tick(CONFIG_POLL_MS);
    expect(s.store.state).toBe("registered");
    expect(s.ircd.totalConnections).toBe(1);
    s.watcher.stop();
  });

  it("connects immediately when the first load already has a secret", async () => {
    const s = setup();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    expect(s.store.state).toBe("registered");
    s.watcher.stop();
  });

  it("does not reconnect when the config is unchanged", async () => {
    const s = setup();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    await s.tick(CONFIG_POLL_MS * 4);
    expect(s.ircd.totalConnections).toBe(1);
    expect(s.store.state).toBe("registered");
    s.watcher.stop();
  });

  it.each([
    ["host", ok("s3cret", { host: "irc2.example.org" })],
    ["nick", ok("s3cret", { nick: "crew2" })],
    ["secret", ok("newsecret")],
  ])("reconnects once, with one socket at a time, when the %s changes", async (_what, changed) => {
    const s = setup();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    // After the first connection, the server-side accounts match the changed config.
    const newSecret = changed.kind === "ok" ? changed.config.secret : "";
    s.ircd.accounts = { crew: newSecret === "newsecret" ? "newsecret" : "s3cret", crew2: "s3cret" };
    s.setNext(changed);
    await s.tick(CONFIG_POLL_MS);
    await s.tick(2_000);
    expect(s.ircd.totalConnections).toBe(2);
    expect(s.ircd.maxConcurrent).toBe(1);
    expect(s.store.state).toBe("registered");
    const expectedHost = changed.kind === "ok" ? changed.config.host : "";
    expect(s.ircd.urls.at(-1)).toBe(`wss://${expectedHost}/ws`);
    expect(s.store.ownNick).toBe(changed.kind === "ok" ? changed.config.nick : "");
    s.watcher.stop();
  });

  it("leaves auth-failed when the config changes", async () => {
    const s = setup();
    s.setNext(ok("wrong"));
    await s.watcher.start();
    s.ircd.run();
    expect(s.store.state).toBe("auth-failed");
    await s.tick(CONFIG_POLL_MS * 2);
    expect(s.store.state).toBe("auth-failed"); // same config: no retry loop
    expect(s.ircd.totalConnections).toBe(1);
    s.setNext(ok("s3cret"));
    await s.tick(CONFIG_POLL_MS);
    expect(s.store.state).toBe("registered");
    expect(s.ircd.totalConnections).toBe(2);
    s.watcher.stop();
  });

  it("disconnects and stays quiet when the secret is removed", async () => {
    const s = setup();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    s.setNext(unconfigured);
    await s.tick(CONFIG_POLL_MS);
    expect(s.store.state).toBe("unconfigured");
    expect(s.ircd.last.open).toBe(false);
    await s.tick(CONFIG_POLL_MS * 3);
    expect(s.ircd.totalConnections).toBe(1);
    s.watcher.stop();
  });

  it("keeps a working connection when the gateway fails, and logs each problem once", async () => {
    const s = setup();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    s.setNext(new ConfigError("config", "the gateway answered HTTP 503"));
    await s.tick(CONFIG_POLL_MS * 3);
    expect(s.store.state).toBe("registered");
    expect(s.ircd.totalConnections).toBe(1);
    expect(s.logs.filter((l) => l.includes("HTTP 503"))).toHaveLength(1);
    s.setNext(ok("s3cret"));
    await s.tick(CONFIG_POLL_MS);
    s.setNext(new ConfigError("config", "the gateway answered HTTP 503"));
    await s.tick(CONFIG_POLL_MS);
    expect(s.logs.filter((l) => l.includes("HTTP 503"))).toHaveLength(2);
    s.watcher.stop();
  });

  it("stop() ends the polling", async () => {
    const s = setup();
    await s.watcher.start();
    s.watcher.stop();
    const before = s.loads();
    await s.tick(CONFIG_POLL_MS * 5);
    expect(s.loads()).toBe(before);
    expect(s.clock.pending).toBe(0);
  });

  it("does nothing for a duplicate instance", async () => {
    const s = setup();
    s.bridge.setDuplicateInstance();
    s.setNext(ok("s3cret"));
    await s.watcher.start();
    s.ircd.run();
    expect(s.ircd.totalConnections).toBe(0);
    expect(s.store.state).toBe("duplicate-instance");
    s.watcher.stop();
  });

  it("never logs the app secret, token or Séance secret", async () => {
    const s = setup();
    s.setNext({ kind: "ok", config: { host: "irc.example.org", nick: "crew", secret: "s3cret" }, token: "tok-leak-1", appSecret: "app-leak-2" });
    await s.watcher.start();
    s.ircd.run();
    expect(s.logs.join("\n")).not.toContain("s3cret");
    s.watcher.stop();
  });
});
