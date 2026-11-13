// In-memory model of everything the bridge knows about the server. State is never persisted.
import { irc_lower } from "../../vendor/irc-protocol/src/index.js";
import type { Clock } from "../clock.js";
import { stripFormatting } from "./format.js";
import { Ring } from "./ring.js";

export type BridgeState = "unconfigured" | "connecting" | "registered" | "reconnecting" | "auth-failed" | "nick-rejected" | "config-invalid" | "duplicate-instance";

export type ChannelLineKind = "privmsg" | "notice" | "join" | "part" | "kick" | "mode" | "system";

/** One line in a channel buffer. `text` is untrusted data from the server. */
export interface ChannelLine {
  readonly seq: number;
  readonly ts: number;
  readonly from: string;
  readonly kind: ChannelLineKind;
  readonly text: string;
}

export interface CommitEntry {
  readonly agent: string;
  readonly sha: string;
  readonly files: number;
  readonly ts: number;
}

export interface InboxItem {
  readonly id: string;
  readonly channel: string | null;
  readonly candidates: readonly string[];
  readonly agent: string;
  readonly action: string;
  readonly reason: "needs-op";
  readonly ts: number;
  status: "open" | "granted" | "dismissed";
}

export interface AgentInfo {
  readonly nick: string;
  readonly model: string;
  readonly tools: readonly string[];
  /** The agent's total credits as reported by its latest WHOIS, or null. */
  readonly totalCredits: number | null;
}

export interface ChannelCredits {
  used: number | null;
  total: number | null;
  /** WHOIS is authoritative; the "credits used" notice is only a fallback. */
  source: "whois" | "notice" | "snapshot" | null;
}

export interface Channel {
  readonly name: string;
  topic: string;
  count: number;
  /** lower-cased nick -> member */
  readonly members: Map<string, Member>;
  readonly ring: Ring<ChannelLine>;
  readonly commits: CommitEntry[];
  readonly credits: ChannelCredits;
  worktree: { readonly dir: string; readonly sha: string } | null;
  /** lower-cased agent nicks reported ready in this channel. */
  readonly readyAgents: Set<string>;
  /** Time of the last ready or worktree event, 0 when none. */
  lastSession: number;
  /** When the bridge left or was removed from the channel, null while present. */
  leftAt: number | null;
  /** True once NAMES filled `members`. */
  namesLoaded: boolean;
}

export interface Member {
  readonly nick: string;
  /** Mode letters, for example "o", "v" or "ov". */
  modes: string;
}

/** Everything a finished WHOIS reply said about a nick. All values are untrusted server data. */
export interface WhoisInfo {
  readonly nick: string;
  readonly user: string | null;
  readonly host: string | null;
  readonly channels: readonly string[];
  /** From the `320 model:` line; null for a plain user. */
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly credits: ReadonlyArray<{ readonly channel: string; readonly used: number; readonly total: number }>;
  readonly totalCredits: number | null;
  readonly idleSec: number | null;
}

export type BridgeEvent =
  | { readonly type: "state"; readonly state: BridgeState }
  | { readonly type: "line"; readonly channel: string; readonly line: ChannelLine }
  | { readonly type: "agent"; readonly nick: string; readonly model: string; readonly tools: readonly string[] }
  | { readonly type: "ready"; readonly channel: string; readonly agent: string }
  | { readonly type: "worktree"; readonly channel: string; readonly dir: string; readonly sha: string }
  | { readonly type: "session-closed"; readonly channel: string; readonly sha: string; readonly cancelled: boolean }
  | { readonly type: "reverted"; readonly channel: string; readonly files: number; readonly credits: number }
  | { readonly type: "commit"; readonly channel: string; readonly agent: string; readonly sha: string; readonly files: number }
  | { readonly type: "credits"; readonly channel: string; readonly used: number; readonly total: number }
  | { readonly type: "needs-op"; readonly item: InboxItem }
  | { readonly type: "whois-done"; readonly nick: string; readonly found: boolean; readonly info?: WhoisInfo }
  /** A channel MODE line from the server; `changes` lists the member modes it set or removed (for example "+o" on "coder"). */
  | { readonly type: "mode"; readonly channel: string; readonly by: string; readonly changes: ReadonlyArray<{ readonly mode: string; readonly arg: string }> }
  /** A numeric error reply (for example 482 or 473) to something we sent; `text` is untrusted server text. */
  | { readonly type: "server-error"; readonly numeric: string; readonly target: string; readonly text: string }
  | { readonly type: "list-done" }
  | { readonly type: "names-done"; readonly channel: string };

export type EventType = BridgeEvent["type"];
export type EventOf<T extends EventType> = Extract<BridgeEvent, { readonly type: T }>;

export const RING_CAPACITY = 500;
export const COMMIT_LIMIT = 50;
export const INBOX_LIMIT = 200;
export const DEDUP_MS = 60_000;
/** How long, and how many, own messages are remembered to recognise an echo from the server. */
export const OWN_ECHO_MS = 30_000;
export const OWN_MARKER_LIMIT = 20;
export const DROP_AFTER_LEAVE_MS = 10 * 60_000;

export class Store {
  private readonly clock: Clock;
  private readonly channelMap = new Map<string, Channel>();
  private readonly agentMap = new Map<string, AgentInfo>();
  private readonly inboxItems: InboxItem[] = [];
  private readonly handlers = new Map<EventType, Set<(event: never) => void>>();
  private readonly anyHandlers = new Set<(event: BridgeEvent) => void>();
  private readonly ownMarkers: Array<{ readonly key: string; readonly at: number }> = [];
  private inboxCounter = 0;
  private rev = 0;
  /** Counters for diagnostics only. */
  readonly diagnostics = { unknownCommands: 0, binaryFrames: 0, droppedLines: 0, overlongLines: 0, unresolvedDenials: 0 };
  ownNick = "";
  state: BridgeState = "unconfigured";

  constructor(clock: Clock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  /**
   * Time for measuring elapsed time only (refusal-hardening Requirement 8): monotonic when the clock has a source,
   * otherwise `now()`, so fake clocks without one keep working. Never show it to people; use `now()` for that.
   */
  monotonicNow(): number {
    return this.clock.monotonic?.() ?? this.clock.now();
  }

  // ---- revision and events -------------------------------------------------

  /** Increases on every change, so pollers can ask for changes only. */
  get revision(): number {
    return this.rev;
  }

  bump(): void {
    this.rev += 1;
  }

  on<T extends EventType>(type: T, handler: (event: EventOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (event: never) => void);
    return () => {
      set.delete(handler as (event: never) => void);
    };
  }

  /** Number of handlers registered through `on` for a type, plus all `onAny` handlers (tests check that waiters clean up). */
  listenerCount(type: EventType): number {
    return (this.handlers.get(type)?.size ?? 0) + this.anyHandlers.size;
  }

  onAny(handler: (event: BridgeEvent) => void): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  emit(event: BridgeEvent): void {
    this.bump();
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) (handler as (e: BridgeEvent) => void)(event);
    for (const handler of [...this.anyHandlers]) handler(event);
  }

  setState(state: BridgeState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "state", state });
  }

  // ---- channels --------------------------------------------------------------

  private key(name: string): string {
    return irc_lower(name);
  }

  channel(name: string): Channel | undefined {
    return this.channelMap.get(this.key(name));
  }

  ensureChannel(name: string): Channel {
    const key = this.key(name);
    let channel = this.channelMap.get(key);
    if (channel === undefined) {
      channel = {
        name,
        topic: "",
        count: 0,
        members: new Map(),
        ring: new Ring<ChannelLine>(RING_CAPACITY),
        commits: [],
        credits: { used: null, total: null, source: null },
        worktree: null,
        readyAgents: new Set(),
        lastSession: 0,
        leftAt: null,
        namesLoaded: false,
      };
      this.channelMap.set(key, channel);
      this.bump();
    }
    return channel;
  }

  /** Channels the bridge currently knows about (not left or removed). */
  listChannels(): readonly Channel[] {
    return [...this.channelMap.values()].filter((c) => c.leftAt === null);
  }

  /** Channels including ones that were left recently and are waiting to be dropped. */
  allChannels(): readonly Channel[] {
    return [...this.channelMap.values()];
  }

  /** Drop the buffers of channels left or removed at least 10 minutes ago. Returns the dropped names. */
  sweep(): readonly string[] {
    const now = this.clock.now();
    const dropped: string[] = [];
    for (const [key, channel] of this.channelMap) {
      if (channel.leftAt !== null && now - channel.leftAt >= DROP_AFTER_LEAVE_MS) {
        this.channelMap.delete(key);
        dropped.push(channel.name);
      }
    }
    if (dropped.length > 0) this.bump();
    return dropped;
  }

  markLeft(channel: Channel): void {
    if (channel.leftAt === null) channel.leftAt = this.clock.now();
    channel.members.clear();
    channel.readyAgents.clear();
    channel.namesLoaded = false;
    this.bump();
  }

  markPresent(channel: Channel): void {
    if (channel.leftAt !== null) {
      channel.leftAt = null;
      this.bump();
    }
  }

  /** Apply a finished LIST: record entries, and mark channels that are no longer listed as removed. */
  applyList(entries: ReadonlyArray<{ readonly name: string; readonly count: number; readonly topic: string }>): void {
    const listed = new Set<string>();
    for (const entry of entries) {
      const channel = this.ensureChannel(entry.name);
      channel.topic = entry.topic;
      channel.count = entry.count;
      this.markPresent(channel);
      listed.add(this.key(entry.name));
    }
    for (const [key, channel] of this.channelMap) {
      if (!listed.has(key) && channel.leftAt === null) this.markLeft(channel);
    }
    this.bump();
  }

  addLine(channelName: string, from: string, kind: ChannelLineKind, text: string): ChannelLine {
    const channel = this.ensureChannel(channelName);
    const ts = this.clock.now();
    const clean = stripFormatting(text);
    const line = channel.ring.push((seq) => ({ seq, ts, from, kind, text: clean }));
    this.emit({ type: "line", channel: channel.name, line });
    return line;
  }

  // ---- own messages ------------------------------------------------------------

  /**
   * Record a message the bridge itself sent (`say`). The server does not echo our own PRIVMSG, so without this the
   * message would never reach the log. Only a tracked channel gets a line: `say` must not make the store grow. The line
   * is a normal `privmsg` from our own nick, and a marker lets `consumeOwnEcho` swallow an echo if a server ever sends one.
   */
  addOwnMessage(channelName: string, text: string): ChannelLine | null {
    if (this.channel(channelName) === undefined) return null;
    const line = this.addLine(channelName, this.ownNick, "privmsg", text);
    this.pruneOwnMarkers();
    this.ownMarkers.push({ key: this.echoKey(channelName, line.text), at: this.clock.now() });
    if (this.ownMarkers.length > OWN_MARKER_LIMIT) this.ownMarkers.shift();
    return line;
  }

  /** True once, and only within OWN_ECHO_MS of the send, for a PRIVMSG that repeats an own message (an echo). */
  consumeOwnEcho(channelName: string, text: string): boolean {
    this.pruneOwnMarkers();
    const key = this.echoKey(channelName, stripFormatting(text));
    const index = this.ownMarkers.findIndex((m) => m.key === key);
    if (index === -1) return false;
    this.ownMarkers.splice(index, 1);
    return true;
  }

  private echoKey(channelName: string, cleanText: string): string {
    return `${this.key(channelName)}\u0000${cleanText}`;
  }

  private pruneOwnMarkers(): void {
    const now = this.clock.now();
    for (let i = this.ownMarkers.length - 1; i >= 0; i -= 1) {
      if (now - (this.ownMarkers[i]?.at ?? 0) >= OWN_ECHO_MS) this.ownMarkers.splice(i, 1);
    }
  }

  // ---- members -----------------------------------------------------------------

  setMember(channel: Channel, nick: string, modes: string): void {
    channel.members.set(irc_lower(nick), { nick, modes });
    this.bump();
  }

  removeMember(channel: Channel, nick: string): boolean {
    const existed = channel.members.delete(irc_lower(nick));
    channel.readyAgents.delete(irc_lower(nick));
    if (existed) this.bump();
    return existed;
  }

  ownModes(channelName: string): string {
    return this.channel(channelName)?.members.get(irc_lower(this.ownNick))?.modes ?? "";
  }

  /** Channels (present ones) where `nick` is a member. */
  channelsOf(nick: string): readonly Channel[] {
    const key = irc_lower(nick);
    return this.listChannels().filter((c) => c.members.has(key));
  }

  // ---- agents ----------------------------------------------------------------------

  isAgent(nick: string): boolean {
    return this.agentMap.has(irc_lower(nick));
  }

  agent(nick: string): AgentInfo | undefined {
    return this.agentMap.get(irc_lower(nick));
  }

  agents(): readonly AgentInfo[] {
    return [...this.agentMap.values()];
  }

  setAgent(info: AgentInfo): void {
    this.agentMap.set(irc_lower(info.nick), info);
    this.emit({ type: "agent", nick: info.nick, model: info.model, tools: info.tools });
  }

  clearAgent(nick: string): void {
    if (this.agentMap.delete(irc_lower(nick))) this.bump();
  }

  renameNick(oldNick: string, newNick: string): void {
    const oldKey = irc_lower(oldNick);
    for (const channel of this.channelMap.values()) {
      const member = channel.members.get(oldKey);
      if (member !== undefined) {
        channel.members.delete(oldKey);
        channel.members.set(irc_lower(newNick), { nick: newNick, modes: member.modes });
      }
      if (channel.readyAgents.delete(oldKey)) channel.readyAgents.add(irc_lower(newNick));
    }
    // The agent identity belongs to the old nick; the new nick must prove itself with a WHOIS.
    this.agentMap.delete(oldKey);
    this.bump();
  }

  // ---- credits -----------------------------------------------------------------------

  setCreditsFromWhois(channelName: string, used: number, total: number): void {
    const channel = this.ensureChannel(channelName);
    channel.credits.used = used;
    channel.credits.total = total;
    channel.credits.source = "whois";
    this.emit({ type: "credits", channel: channel.name, used, total });
  }

  /**
   * Seed last known credits from the on-disk snapshot at start. The values are marked `source: "snapshot"` (stale):
   * any WHOIS or notice figure replaces them, and nothing is emitted. A channel the bridge has not seen yet is created
   * as "left", so it stays out of the channel list until a LIST shows it, and is dropped by `sweep` otherwise.
   */
  seedCredits(channelName: string, used: number, total: number | null): void {
    const known = this.channel(channelName) !== undefined;
    const channel = this.ensureChannel(channelName);
    if (channel.credits.source !== null) return;
    channel.credits.used = used;
    channel.credits.total = total;
    channel.credits.source = "snapshot";
    if (!known) channel.leftAt = this.clock.now();
    this.bump();
  }

  /**
   * The "credits used" figure of a revert notice. WHOIS is authoritative while the agent is present, but after an
   * exorcise the last WHOIS is stale, so a higher notice figure wins. Credits never go down because of a notice.
   */
  setCreditsFromNotice(channel: Channel, used: number): void {
    const current = channel.credits.used;
    if (current !== null && used <= current) return;
    channel.credits.used = used;
    if (channel.credits.source !== "whois") channel.credits.source = "notice";
    this.emit({ type: "credits", channel: channel.name, used, total: channel.credits.total ?? used });
  }

  /**
   * Total credits used: the sum of the per-channel figures (the rows the dashboard, the credits tool and the summary
   * show), else the sum of known agent totals, else null.
   */
  totalCredits(): number | null {
    const used = this.listChannels().flatMap((c) => (c.credits.used === null ? [] : [c.credits.used]));
    if (used.length > 0) return round2(used.reduce((a, b) => a + b, 0));
    const agentTotals = this.agents().flatMap((a) => (a.totalCredits === null ? [] : [a.totalCredits]));
    return agentTotals.length > 0 ? round2(agentTotals.reduce((a, b) => a + b, 0)) : null;
  }

  // ---- commits ---------------------------------------------------------------------------

  addCommit(channel: Channel, entry: CommitEntry): void {
    channel.commits.push(entry);
    if (channel.commits.length > COMMIT_LIMIT) channel.commits.shift();
    this.emit({ type: "commit", channel: channel.name, agent: entry.agent, sha: entry.sha, files: entry.files });
  }

  // ---- inbox -------------------------------------------------------------------------------

  inbox(): readonly InboxItem[] {
    return this.inboxItems;
  }

  openInbox(): readonly InboxItem[] {
    return this.inboxItems.filter((i) => i.status === "open");
  }

  /** Create a needs-op item unless the same (agent, action) was seen within 60 seconds. Returns null when de-duplicated. */
  addNeedsOp(agent: string, action: string, channel: string | null, candidates: readonly string[]): InboxItem | null {
    const now = this.clock.now();
    const key = `${irc_lower(agent)}\u0000${action}`;
    const duplicate = this.inboxItems.some((i) => `${irc_lower(i.agent)}\u0000${i.action}` === key && now - i.ts < DEDUP_MS);
    if (duplicate) return null;
    const item: InboxItem = {
      id: `i${++this.inboxCounter}`,
      channel,
      candidates,
      agent,
      action,
      reason: "needs-op",
      ts: now,
      status: "open",
    };
    this.inboxItems.push(item);
    while (this.inboxItems.length > INBOX_LIMIT) {
      const closed = this.inboxItems.findIndex((i) => i.status !== "open");
      this.inboxItems.splice(closed === -1 ? 0 : closed, 1);
    }
    this.emit({ type: "needs-op", item });
    return item;
  }

  dismiss(id: string): boolean {
    return this.setStatus(id, "dismissed");
  }

  resolve(id: string): boolean {
    return this.setStatus(id, "granted");
  }

  /** Mark open items for an agent (in a channel, or with an unknown channel) as granted. */
  resolveFor(channelName: string, agent: string): number {
    let count = 0;
    for (const item of this.inboxItems) {
      if (item.status !== "open" || irc_lower(item.agent) !== irc_lower(agent)) continue;
      const matches = item.channel === null ? item.candidates.some((c) => irc_lower(c) === irc_lower(channelName)) : irc_lower(item.channel) === irc_lower(channelName);
      if (matches) {
        item.status = "granted";
        count += 1;
      }
    }
    if (count > 0) this.bump();
    return count;
  }

  private setStatus(id: string, status: "granted" | "dismissed"): boolean {
    const item = this.inboxItems.find((i) => i.id === id);
    if (item === undefined || item.status !== "open") return false;
    item.status = status;
    this.bump();
    return true;
  }

  /** Forget everything that depends on the connection (used before a state rebuild). Counters and the inbox stay. */
  resetMembership(): void {
    for (const channel of this.channelMap.values()) {
      channel.members.clear();
      channel.readyAgents.clear();
      channel.namesLoaded = false;
    }
    this.agentMap.clear();
    this.bump();
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
