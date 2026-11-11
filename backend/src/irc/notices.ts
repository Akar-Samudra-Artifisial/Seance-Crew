// Notice parser: turns ChanServ channel notices and server-prefixed op notices into typed facts.
import { irc_lower, isServiceNick, isValidChannel } from "../../vendor/irc-protocol/src/index.js";

export const DENIED_REASONS = [
  "no-mode",
  "needs-op",
  "outside-worktree",
  "unclassified",
  "unresolved-path",
  "deny-list",
  "protected-path",
  "private-session",
] as const;
export type DeniedReason = (typeof DENIED_REASONS)[number];

export type ParsedNotice =
  | { readonly kind: "worktree"; readonly dir: string; readonly sha: string }
  | { readonly kind: "ready"; readonly agent: string }
  | { readonly kind: "closed"; readonly sha: string; readonly cancelled: boolean }
  | { readonly kind: "reverted"; readonly files: number; readonly credits: number }
  | { readonly kind: "commit"; readonly agent: string; readonly sha: string; readonly files: number }
  | {
      readonly kind: "denied";
      readonly agent: string;
      readonly action: string;
      readonly reason: DeniedReason;
      readonly detail?: string;
    };

export interface NoticeInput {
  /** Message prefix without the leading colon, as received. */
  readonly prefix: string | undefined;
  /** First parameter of the NOTICE: a channel or a nick. */
  readonly target: string;
  readonly text: string;
}

const SHA = "[0-9a-f]{7,40}";
const WORKTREE = new RegExp(`^worktree ready: (\\S+) @ (${SHA})$`);
const READY = /^(\S+) is ready$/;
const CLOSED = new RegExp(`^session (closed|cancelled), worktree reset to (${SHA})$`);
const REVERTED = /^(\d+) files?(?:\(s\))? reverted · (\d+\.\d{2}) credits used$/;
const COMMIT = new RegExp(`^(\\S+) committed (${SHA}) \\((\\d+) files?(?:\\(s\\))?\\)$`);
const DENIED = new RegExp(`^ops: (\\S+) denied (.+?): (${DENIED_REASONS.join("|")})(?: \\((.+)\\))?$`);

const nickOf = (prefix: string): string => {
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
};

/**
 * Parse a NOTICE. Returns null for anything that is not a recognised notice from a trusted source:
 * - channel notices (worktree, ready, closed, reverted, commit) only from a service nick to a channel;
 * - `ops:` notices only from a server prefix (no "!") to our own nick.
 */
export function parseNotice(input: NoticeInput, ownNick: string): ParsedNotice | null {
  const { prefix, target, text } = input;
  if (prefix === undefined || prefix === "") return null;

  if (isValidChannel(target)) {
    if (!isServiceNick(nickOf(prefix))) return null;
    let m = WORKTREE.exec(text);
    if (m !== null) return { kind: "worktree", dir: m[1]!, sha: m[2]! };
    m = CLOSED.exec(text);
    if (m !== null) return { kind: "closed", sha: m[2]!, cancelled: m[1] === "cancelled" };
    m = REVERTED.exec(text);
    if (m !== null) return { kind: "reverted", files: Number(m[1]), credits: Number(m[2]) };
    m = COMMIT.exec(text);
    if (m !== null) return { kind: "commit", agent: m[1]!, sha: m[2]!, files: Number(m[3]) };
    m = READY.exec(text);
    if (m !== null) return { kind: "ready", agent: m[1]! };
    return null;
  }

  // Op notice: a server prefix contains no "!" and is not a service nick; the target is us.
  if (prefix.includes("!") || isServiceNick(prefix)) return null;
  if (irc_lower(target) !== irc_lower(ownNick)) return null;
  const m = DENIED.exec(text);
  if (m === null) return null;
  const reason = m[3] as DeniedReason;
  return m[4] === undefined
    ? { kind: "denied", agent: m[1]!, action: m[2]!, reason }
    : { kind: "denied", agent: m[1]!, action: m[2]!, reason, detail: m[4] };
}
