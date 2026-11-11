import { describe, expect, it } from "vitest";
import { READY_STATE } from "../src/irc/socket.js";
import { FakeIrcd, type FakeSocket } from "./fakeIrcd.js";

const connect = (ircd: FakeIrcd, nick = "crew", secret = "s3cret") => {
  const socket = ircd.connect("wss://example.test/ws");
  const received: string[] = [];
  let closed: { code?: number | undefined } | undefined;
  socket.onmessage = (e) => received.push(String(e.data));
  socket.onclose = (e) => {
    closed = { code: e.code };
  };
  socket.onopen = () => {
    socket.send(`PASS ${nick}:${secret}\r\nNICK ${nick}\r\nUSER ${nick} 0 * :seance-crew\r\n`);
  };
  ircd.run();
  return { socket, received, closedInfo: () => closed };
};

describe("FakeIrcd handshake", () => {
  it("accepts a valid PASS/NICK/USER and sends 001", () => {
    const ircd = new FakeIrcd();
    const { received, socket } = connect(ircd);
    expect(socket.readyState).toBe(READY_STATE.OPEN);
    expect(received.join("")).toContain(" 001 crew ");
    expect(ircd.last.registered).toBe(true);
    expect(ircd.lines).toEqual(["PASS crew:s3cret", "NICK crew", "USER crew 0 * :seance-crew"]);
  });

  it("rejects a bad PASS with 464 and closes", () => {
    const ircd = new FakeIrcd();
    const { received, socket, closedInfo } = connect(ircd, "crew", "wrong");
    expect(received.join("")).toContain(" 464 ");
    expect(received.join("")).toContain("ERROR");
    expect(socket.readyState).toBe(READY_STATE.CLOSED);
    expect(closedInfo()?.code).toBe(1008);
    expect(ircd.last.registered).toBe(false);
  });

  it("can stall registration", () => {
    const ircd = new FakeIrcd();
    ircd.stallRegistration = true;
    const { received } = connect(ircd);
    expect(received).toEqual([]);
  });

  it("can refuse connections with an error and a close", () => {
    const ircd = new FakeIrcd();
    ircd.refuseConnections = true;
    const { socket, closedInfo } = connect(ircd);
    expect(socket.readyState).toBe(READY_STATE.CLOSED);
    expect(closedInfo()?.code).toBe(1006);
  });

  it("sends no Origin header", () => {
    const ircd = new FakeIrcd();
    const { socket } = connect(ircd);
    expect((socket as FakeSocket).origin).toBeUndefined();
  });
});

describe("FakeIrcd framing", () => {
  it("delivers several lines in one frame", () => {
    const ircd = new FakeIrcd();
    const { received } = connect(ircd);
    received.length = 0;
    ircd.sendLines(ircd.last, ["PING :a", "PING :b"]);
    ircd.run();
    expect(received).toEqual(["PING :a\r\nPING :b\r\n"]);
  });

  it("delivers a partial line across frames", () => {
    const ircd = new FakeIrcd();
    const { received } = connect(ircd);
    received.length = 0;
    ircd.sendFrame(ircd.last, "PING :ab");
    ircd.sendFrame(ircd.last, "c\r\n");
    ircd.run();
    expect(received).toEqual(["PING :ab", "c\r\n"]);
  });

  it("buffers partial client lines too", () => {
    const ircd = new FakeIrcd();
    const { socket } = connect(ircd);
    socket.send("PIN");
    socket.send("G :x\r\n");
    ircd.run();
    expect(ircd.lines.at(-1)).toBe("PING :x");
  });

  it("answers PING with PONG", () => {
    const ircd = new FakeIrcd();
    const { socket, received } = connect(ircd);
    received.length = 0;
    socket.send("PING :token\r\n");
    ircd.run();
    expect(received.join("")).toContain("PONG seance.local :token");
  });
});

describe("FakeIrcd queries", () => {
  it("answers LIST, NAMES and WHOIS", () => {
    const ircd = new FakeIrcd();
    ircd.channels = [{ name: "#dev", count: 2, topic: "work", names: ["@crew", "+coder"] }];
    ircd.whois["coder"] = { channels: "+#dev", info: ["model: claude", "tools: shell", "credits: #dev 0.10 / total 0.20"] };
    const { socket, received } = connect(ircd);
    received.length = 0;
    socket.send("LIST\r\nNAMES #dev\r\nWHOIS coder\r\nWHOIS ghost\r\n");
    ircd.run();
    const text = received.join("");
    expect(text).toContain("322 crew #dev 2 :work");
    expect(text).toContain("323 crew");
    expect(text).toContain("353 crew = #dev :@crew +coder");
    expect(text).toContain("366 crew #dev");
    expect(text).toContain("320 crew coder :model: claude");
    expect(text).toContain("318 crew coder");
    expect(text).toContain("401 crew ghost");
  });

  it("records INVITE, MODE and KICK and lets hooks answer", () => {
    const ircd = new FakeIrcd();
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "INVITE") d.reply(conn, ":ChanServ!ChanServ@services.seance.local NOTICE #dev :coder is ready");
    });
    const { socket, received } = connect(ircd);
    received.length = 0;
    socket.send("INVITE coder #dev\r\nMODE #dev +v coder\r\nKICK #dev coder :bye\r\n");
    ircd.run();
    expect(ircd.lines.slice(-3)).toEqual(["INVITE coder #dev", "MODE #dev +v coder", "KICK #dev coder :bye"]);
    expect(received.join("")).toContain("coder is ready");
  });

  it("tracks the number of concurrently open connections", () => {
    const ircd = new FakeIrcd();
    connect(ircd);
    connect(ircd);
    expect(ircd.maxConcurrent).toBe(2);
    expect(ircd.totalConnections).toBe(2);
  });
});
