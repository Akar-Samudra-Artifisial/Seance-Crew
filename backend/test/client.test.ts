import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { backoffDelay, REGISTRATION_TIMEOUT_MS } from "../src/irc/client.js";
import { LineError } from "../src/irc/line.js";
import { makeBridge } from "./helpers.js";

const CONFIG: Config = { host: "irc.example.org", nick: "crew", secret: "s3cret" };

describe("handshake", () => {
  it("connects to wss://<host>/ws and sends PASS, NICK, USER in order", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    expect(ircd.urls).toEqual(["wss://irc.example.org/ws"]);
    expect(ircd.lines).toEqual(["PASS crew:s3cret", "NICK crew", "USER crew 0 * :seance-crew"]);
    expect(store.state).toBe("registered");
    expect(store.ownNick).toBe("crew");
  });

  it("sends no Origin header (the socket has none)", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    expect(ircd.last.socket?.origin).toBeUndefined();
  });

  it("goes connecting -> registered", () => {
    const { bridge, ircd, states } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    expect(states).toEqual(["connecting", "registered"]);
  });

  it("closes the socket when registration takes longer than 15 seconds and treats it as a failed attempt", () => {
    const { bridge, ircd, clock, store } = makeBridge();
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    expect(store.state).toBe("connecting");
    clock.advance(REGISTRATION_TIMEOUT_MS - 1);
    ircd.run();
    expect(ircd.last.open).toBe(true);
    clock.advance(1);
    ircd.run();
    expect(ircd.connections[0]?.open).toBe(false);
    expect(store.state).toBe("reconnecting");
  });

  it("never logs the secret or a PASS line with credentials", () => {
    const { bridge, ircd, logs } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    const text = logs.join("\n");
    expect(text).toContain("PASS ***");
    expect(text).not.toContain("s3cret");
  });
});

describe("keepalive", () => {
  it("answers PING with PONG and the same token", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, ["PING :abc123"]);
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PONG abc123");
  });

  it("answers PING even when the send queue is exhausted", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    for (let i = 0; i < 20; i++) bridge.send("PRIVMSG", ["#c", `m ${i}`], { priority: "low" });
    ircd.sendLines(ircd.last, ["PING :now"]);
    ircd.run();
    expect(ircd.lines).toContain("PONG now");
  });

  it("handles a PING split across two frames", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendFrame(ircd.last, "PING :sp");
    ircd.sendFrame(ircd.last, "lit\r\n");
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PONG split");
  });

  it("uses no WebSocket-level ping (the socket has no ping method)", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    expect("ping" in (ircd.last.socket ?? {})).toBe(false);
  });

  it("sends its own PING after 120 s of silence and stays connected when the server answers", () => {
    const { bridge, ircd, clock, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    clock.advance(119_999);
    ircd.run();
    expect(ircd.lines.some((l) => l.startsWith("PING"))).toBe(false);
    clock.advance(1);
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PING crew");
    clock.advance(30_000);
    ircd.run();
    expect(store.state).toBe("registered");
    expect(ircd.last.open).toBe(true);
  });

  it("closes the socket and reconnects when nothing arrives within 30 s of its PING", () => {
    const { bridge, ircd, clock, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.hooks.push(() => undefined);
    // Make the fake server silent: swallow PINGs by stalling delivery.
    const conn = ircd.last;
    const socket = conn.socket!;
    const original = socket.deliver.bind(socket);
    socket.deliver = () => undefined;
    clock.advance(120_000);
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PING crew");
    clock.advance(30_000);
    ircd.run();
    expect(conn.open).toBe(false);
    expect(store.state).toBe("reconnecting");
    socket.deliver = original;
  });
});

describe("authentication failure", () => {
  it("moves to auth-failed on 464 and never reconnects", () => {
    const { bridge, ircd, advance, store } = makeBridge();
    bridge.start({ ...CONFIG, secret: "wrong" });
    ircd.run();
    expect(store.state).toBe("auth-failed");
    advance(10 * 60_000);
    expect(ircd.totalConnections).toBe(1);
    expect(store.state).toBe("auth-failed");
  });

  it("moves to auth-failed on an ERROR line that mentions authentication", () => {
    const { bridge, ircd, store } = makeBridge();
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, ["ERROR :Closing Link: authentication failed"]);
    ircd.run();
    expect(store.state).toBe("auth-failed");
  });

  it("does not treat a later ERROR as an authentication failure once registered", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, ["ERROR :Closing Link: ping timeout (password rotation)"]);
    ircd.drop(ircd.last);
    ircd.run();
    expect(store.state).toBe("reconnecting");
  });
});

describe("Property 3: one socket at a time", () => {
  it("never has two sockets open, across drops, timeouts and reconnects", () => {
    const { bridge, ircd, advance } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    for (let i = 0; i < 6; i++) {
      ircd.drop(ircd.last);
      ircd.run();
      advance(70_000);
    }
    expect(ircd.totalConnections).toBe(7);
    expect(ircd.maxConcurrent).toBe(1);
    expect(ircd.connections.filter((c) => c.open)).toHaveLength(1);
  });

  it("start() twice does not open a second socket", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    bridge.start(CONFIG);
    ircd.run();
    expect(ircd.totalConnections).toBe(1);
  });

  it("does not create a new socket while the old one is still closing", () => {
    const { bridge, ircd, clock } = makeBridge();
    ircd.stallRegistration = true;
    bridge.start(CONFIG);
    ircd.run();
    clock.advance(REGISTRATION_TIMEOUT_MS);
    // The close is queued but not yet delivered: no new socket may exist.
    expect(ircd.totalConnections).toBe(1);
    ircd.run();
    clock.advance(1_000);
    ircd.run();
    expect(ircd.totalConnections).toBe(2);
    expect(ircd.maxConcurrent).toBe(1);
  });
});

describe("framing", () => {
  it("ignores a binary frame and counts it", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendBinary(ircd.last);
    ircd.run();
    expect(store.diagnostics.binaryFrames).toBe(1);
    expect(store.state).toBe("registered");
  });

  it("drops overlong and unparsable lines and keeps going", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendFrame(ircd.last, `${"x".repeat(600)}\r\n`);
    ircd.sendFrame(ircd.last, "!!! not irc\r\n");
    ircd.sendLines(ircd.last, ["PING :alive"]);
    ircd.run();
    expect(store.diagnostics.overlongLines).toBe(1);
    expect(store.diagnostics.droppedLines).toBe(1);
    expect(ircd.lines.at(-1)).toBe("PONG alive");
  });

  it("processes several lines in one frame in order", () => {
    const { bridge, ircd, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.sendLines(ircd.last, [":alice!a@h PRIVMSG #dev :one", ":alice!a@h PRIVMSG #dev :two"]);
    ircd.run();
    expect(store.channel("#dev")?.ring.newest(5).map((l) => l.text)).toEqual(["one", "two"]);
  });
});

describe("sending", () => {
  it("rejects a send while not registered and does not buffer it", () => {
    const { bridge, ircd } = makeBridge();
    expect(() => bridge.send("PRIVMSG", ["#c", "early"])).toThrow(LineError);
    try {
      bridge.send("PRIVMSG", ["#c", "early"]);
    } catch (err) {
      expect((err as LineError).code).toBe("not-registered");
      expect((err as LineError).message).toContain("unconfigured");
    }
    bridge.start(CONFIG);
    ircd.run();
    expect(ircd.lines.some((l) => l.includes("early"))).toBe(false);
  });

  it("sends validated lines once registered and rejects bad ones before anything is queued", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    bridge.send("PRIVMSG", ["#dev", "hello there"]);
    expect(() => bridge.send("PRIVMSG", ["#dev", "a\r\nQUIT"])).toThrow(LineError);
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PRIVMSG #dev :hello there");
    expect(ircd.lines.some((l) => l.startsWith("QUIT"))).toBe(false);
  });

  it("rejects sends after the connection drops until it registers again", () => {
    const { bridge, ircd } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.drop(ircd.last);
    ircd.run();
    expect(() => bridge.send("PRIVMSG", ["#c", "x"])).toThrow(LineError);
  });
});

describe("shutdown", () => {
  it("sends QUIT, closes the socket and never reconnects", () => {
    const { bridge, ircd, advance } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    bridge.stop();
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("QUIT :seance-crew shutting down");
    expect(ircd.last.open).toBe(false);
    advance(5 * 60_000);
    expect(ircd.totalConnections).toBe(1);
  });

  it("stop before start opens nothing", () => {
    const { bridge, ircd } = makeBridge();
    bridge.stop();
    bridge.start(CONFIG);
    ircd.run();
    expect(ircd.totalConnections).toBe(0);
  });
});

describe("backoffDelay (used by reconnect)", () => {
  it("doubles from 1 s to a 60 s cap with jitter up to 25 percent", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, () => 0))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(backoffDelay(0, () => 1)).toBe(1250);
    expect(backoffDelay(10, () => 1)).toBe(75000);
  });
});
