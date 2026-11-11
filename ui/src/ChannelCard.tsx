import type { ReactNode } from "react";
import { AgentRow } from "./AgentRow.js";
import { agentRowId, channelHeadingId } from "./focus.js";
import { cleanText, formatAgo, formatDateTime, formatUsage, isoTime } from "./format.js";
import { Icon } from "./Icon.js";
import { LogPanel } from "./LogPanel.js";
import { color, space, styles } from "./styles.js";
import type { AgentView, ChannelView, CommitView } from "./types.js";
import { commitsOf } from "./StatTiles.js";
import { EmptyState, Meter, Panel, Pill, SrOnly } from "./ui.js";

export interface ChannelCardProps {
  readonly channel: ChannelView;
  /** Controls rendered inside an agent's row (mode control, Exorcise). */
  readonly agentControls?: (agent: AgentView, channel: ChannelView) => ReactNode;
  /** Server time in ms of the state, for "active … ago" and commit ages. Defaults to the newest time in the channel. */
  readonly now?: number;
}

export const COMMITS_SHOWN = 5;

/** Milliseconds since the newest log line, or null when the channel has no lines. */
export function lastActivity(channel: ChannelView, now: number): number | null {
  if (channel.lines.length === 0) return null;
  return Math.max(0, now - Math.max(...channel.lines.map((l) => l.ts)));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function CreditsRow({ used, total }: { readonly used: number | null; readonly total: number | null }) {
  const text = formatUsage(used, total);
  return (
    <div style={{ ...styles.stack, gap: space.icon }}>
      <div style={styles.summaryRow}>
        <span style={{ ...styles.muted, ...styles.summarySpread }}>
          <Icon name="coins" />
          Credits used
        </span>
        <span style={styles.number}>{text}</span>
      </div>
      {used === null || total === null ? null : <Meter value={used} max={total} label="Credits used" valueText={`${text} credits used`} />}
    </div>
  );
}

interface CommitListProps {
  readonly commits: readonly CommitView[];
  /** Every commit the backend keeps for the channel, which can be more than the rows it sends. */
  readonly total: number;
  readonly now: number;
  readonly channel: string;
}

/**
 * The newest commits, newest first. The backend sends only the last few of the commits it keeps, so when there are more
 * the list says so ("Showing the newest 5 of 12") instead of offering a toggle that has nothing more to show.
 */
function CommitList({ commits, total, now, channel }: CommitListProps) {
  const shown = [...commits].reverse().slice(0, COMMITS_SHOWN);
  if (commits.length === 0) return <EmptyState icon="git-commit" title="No commits yet" />;
  return (
    <>
      <ul aria-label={`Latest commits in ${channel}`} style={styles.plainList}>
        {shown.map((commit, index) => (
          <li key={`${commit.sha}-${commit.ts}-${index}`} style={styles.commitRow}>
            <Icon name="git-commit" color={color.mutedText} />
            <span style={{ ...styles.badge, ...styles.mono }}>{cleanText(commit.sha)}</span>
            <span>{cleanText(commit.agent)}</span>
            <span style={styles.muted}>{plural(commit.files, "file", "files")}</span>
            <time dateTime={isoTime(commit.ts)} title={formatDateTime(commit.ts)} style={{ ...styles.muted, marginLeft: "auto" }}>
              {formatAgo(now - commit.ts)}
            </time>
          </li>
        ))}
      </ul>
      {total > shown.length ? (
        <p style={{ ...styles.hint, margin: 0 }}>
          Showing the newest {shown.length} of {total} commits.
        </p>
      ) : null}
    </>
  );
}

export function ChannelCard({ channel, agentControls, now }: ChannelCardProps) {
  const name = cleanText(channel.name);
  const topic = cleanText(channel.topic);
  const at = now ?? Math.max(0, ...channel.lines.map((l) => l.ts), ...channel.commits.map((c) => c.ts));
  const idle = lastActivity(channel, at);
  const headingId = channelHeadingId(channel.name);
  return (
    <Panel labelledBy={headingId}>
      <div style={styles.stack}>
        <div style={styles.wrapRow}>
          <Icon name="hash" color={color.mutedText} />
          {/* Own heading instead of CardTitle so it can take programmatic focus when the agent that held it is gone. */}
          <h3 id={headingId} tabIndex={-1} style={styles.cardHeading}>
            {name}
          </h3>
          <Pill icon="users">{plural(channel.count, "member", "members")}</Pill>
          <Pill icon="bot">{plural(channel.agents.length, "agent", "agents")}</Pill>
          {idle === null ? null : <Pill icon="clock">active {formatAgo(idle)}</Pill>}
        </div>
        {topic === "" ? null : (
          <p title={topic} style={{ ...styles.hint, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <SrOnly>Topic: </SrOnly>
            {topic}
          </p>
        )}
      </div>
      <CreditsRow used={channel.credits.used} total={channel.credits.total} />
      <div>
        <h4 style={styles.subheading}>Agents</h4>
        {channel.agents.length === 0 ? (
          <EmptyState icon="bot" title="No agents in this channel" hint="Summon one with the form on this page." />
        ) : (
          <ul aria-label={`Agents in ${name}`} style={styles.list}>
            {channel.agents.map((agent) => (
              <AgentRow key={agent.nick} agent={agent} id={agentRowId(channel.name, agent.nick)}>
                {agentControls?.(agent, channel)}
              </AgentRow>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 style={styles.subheading}>Latest commits</h4>
        <CommitList commits={channel.commits} total={commitsOf(channel)} now={at} channel={name} />
      </div>
      <LogPanel channel={channel.name} lines={channel.lines} />
    </Panel>
  );
}
