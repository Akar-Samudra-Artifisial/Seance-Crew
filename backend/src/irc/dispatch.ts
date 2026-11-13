// Maps parsed IRC messages to store updates and typed events. Connection control (001, PING, 464, ERROR) is the client's job.
import { irc_lower, isValidChannel, isValidNick, type IrcMessage } from "../../vendor/irc-protocol/src/index.js";
import type { Logger } from "../log.js";
import { stripFormatting } from "./format.js";
import { parseNotice, type DeniedReason } from "./notices.js";
import { RefusalLimiter } from "./refusal-limit.js";
import type { Store, WhoisInfo } from "./store.js";

/** Bounds on what a server can make the bridge remember. */
export const MAX_CHANNELS = 500;
export const MAX_MEMBERS = 500;
export const MAX_PENDING = 500;

export interface DispatchHooks {
  /** Ask the client to WHOIS a nick (the client rate-limits: at most one pending). */
  readonly requestWhois?: (nick: string) => void;
}

export interface Dispatcher {
  /** Handle one parsed message. Never throws for malformed input. */
  readonly handle: (message: IrcMessage) => void;
  /** Forget partial LIST, NAMES and WHOIS replies (used when a connection ends). */
  readonly reset: () => void;
}

interface WhoisPending {
  nick: string;
  user: string | null;
  host: string | null;
  channels: string[];
  model: string | undefined;
  tools: string[];
  credits: Array<{ channel: string; used: number; total: number }>;
  total: number | null;
  idleSec: number | null;
  notFound: boolean;
}

const blankWhois = (nick: string, notFound = false): WhoisPending => ({
  nick,
  user: null,
  host: null,
  channels: [],
  model: undefined,
  tools: [],
  credits: [],
  total: null,
  idleSec: null,
  notFound,
});

const KNOWN_IGNORED = new Set([
  "001", "002", "003", "004", "005", "251", "252", "253", "254", "255", "265", "266", "372", "375", "376", "312", "317", "319",
  "PING", "PONG", "464", "ERROR", "INVITE", "CAP",
]);
const NAME_PREFIX: Readonly<Record<string, string>> = { "@": "o", "+": "v", "%": "h", "~": "q", "&": "a" };
const MODE_WITH_PARAM_ALWAYS = new Set(["o", "v", "h", "q", "a", "b", "e", "I"]);
const MODE_WITH_PARAM_ON_SET = new Set(["k", "l"]);
const CREDITS_LINE = /^credits: (\S+) (\d+(?:\.\d+)?) \/ total (\d+(?:\.\d+)?)$/;

/** Longest reason and target kept from a refusal. */
export const REFUSAL_REASON_MAX = 120;
export const REFUSAL_TARGET_MAX = 60;

/** Cut `text` to `max` characters, with an ellipsis as the last one when something was removed. */
export function cutText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Server text made safe for a log entry or a channel line: formatting and control characters removed, cut to `max`. */
export function cleanServerText(text: string, max: number): string {
  const clean = stripFormatting(text).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return cutText(clean, max);
}

export const nickOfPrefix = (prefix: string | undefined): string => {
  if (prefix === undefined) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
};

function parseNames(text: string): Array<{ nick: string; modes: string }> {
  const out: Array<{ nick: string; modes: string }> = [];
  for (const token of text.split(" ")) {
    if (token === "") continue;
    let modes = "";
    let i = 0;
    while (i < token.length && NAME_PREFIX[token[i] ?? ""] !== undefined) {
      modes += NAME_PREFIX[token[i] ?? ""];
      i += 1;
    }
    const nick = token.slice(i);
    // Anything that is not a plain valid nick (empty, comma lists, control characters) is dropped.
    if (isValidNick(nick)) out.push({ nick, modes });
  }
  return out;
}

export function createDispatcher(store: Store, hooks: DispatchHooks = {}, logger?: Logger): Dispatcher {
  let listPending: Array<{ name: string; count: number; topic: string }> = [];
  let namesPending = new Map<string, Array<{ nick: string; modes: string }>>();
  let whoisPending = new Map<string, WhoisPending>();
  // Each cap logs one warning per rebuild (reset() runs when a connection ends, before the next rebuild).
  const warned = new Set<string>();
  const capWarn = (what: string, limit: number): void => {
    if (warned.has(what)) return;
    warned.add(what);
    logger?.warn(`${what} limit reached; extra entries are dropped`, { limit });
  };

  /** True when the bridge may keep state for this channel: it is known already, or the channel cap has room. */
  const admit = (name: string): boolean => {
    if (store.channel(name) !== undefined) return true;
    if (store.allChannels().length < MAX_CHANNELS) return true;
    capWarn("channel", MAX_CHANNELS);
    return false;
  };

  /** Pending WHOIS record for a valid nick; undefined when the nick is invalid or the map is full. */
  const whoisFor = (nick: string, create: () => WhoisPending): WhoisPending | undefined => {
    if (!isValidNick(nick)) return undefined;
    const key = irc_lower(nick);
    const existing = whoisPending.get(key);
    if (existing !== undefined) return existing;
    if (whoisPending.size >= MAX_PENDING) {
      capWarn("pending WHOIS", MAX_PENDING);
      return undefined;
    }
    const created = create();
    whoisPending.set(key, created);
    return created;
  };

  const addMember = (channel: ReturnType<Store["ensureChannel"]>, nick: string, modes: string): void => {
    if (!isValidNick(nick)) return;
    if (!channel.members.has(irc_lower(nick)) && channel.members.size >= MAX_MEMBERS) {
      capWarn("channel member", MAX_MEMBERS);
      return;
    }
    store.setMember(channel, nick, modes);
  };

  const refusalLimiter = new RefusalLimiter();
  const own = (): string => store.ownNick;
  const isOwn = (nick: string): boolean => irc_lower(nick) === irc_lower(own());

  const resolveDenial = (agent: string): { channel: string | null; candidates: readonly string[] } => {
    const shared = store.channelsOf(agent);
    const withOp = shared.filter((c) => store.ownModes(c.name).includes("o"));
    const pool = withOp.length > 0 ? withOp : shared;
    if (pool.length === 1) return { channel: pool[0]!.name, candidates: [] };
    if (pool.length > 1) {
      const newest = Math.max(...pool.map((c) => c.lastSession));
      const top = pool.filter((c) => c.lastSession === newest);
      if (newest > 0 && top.length === 1) return { channel: top[0]!.name, candidates: [] };
      return { channel: null, candidates: pool.map((c) => c.name) };
    }
    return { channel: null, candidates: [] };
  };

  const onDenied = (agent: string, action: string, reason: DeniedReason, detail: string | undefined, fromChannel?: string): void => {
    let resolved: { channel: string | null; candidates: readonly string[] };
    if (fromChannel !== undefined) {
      // A channel NOTICE from the sender itself: only a known agent that is a member of that channel can open an item.
      const known = store.channel(fromChannel);
      if (known === undefined || !store.isAgent(agent) || !known.members.has(irc_lower(agent))) return;
      resolved = { channel: known.name, candidates: [] };
    } else {
      resolved = resolveDenial(agent);
    }
    const { channel, candidates } = resolved;
    if (reason === "needs-op") {
      store.addNeedsOp(agent, action, channel, candidates);
      return;
    }
    const text = `ops: ${agent} denied ${action}: ${reason}${detail === undefined ? "" : ` (${detail})`}`;
    if (channel !== null) store.addLine(channel, "server", "system", text);
    else store.diagnostics.unresolvedDenials += 1;
  };

  /**
   * A numeric that says a command we sent was refused (403, 404, 441, 442, 443, 461, 471 to 475, 481, 482). Logged once at
   * `warn`; when it names a channel the store tracks, also one `system` line in that channel's log. A refusal never
   * creates a channel. The text comes from the server, so it is untrusted: cleaned and cut before it is stored or logged.
   */
  const onRefusal = (numeric: string, params: readonly string[]): void => {
    // 441 (ERR_USERNOTINCHANNEL) and 443 (ERR_USERONCHANNEL) are `<me> <nick> <channel> :text`: the nick comes first.
    // Every other refusal is `<me> <target> :text`, and a reply with no target (481) is `<me> :text`.
    const nickFirst = (numeric === "441" || numeric === "443") && params.length >= 4;
    const nickRaw = nickFirst ? (params[1] ?? "") : "";
    const target = nickFirst ? (params[2] ?? "") : params.length >= 3 ? (params[1] ?? "") : "";
    const text = params[params.length - 1] ?? "";
    // The logger's redaction (the Séance secret, PASS lines) also covers the text that goes into the channel log.
    // Redact the whole raw text first, clean it, redact again (a secret split by a control character), and cut last, so a
    // secret that crosses the cut position is replaced as a whole and never half shown.
    const redact = (s: string): string => logger?.redact(s) ?? s;
    const safe = (raw: string, max: number): string => cutText(redact(cleanServerText(redact(raw), Number.POSITIVE_INFINITY)), max);
    // At most one report per (numeric, channel or target) per 10 s. The `server-error` event is not limited (see the case).
    const decision = refusalLimiter.note(`${numeric} ${irc_lower(target)}`, store.now());
    if (!decision.report) return;
    const reason = safe(text, REFUSAL_REASON_MAX);
    const where = safe(target, REFUSAL_TARGET_MAX);
    const nick = nickRaw === "" ? "" : safe(nickRaw, REFUSAL_TARGET_MAX);
    // The count is added after the cut, so it is never cut off.
    const more = decision.suppressed > 0 ? ` (${decision.suppressed} more suppressed)` : "";
    logger?.warn("server refused a command", {
      numeric,
      target: where,
      ...(nick === "" ? {} : { nick }),
      reason: `${reason}${more}`,
      ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
    });
    if (isValidChannel(target) && store.channel(target) !== undefined) {
      const shown = reason === "" ? "no reason given" : reason;
      store.addLine(target, "server", "system", `Server refused (${numeric}): ${nick === "" ? "" : `${nick}: `}${shown}${more}`);
    }
  };

  const onNotice = (message: IrcMessage): void => {
    const target = message.params[0] ?? "";
    const text = stripFormatting(message.params[1] ?? "");
    const from = nickOfPrefix(message.prefix);
    const toChannel = isValidChannel(target);
    if (toChannel && !admit(target)) return;
    const parsed = parseNotice({ prefix: message.prefix, target, text }, own());
    if (toChannel) store.addLine(target, from === "" ? "server" : from, "notice", text);
    if (parsed === null) return;
    const now = store.now();
    switch (parsed.kind) {
      case "worktree": {
        const channel = store.ensureChannel(target);
        channel.worktree = { dir: parsed.dir, sha: parsed.sha };
        channel.lastSession = now;
        store.emit({ type: "worktree", channel: channel.name, dir: parsed.dir, sha: parsed.sha });
        break;
      }
      case "ready": {
        const channel = store.ensureChannel(target);
        channel.readyAgents.add(irc_lower(parsed.agent));
        channel.lastSession = now;
        store.emit({ type: "ready", channel: channel.name, agent: parsed.agent });
        hooks.requestWhois?.(parsed.agent);
        break;
      }
      case "closed": {
        const channel = store.ensureChannel(target);
        channel.readyAgents.clear();
        store.emit({ type: "session-closed", channel: channel.name, sha: parsed.sha, cancelled: parsed.cancelled });
        break;
      }
      case "reverted": {
        const channel = store.ensureChannel(target);
        store.setCreditsFromNotice(channel, parsed.credits);
        store.emit({ type: "reverted", channel: channel.name, files: parsed.files, credits: parsed.credits });
        break;
      }
      case "commit": {
        const channel = store.ensureChannel(target);
        store.addCommit(channel, { agent: parsed.agent, sha: parsed.sha, files: parsed.files, ts: now });
        break;
      }
      case "denied":
        onDenied(parsed.agent, parsed.action, parsed.reason, parsed.detail, parsed.channel);
        break;
    }
  };

  const onMode = (message: IrcMessage): void => {
    const target = message.params[0] ?? "";
    const modeString = message.params[1] ?? "";
    if (!isValidChannel(target) || !admit(target)) return;
    const channel = store.ensureChannel(target);
    const args = message.params.slice(2);
    let sign = "+";
    let argIndex = 0;
    const changes: Array<{ mode: string; arg: string }> = [];
    for (const letter of modeString) {
      if (letter === "+" || letter === "-") {
        sign = letter;
        continue;
      }
      const takesParam = MODE_WITH_PARAM_ALWAYS.has(letter) || (sign === "+" && MODE_WITH_PARAM_ON_SET.has(letter));
      const arg = takesParam ? args[argIndex++] : undefined;
      if ((letter === "o" || letter === "v" || letter === "h") && arg !== undefined) {
        changes.push({ mode: `${sign}${letter}`, arg });
        const member = channel.members.get(irc_lower(arg));
        if (member !== undefined) {
          member.modes = sign === "+" ? (member.modes.includes(letter) ? member.modes : member.modes + letter) : member.modes.replaceAll(letter, "");
          store.bump();
        } else if (sign === "+") {
          addMember(channel, arg, letter);
        }
      }
    }
    const by = nickOfPrefix(message.prefix) || "server";
    store.addLine(target, by, "mode", `${modeString} ${args.join(" ")}`.trim());
    if (changes.length > 0) store.emit({ type: "mode", channel: channel.name, by, changes });
  };

  const finishWhois = (nick: string): void => {
    const pending = whoisPending.get(irc_lower(nick));
    whoisPending.delete(irc_lower(nick));
    const found = pending !== undefined && !pending.notFound;
    const info: WhoisInfo | undefined = found
      ? {
          nick: pending.nick,
          user: pending.user,
          host: pending.host,
          channels: pending.channels,
          model: pending.model ?? null,
          tools: pending.tools,
          credits: pending.credits,
          totalCredits: pending.total,
          idleSec: pending.idleSec,
        }
      : undefined;
    if (!found || pending.model === undefined) {
      store.clearAgent(nick);
    } else {
      store.setAgent({ nick: pending.nick, model: pending.model, tools: pending.tools, totalCredits: pending.total });
      for (const c of pending.credits) store.setCreditsFromWhois(c.channel, c.used, c.total);
    }
    store.emit({ type: "whois-done", nick, found, ...(info === undefined ? {} : { info }) });
  };

  const handle = (message: IrcMessage): void => {
    const p = message.params;
    switch (message.command) {
      case "322":
        if (!isValidChannel(p[1] ?? "")) break;
        if (listPending.length >= MAX_CHANNELS) {
          capWarn("channel", MAX_CHANNELS);
          break;
        }
        listPending.push({ name: p[1] ?? "", count: Number(p[2] ?? 0) || 0, topic: p[3] ?? "" });
        break;
      case "323":
        store.applyList(listPending.filter((e) => isValidChannel(e.name)));
        listPending = [];
        store.sweep();
        store.emit({ type: "list-done" });
        break;
      case "353": {
        const name = p[2] ?? "";
        const key = irc_lower(name);
        if (!namesPending.has(key) && namesPending.size >= MAX_PENDING) {
          capWarn("pending NAMES", MAX_PENDING);
          break;
        }
        const list = namesPending.get(key) ?? [];
        for (const entry of parseNames(p[3] ?? "")) {
          if (list.length >= MAX_MEMBERS) {
            capWarn("channel member", MAX_MEMBERS);
            break;
          }
          list.push(entry);
        }
        namesPending.set(key, list);
        break;
      }
      case "366": {
        const name = p[1] ?? "";
        const names = namesPending.get(irc_lower(name)) ?? [];
        namesPending.delete(irc_lower(name));
        if (!isValidChannel(name) || !admit(name)) break;
        const channel = store.ensureChannel(name);
        channel.members.clear();
        for (const n of names) channel.members.set(irc_lower(n.nick), { nick: n.nick, modes: n.modes });
        channel.namesLoaded = true;
        channel.count = channel.members.size;
        if (channel.members.has(irc_lower(own()))) store.markPresent(channel);
        store.emit({ type: "names-done", channel: channel.name });
        break;
      }
      case "311": {
        const nick = p[1] ?? "";
        if (!isValidNick(nick)) break;
        // A new 311 starts a fresh record, even when an old one is still pending.
        whoisPending.delete(irc_lower(nick));
        const fresh = whoisFor(nick, () => blankWhois(nick));
        if (fresh !== undefined) {
          fresh.user = p[2] ?? null;
          fresh.host = p[3] ?? null;
        }
        break;
      }
      case "319": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => blankWhois(nick));
        if (pending !== undefined) pending.channels.push(...(p[2] ?? "").split(" ").filter((c) => c !== ""));
        break;
      }
      case "317": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => blankWhois(nick));
        const idle = Number(p[2] ?? "");
        if (pending !== undefined && Number.isFinite(idle) && p[2] !== undefined && p[2] !== "") pending.idleSec = idle;
        break;
      }
      case "320": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => blankWhois(nick));
        if (pending === undefined) break;
        const text = p[2] ?? "";
        if (text.startsWith("model:")) pending.model = text.slice("model:".length).trim();
        else if (text.startsWith("tools:")) pending.tools = text.slice("tools:".length).split(",").map((t) => t.trim()).filter((t) => t !== "");
        else {
          const m = CREDITS_LINE.exec(text);
          if (m !== null) {
            pending.credits.push({ channel: m[1]!, used: Number(m[2]), total: Number(m[3]) });
            pending.total = Number(m[3]);
          }
        }
        break;
      }
      case "401": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => blankWhois(nick, true));
        if (pending !== undefined) pending.notFound = true;
        store.emit({ type: "server-error", numeric: "401", target: nick, text: p[2] ?? "" });
        break;
      }
      case "403":
      case "404":
      case "441":
      case "442":
      case "443":
      case "461":
      case "471":
      case "472":
      case "473":
      case "474":
      case "475":
      case "481":
      case "482":
        // Replies to commands we sent (JOIN, INVITE, MODE, KICK, PRIVMSG); tools waiting on an outcome listen for them.
        // Nothing waits for a refused `say`, so report every refusal here as well: a log entry and a channel line.
        // (A reply with no target, such as 481, has only <me> and the text.)
        onRefusal(message.command, p);
        store.emit({ type: "server-error", numeric: message.command, target: p[1] ?? "", text: p[p.length - 1] ?? "" });
        break;
      case "318":
        if (isValidNick(p[1] ?? "")) finishWhois(p[1] ?? "");
        break;
      case "332":
        if (isValidChannel(p[1] ?? "") && admit(p[1] ?? "")) store.ensureChannel(p[1] ?? "").topic = p[2] ?? "";
        store.bump();
        break;
      case "TOPIC":
        if (isValidChannel(p[0] ?? "") && admit(p[0] ?? "")) {
          store.ensureChannel(p[0] ?? "").topic = p[1] ?? "";
          store.bump();
        }
        break;
      case "PRIVMSG": {
        const target = p[0] ?? "";
        if (!isValidChannel(target) || !admit(target)) break;
        const from = nickOfPrefix(message.prefix) || "server";
        const text = stripFormatting(p[1] ?? "");
        // An echo of a message `say` already put in the log (only from our own nick, within 30 s, once).
        if (isOwn(from) && store.consumeOwnEcho(target, text)) break;
        store.addLine(target, from, "privmsg", text);
        break;
      }
      case "NOTICE":
        onNotice(message);
        break;
      case "JOIN": {
        const nick = nickOfPrefix(message.prefix);
        const name = p[0] ?? "";
        if (!isValidChannel(name) || !isValidNick(nick) || !admit(name)) break;
        const channel = store.ensureChannel(name);
        store.markPresent(channel);
        addMember(channel, nick, "");
        if (channel.namesLoaded) channel.count = channel.members.size;
        store.addLine(name, nick, "join", `${nick} joined`);
        if (!isOwn(nick) && !store.isAgent(nick)) hooks.requestWhois?.(nick);
        break;
      }
      case "PART": {
        const nick = nickOfPrefix(message.prefix);
        const name = p[0] ?? "";
        const channel = store.channel(name);
        if (channel === undefined) break;
        store.addLine(name, nick, "part", p[1] === undefined ? `${nick} left` : `${nick} left: ${p[1]}`);
        if (isOwn(nick)) store.markLeft(channel);
        else {
          store.removeMember(channel, nick);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        break;
      }
      case "KICK": {
        const name = p[0] ?? "";
        const victim = p[1] ?? "";
        const channel = store.channel(name);
        if (channel === undefined) break;
        const by = nickOfPrefix(message.prefix);
        store.addLine(name, by, "kick", `${victim} was kicked${p[2] === undefined ? "" : `: ${p[2]}`}`);
        if (isOwn(victim)) store.markLeft(channel);
        else {
          store.removeMember(channel, victim);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        break;
      }
      case "QUIT": {
        const nick = nickOfPrefix(message.prefix);
        for (const channel of store.channelsOf(nick)) {
          store.addLine(channel.name, nick, "part", p[0] === undefined ? `${nick} quit` : `${nick} quit: ${p[0]}`);
          store.removeMember(channel, nick);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        store.clearAgent(nick);
        break;
      }
      case "NICK": {
        const old = nickOfPrefix(message.prefix);
        const next = p[0] ?? "";
        if (old === "" || !isValidNick(next)) break;
        if (isOwn(old)) store.ownNick = next;
        store.renameNick(old, next);
        break;
      }
      case "MODE":
        onMode(message);
        break;
      default:
        if (!KNOWN_IGNORED.has(message.command)) store.diagnostics.unknownCommands += 1;
        break;
    }
  };

  return {
    handle,
    reset: () => {
      warned.clear();
      listPending = [];
      namesPending = new Map();
      whoisPending = new Map();
    },
  };
}
