import { formatCredits } from "./format.js";
import { styles, TILES_ATTR } from "./styles.js";
import type { ChannelView, State } from "./types.js";
import { Skeleton, StatTile } from "./ui.js";

export interface Overview {
  readonly channels: number;
  readonly agentsReady: number;
  readonly agentsTotal: number;
  /** Agents with +o, counted per channel. */
  readonly operators: number;
  readonly needsOp: number;
  readonly totalCredits: number | null;
  readonly commits: number;
}

/** Commits the backend keeps for a channel; an older backend sends only the newest few, so fall back to those. */
export const commitsOf = (channel: ChannelView): number => Math.max(channel.commitCount ?? 0, channel.commits.length);

/** The overview figures, counted from the state the page already has (agents are counted per channel). */
export function overviewStats(state: State): Overview {
  const agents = state.channels.flatMap((c) => c.agents);
  return {
    channels: state.channels.length,
    agentsReady: agents.filter((a) => a.ready).length,
    agentsTotal: agents.length,
    operators: agents.filter((a) => a.modes.includes("o")).length,
    needsOp: state.inbox.length,
    totalCredits: state.totalCredits,
    commits: state.channels.reduce((sum, c) => sum + commitsOf(c), 0),
  };
}

export const TILE_COUNT = 6;

/** The overview row. While the first state loads it shows six placeholder tiles. */
export function StatTiles({ state }: { readonly state: State | null }) {
  const grid = { [TILES_ATTR]: "" };
  if (state === null) {
    return (
      <section aria-label="Overview" style={styles.statBox}>
        <div {...grid} style={styles.statGrid}>
          {Array.from({ length: TILE_COUNT }, (_, i) => (
            <Skeleton key={i} height="4.5rem" />
          ))}
        </div>
      </section>
    );
  }
  const o = overviewStats(state);
  return (
    <section aria-label="Overview" style={styles.statBox}>
      <div {...grid} style={styles.statGrid}>
        <StatTile icon="hash" label="Channels" value={o.channels} />
        <StatTile icon="bot" label="Agents ready" value={`${o.agentsReady} / ${o.agentsTotal}`} />
        <StatTile icon="shield-check" label="Operators" value={o.operators} />
        <StatTile icon="shield" label="Needs op" value={o.needsOp} tone={o.needsOp > 0 ? "warn" : "neutral"} />
        <StatTile icon="coins" label="Total credits" value={formatCredits(o.totalCredits)} />
        <StatTile icon="git-commit" label="Commits" value={o.commits} />
      </div>
    </section>
  );
}
