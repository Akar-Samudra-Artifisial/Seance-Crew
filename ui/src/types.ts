// Shapes of the JSON the backend answers under /api/*. Kept in step with backend/src/api/state.ts by hand:
// the page and the backend are separate bundles and share no code.

export type BridgeState = "unconfigured" | "connecting" | "registered" | "reconnecting" | "auth-failed" | "nick-rejected" | "config-invalid" | "duplicate-instance";

export interface AgentView {
  readonly nick: string;
  /** Mode letters, for example "o", "v" or "" (none). */
  readonly modes: string;
  readonly model: string;
  readonly ready: boolean;
}

export interface LineView {
  readonly seq: number;
  readonly ts: number;
  readonly from: string;
  readonly kind: string;
  /** Untrusted channel text. */
  readonly text: string;
}

export interface CommitView {
  readonly agent: string;
  readonly sha: string;
  readonly files: number;
  readonly ts: number;
}

export interface ChannelView {
  readonly name: string;
  readonly topic: string;
  readonly count: number;
  readonly credits: { readonly used: number | null; readonly total: number | null };
  readonly agents: readonly AgentView[];
  readonly commits: readonly CommitView[];
  readonly lines: readonly LineView[];
}

export interface InboxView {
  readonly id: string;
  /** Null when the server could not tell; then `candidates` lists the possible channels. */
  readonly channel: string | null;
  readonly candidates: readonly string[];
  readonly agent: string;
  readonly action: string;
  readonly ts: number;
}

export interface State {
  /** Random per backend process: when it changes, everything is reloaded even if `revision` matches. */
  readonly bootId: string;
  readonly revision: number;
  readonly serverTime: number;
  readonly bridge: { readonly state: BridgeState; readonly host: string; readonly nick: string };
  readonly channels: readonly ChannelView[];
  readonly inbox: readonly InboxView[];
  readonly totalCredits: number | null;
  readonly truncated: boolean;
}

export interface Unchanged {
  readonly changed: false;
  readonly bootId?: string;
  readonly revision: number;
}

export interface Summary {
  readonly date: string;
  readonly generatedAt: number;
  readonly totalCredits: number | null;
  readonly channels: ReadonlyArray<{ readonly name: string; readonly used: number; readonly total: number | null }>;
  readonly stale: boolean;
}

export interface SummaryResponse {
  readonly summary: Summary | null;
}

export type PollStatus = { readonly ok: true; readonly lastSuccess: number } | { readonly ok: false; readonly lastSuccess: number | null };
