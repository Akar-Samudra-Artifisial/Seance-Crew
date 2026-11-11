// The State snapshot behind GET /api/state: a bounded, secret-free view of the bridge store for the dashboard page.
import { randomUUID } from "node:crypto";
import { irc_lower } from "../../vendor/irc-protocol/src/index.js";
import type { BridgeState, Channel, Store } from "../irc/store.js";

/** Random per process, so a page can tell that the backend restarted even when revision numbers collide. */
export const BOOT_ID = randomUUID();

export const STATE_MAX_BYTES = 256 * 1024;
export const STATE_LINES_PER_CHANNEL = 200;
export const STATE_COMMITS_PER_CHANNEL = 5;

/** The part of IrcBridge the snapshot reads. `currentConfig` is read for host and nick only, never the secret. */
export interface StateBridge {
  readonly state: BridgeState;
  readonly currentConfig: { readonly host: string; readonly nick: string } | null;
}

export interface StateAgent {
  readonly nick: string;
  readonly modes: string;
  readonly model: string;
  readonly ready: boolean;
}

export interface StateLine {
  readonly seq: number;
  readonly ts: number;
  readonly from: string;
  readonly kind: string;
  readonly text: string;
}

export interface StateCommit {
  readonly agent: string;
  readonly sha: string;
  readonly files: number;
  readonly ts: number;
}

export interface StateChannel {
  readonly name: string;
  /** Untrusted channel text. Cleared first when the state must shrink after the lines are gone. */
  topic: string;
  readonly count: number;
  readonly credits: { readonly used: number | null; readonly total: number | null };
  readonly agents: readonly StateAgent[];
  /** How many commits the store keeps for this channel (up to 50); `commits` holds only the newest few of them. */
  readonly commitCount: number;
  commits: StateCommit[];
  /** Untrusted channel text. */
  lines: StateLine[];
}

export interface StateInboxItem {
  readonly id: string;
  /** Null when the channel could not be determined; then `candidates` lists the possible channels. */
  readonly channel: string | null;
  readonly candidates: readonly string[];
  readonly agent: string;
  readonly action: string;
  readonly ts: number;
}

export interface State {
  /** Random per process: a page that sees it change must reload everything, even if `revision` happens to match. */
  readonly bootId: string;
  readonly revision: number;
  readonly serverTime: number;
  readonly bridge: { readonly state: BridgeState; readonly host: string; readonly nick: string };
  readonly channels: StateChannel[];
  inbox: StateInboxItem[];
  readonly totalCredits: number | null;
  /** True when anything was dropped to fit STATE_MAX_BYTES. */
  truncated: boolean;
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function channelView(store: Store, c: Channel): StateChannel {
  const agents: StateAgent[] = [...c.members.values()]
    .filter((m) => store.isAgent(m.nick))
    .map((m) => ({
      nick: m.nick,
      modes: m.modes,
      model: store.agent(m.nick)?.model ?? "",
      ready: c.readyAgents.has(irc_lower(m.nick)),
    }));
  return {
    name: c.name,
    topic: c.topic,
    count: c.namesLoaded ? c.members.size : c.count,
    credits: { used: c.credits.used, total: c.credits.total },
    agents,
    commitCount: c.commits.length,
    commits: c.commits.slice(-STATE_COMMITS_PER_CHANNEL).map((k) => ({ agent: k.agent, sha: k.sha, files: k.files, ts: k.ts })),
    lines: c.ring.newest(STATE_LINES_PER_CHANNEL).map((l) => ({ seq: l.seq, ts: l.ts, from: l.from, kind: l.kind, text: l.text })),
  };
}

/**
 * Shrink the whole state to `maxBytes`, oldest first, in this order: log lines (from the channel holding the most),
 * topics, commits, inbox items, then whole channels. `truncated` is set as soon as anything is dropped.
 */
function capState(state: State, maxBytes: number): void {
  let size = bytesOf(state);
  if (size <= maxBytes) return;
  state.truncated = true;
  size = bytesOf(state);
  // Account for a removal; once the estimate says it fits, confirm with an exact measurement.
  const fits = (removed: number): boolean => {
    size -= removed;
    if (size > maxBytes) return false;
    size = bytesOf(state);
    return size <= maxBytes;
  };
  while (size > maxBytes) {
    let fattest: StateChannel | undefined;
    for (const c of state.channels) {
      if (c.lines.length > 0 && (fattest === undefined || c.lines.length > fattest.lines.length)) fattest = c;
    }
    const dropped = fattest?.lines.shift();
    if (dropped === undefined) break;
    // The line itself plus the comma that separated it.
    if (fits(bytesOf(dropped) + 1)) return;
  }
  for (const c of state.channels) {
    if (c.topic === "") continue;
    const before = bytesOf(c.topic);
    c.topic = "";
    if (fits(before - bytesOf(""))) return;
  }
  for (const c of state.channels) {
    while (c.commits.length > 0) {
      const dropped = c.commits.shift();
      if (dropped !== undefined && fits(bytesOf(dropped) + 1)) return;
    }
  }
  while (state.inbox.length > 0) {
    const dropped = state.inbox.shift();
    if (dropped !== undefined && fits(bytesOf(dropped) + 1)) return;
  }
  while (state.channels.length > 0) {
    const dropped = state.channels.shift();
    if (dropped !== undefined && fits(bytesOf(dropped) + 1)) return;
  }
}

export interface BuildStateOptions {
  readonly bootId?: string;
  readonly maxBytes?: number;
}

/** Build the dashboard state. Contains no secret: only host and nick are read from the bridge config. */
export function buildState(store: Store, bridge: StateBridge, options: BuildStateOptions = {}): State {
  const config = bridge.currentConfig;
  const state: State = {
    bootId: options.bootId ?? BOOT_ID,
    revision: store.revision,
    serverTime: store.now(),
    bridge: { state: bridge.state, host: config?.host ?? "", nick: config?.nick ?? store.ownNick },
    channels: store.listChannels().map((c) => channelView(store, c)),
    inbox: store.openInbox().map((i) => ({ id: i.id, channel: i.channel, candidates: [...i.candidates], agent: i.agent, action: i.action, ts: i.ts })),
    totalCredits: store.totalCredits(),
    truncated: false,
  };
  capState(state, options.maxBytes ?? STATE_MAX_BYTES);
  return state;
}
