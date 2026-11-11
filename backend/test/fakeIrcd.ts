// In-process fake Séance ircd plus a WebSocket-compatible socket. No ports, no network.
// All traffic goes through an event queue that only moves when a test calls run().
import { isParseError, LineFramer, parse, type IrcMessage } from "../vendor/irc-protocol/src/index.js";
import { READY_STATE, type SocketLike } from "../src/irc/socket.js";

type Task = () => void;

export class FakeSocket implements SocketLike {
  readyState: number = READY_STATE.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Origin header sent by this client: always undefined, like Node's global WebSocket. */
  readonly origin: string | undefined = undefined;

  constructor(
    readonly url: string,
    private readonly server: FakeIrcd,
    readonly conn: FakeConnection,
  ) {}

  send(data: string): void {
    if (this.readyState !== READY_STATE.OPEN) throw new Error(`FakeSocket.send in readyState ${this.readyState}`);
    this.server.enqueue(() => {
      this.server.receive(this.conn, data);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === READY_STATE.CLOSING || this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSING;
    this.server.enqueue(() => {
      this.finishClose(code, reason);
    });
  }

  /** Server side: deliver a text frame. */
  deliver(data: unknown): void {
    if (this.readyState === READY_STATE.OPEN) this.onmessage?.({ data });
  }

  finishClose(code: number, reason: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    this.conn.open = false;
    this.server.connectionClosed(this.conn);
    this.onclose?.({ code, reason });
  }
}

export interface FakeConnection {
  readonly id: number;
  socket: FakeSocket | undefined;
  readonly framer: LineFramer;
  open: boolean;
  registered: boolean;
  pass: string | undefined;
  nick: string | undefined;
  user: string | undefined;
  /** Every raw line received from the client, in order. */
  readonly received: string[];
}

export interface FakeWhois {
  readonly user?: string;
  readonly host?: string;
  readonly channels?: string;
  /** Text of each 320 line, for example "model: claude" or "credits: #dev 0.10 / total 0.20". */
  readonly info?: readonly string[];
  readonly idle?: number;
}

export interface FakeChannel {
  readonly name: string;
  readonly count: number;
  readonly topic: string;
  /** NAMES entries with their mode prefix, for example "@crew", "+coder", "coder". */
  readonly names: readonly string[];
}

export type LineHook = (message: IrcMessage, conn: FakeConnection, ircd: FakeIrcd) => void;

export class FakeIrcd {
  serverName = "seance.local";
  /** account nick -> secret. */
  accounts: Record<string, string> = { crew: "s3cret" };
  channels: FakeChannel[] = [];
  whois: Record<string, FakeWhois> = {};
  /** When true the server accepts the socket but never answers the handshake. */
  stallRegistration = false;
  /** When true the next connect attempts fail with an error and a close. */
  refuseConnections = false;
  /** When true WHOIS commands are recorded but never answered. */
  silentWhois = false;
  /** lower-cased channel name -> numeric (for example "474") answered to JOIN instead of joining; "" means no answer. */
  joinRefusals: Record<string, string> = {};
  readonly connections: FakeConnection[] = [];
  readonly hooks: LineHook[] = [];
  maxConcurrent = 0;
  totalConnections = 0;
  readonly urls: string[] = [];
  private queue: Task[] = [];
  private nextId = 1;

  /** Use as the bridge's socket factory: `createSocket: (url) => ircd.connect(url)`. */
  connect(url: string): FakeSocket {
    this.urls.push(url);
    this.totalConnections += 1;
    const conn: FakeConnection = {
      id: this.nextId++,
      socket: undefined,
      framer: new LineFramer(),
      open: false,
      registered: false,
      pass: undefined,
      nick: undefined,
      user: undefined,
      received: [],
    };
    const socket = new FakeSocket(url, this, conn);
    conn.socket = socket;
    this.connections.push(conn);
    this.enqueue(() => {
      if (this.refuseConnections) {
        socket.onerror?.({ message: "connection refused" });
        socket.finishClose(1006, "refused");
        return;
      }
      socket.readyState = READY_STATE.OPEN;
      conn.open = true;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.connections.filter((c) => c.open).length);
      socket.onopen?.({});
    });
    return socket;
  }

  enqueue(task: Task): void {
    this.queue.push(task);
  }

  /** Process queued events until the network is quiet. */
  run(): void {
    let guard = 0;
    while (this.queue.length > 0) {
      if (++guard > 100_000) throw new Error("FakeIrcd.run did not settle");
      const task = this.queue.shift();
      task?.();
    }
  }

  get last(): FakeConnection {
    const conn = this.connections.at(-1);
    if (conn === undefined) throw new Error("no connection yet");
    return conn;
  }

  /** Lines received on the latest connection, with the PASS line kept as is (tests only). */
  get lines(): readonly string[] {
    return this.last.received;
  }

  /** Lines received on all connections. */
  get allLines(): readonly string[] {
    return this.connections.flatMap((c) => c.received);
  }

  /** Server to client: send lines, joined into one frame. */
  sendLines(conn: FakeConnection, lines: readonly string[]): void {
    this.sendFrame(conn, lines.map((l) => `${l}\r\n`).join(""));
  }

  /** Server to client: one text frame, exactly as given (may hold partial lines). */
  sendFrame(conn: FakeConnection, data: string): void {
    this.enqueue(() => {
      conn.socket?.deliver(data);
    });
  }

  /** Server to client: a raw binary-looking frame. */
  sendBinary(conn: FakeConnection): void {
    this.enqueue(() => {
      conn.socket?.deliver(new Uint8Array([1, 2, 3]));
    });
  }

  /** Server closes the connection. */
  drop(conn: FakeConnection, code = 1006, reason = "dropped"): void {
    this.enqueue(() => {
      conn.socket?.finishClose(code, reason);
    });
  }

  connectionClosed(_conn: FakeConnection): void {
    // Hook point for tests that count connections; open flags are maintained by FakeSocket.
  }

  /** Client to server data: framed, parsed, handled. */
  receive(conn: FakeConnection, data: string): void {
    for (const event of conn.framer.push(data)) {
      if (event.kind === "overlong") {
        this.reply(conn, `:${this.serverName} 417 ${conn.nick ?? "*"} :Input line was too long`);
        continue;
      }
      conn.received.push(event.line);
      const message = parse(event.line);
      if (isParseError(message)) continue;
      this.handle(conn, message);
      for (const hook of this.hooks) hook(message, conn, this);
    }
  }

  reply(conn: FakeConnection, line: string): void {
    this.sendLines(conn, [line]);
  }

  private nickOf(conn: FakeConnection): string {
    return conn.nick ?? "*";
  }

  private handle(conn: FakeConnection, m: IrcMessage): void {
    const me = this.nickOf(conn);
    const s = this.serverName;
    switch (m.command) {
      case "PASS":
        conn.pass = m.params[0];
        break;
      case "NICK":
        conn.nick = m.params[0];
        this.maybeRegister(conn);
        break;
      case "USER":
        conn.user = m.params[0];
        this.maybeRegister(conn);
        break;
      case "PING":
        this.reply(conn, `:${s} PONG ${s} :${m.params[0] ?? ""}`);
        break;
      case "LIST": {
        const lines = this.channels.map((c) => `:${s} 322 ${me} ${c.name} ${c.count} :${c.topic}`);
        lines.push(`:${s} 323 ${me} :End of /LIST`);
        this.sendLines(conn, lines);
        break;
      }
      case "NAMES": {
        const name = m.params[0] ?? "";
        const channel = this.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
        const lines = channel === undefined ? [] : [`:${s} 353 ${me} = ${channel.name} :${channel.names.join(" ")}`];
        lines.push(`:${s} 366 ${me} ${name} :End of /NAMES list.`);
        this.sendLines(conn, lines);
        break;
      }
      case "JOIN": {
        const name = m.params[0] ?? "";
        const refusal = this.joinRefusals[name.toLowerCase()];
        if (refusal === "") break; // "" = never answer
        if (refusal !== undefined) {
          this.reply(conn, `:${s} ${refusal} ${me} ${name} :Cannot join channel`);
          break;
        }
        const existing = this.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
        const names = existing?.names ?? [];
        const joinedNames = names.some((n) => n.replace(/^[@+]/, "").toLowerCase() === me.toLowerCase()) ? names : [...names, `@${me}`];
        const channel: FakeChannel = { name: existing?.name ?? name, topic: existing?.topic ?? "", count: joinedNames.length, names: joinedNames };
        this.channels = [...this.channels.filter((c) => c !== existing), channel];
        this.sendLines(conn, [`:${me}!u@h JOIN ${channel.name}`, `:${s} 353 ${me} = ${channel.name} :${channel.names.join(" ")}`, `:${s} 366 ${me} ${channel.name} :End of /NAMES list.`]);
        break;
      }
      case "WHOIS": {
        if (this.silentWhois) break;
        const target = m.params[0] ?? "";
        const info = this.whois[target];
        if (info === undefined) {
          this.sendLines(conn, [`:${s} 401 ${me} ${target} :No such nick/channel`, `:${s} 318 ${me} ${target} :End of /WHOIS list.`]);
          break;
        }
        const lines = [
          `:${s} 311 ${me} ${target} ${info.user ?? target} ${info.host ?? "seance.local"} * :${target}`,
          `:${s} 312 ${me} ${target} ${s} :Seance`,
        ];
        if (info.channels !== undefined) lines.push(`:${s} 319 ${me} ${target} :${info.channels}`);
        for (const text of info.info ?? []) lines.push(`:${s} 320 ${me} ${target} :${text}`);
        lines.push(`:${s} 317 ${me} ${target} ${info.idle ?? 0} 0 :seconds idle, signon time`);
        lines.push(`:${s} 318 ${me} ${target} :End of /WHOIS list.`);
        this.sendLines(conn, lines);
        break;
      }
      case "QUIT":
        this.enqueue(() => {
          conn.socket?.finishClose(1000, "quit");
        });
        break;
      default:
        break; // INVITE, MODE, KICK, PRIVMSG and the rest are only recorded; hooks may answer.
    }
  }

  private maybeRegister(conn: FakeConnection): void {
    if (conn.registered || this.stallRegistration) return;
    if (conn.nick === undefined || conn.user === undefined || conn.pass === undefined) return;
    const secret = this.accounts[conn.nick];
    if (secret === undefined || conn.pass !== `${conn.nick}:${secret}`) {
      this.sendLines(conn, [`:${this.serverName} 464 * :Password incorrect`, "ERROR :Closing Link: authentication failed"]);
      this.drop(conn, 1008, "authentication failed");
      return;
    }
    conn.registered = true;
    this.reply(conn, `:${this.serverName} 001 ${conn.nick} :Welcome to the Seance network ${conn.nick}`);
  }
}
