// Maps parsed IRC messages to store updates and typed events. Connection control (001, PING, 464, ERROR) is the client's job.
import { irc_lower, isValidChannel, isValidNick, type IrcMessage } from "../../vendor/irc-protocol/src/index.js";
import type { Logger } from "../log.js";
import { parseNotice, type DeniedReason } from "./notices.js";
import type { Store } from "./store.js";

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
  model: string | undefined;
  tools: string[];
  credits: Array<{ channel: string; used: number; total: number }>;
  total: number | null;
  notFound: boolean;
}

const KNOWN_IGNORED = new Set([
  "001", "002", "003", "004", "005", "251", "252", "253", "254", "255", "265", "266", "372", "375", "376", "312", "317", "319",
  "PING", "PONG", "464", "ERROR", "INVITE", "CAP",
]);
const NAME_PREFIX: Readonly<Record<string, string>> = { "@": "o", "+": "v", "%": "h", "~": "q", "&": "a" };
const MODE_WITH_PARAM_ALWAYS = new Set(["o", "v", "h", "q", "a", "b", "e", "I"]);
const MODE_WITH_PARAM_ON_SET = new Set(["k", "l"]);
const CREDITS_LINE = /^credits: (\S+) (\d+(?:\.\d+)?) \/ total (\d+(?:\.\d+)?)$/;

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

  const onDenied = (agent: string, action: string, reason: DeniedReason, detail: string | undefined): void => {
    const { channel, candidates } = resolveDenial(agent);
    if (reason === "needs-op") {
      store.addNeedsOp(agent, action, channel, candidates);
      return;
    }
    const text = `ops: ${agent} denied ${action}: ${reason}${detail === undefined ? "" : ` (${detail})`}`;
    if (channel !== null) store.addLine(channel, "server", "system", text);
    else store.diagnostics.unresolvedDenials += 1;
  };

  const onNotice = (message: IrcMessage): void => {
    const target = message.params[0] ?? "";
    const text = message.params[1] ?? "";
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
        onDenied(parsed.agent, parsed.action, parsed.reason, parsed.detail);
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
    for (const letter of modeString) {
      if (letter === "+" || letter === "-") {
        sign = letter;
        continue;
      }
      const takesParam = MODE_WITH_PARAM_ALWAYS.has(letter) || (sign === "+" && MODE_WITH_PARAM_ON_SET.has(letter));
      const arg = takesParam ? args[argIndex++] : undefined;
      if ((letter === "o" || letter === "v" || letter === "h") && arg !== undefined) {
        const member = channel.members.get(irc_lower(arg));
        if (member !== undefined) {
          member.modes = sign === "+" ? (member.modes.includes(letter) ? member.modes : member.modes + letter) : member.modes.replaceAll(letter, "");
          store.bump();
        } else if (sign === "+") {
          addMember(channel, arg, letter);
        }
      }
    }
    store.addLine(target, nickOfPrefix(message.prefix) || "server", "mode", `${modeString} ${args.join(" ")}`.trim());
  };

  const finishWhois = (nick: string): void => {
    const pending = whoisPending.get(irc_lower(nick));
    whoisPending.delete(irc_lower(nick));
    if (pending === undefined || pending.notFound || pending.model === undefined) {
      store.clearAgent(nick);
      store.emit({ type: "whois-done", nick, found: pending !== undefined && !pending.notFound });
      return;
    }
    store.setAgent({ nick: pending.nick, model: pending.model, tools: pending.tools, totalCredits: pending.total });
    for (const c of pending.credits) store.setCreditsFromWhois(c.channel, c.used, c.total);
    store.emit({ type: "whois-done", nick, found: true });
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
        whoisFor(nick, () => ({ nick, model: undefined, tools: [], credits: [], total: null, notFound: false }));
        break;
      }
      case "320": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => ({ nick, model: undefined, tools: [], credits: [], total: null, notFound: false }));
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
        const pending = whoisFor(nick, () => ({ nick, model: undefined, tools: [], credits: [], total: null, notFound: true }));
        if (pending !== undefined) pending.notFound = true;
        break;
      }
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
        if (isValidChannel(target) && admit(target)) store.addLine(target, nickOfPrefix(message.prefix) || "server", "privmsg", p[1] ?? "");
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
