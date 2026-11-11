import { Card } from "@kirocrew/app-sdk/ui";
import type { ReactNode } from "react";
import { AgentRow } from "./AgentRow.js";
import { agentRowId, channelHeadingId } from "./focus.js";
import { cleanText, formatTime, formatUsage, isoTime } from "./format.js";
import { LogPanel } from "./LogPanel.js";
import { styles } from "./styles.js";
import type { AgentView, ChannelView } from "./types.js";

export interface ChannelCardProps {
  readonly channel: ChannelView;
  /** Controls rendered inside an agent's row (mode control, Exorcise). */
  readonly agentControls?: (agent: AgentView, channel: ChannelView) => ReactNode;
}

export function ChannelCard({ channel, agentControls }: ChannelCardProps) {
  const name = cleanText(channel.name);
  return (
    <Card>
      {/* Own heading instead of CardTitle so it can take programmatic focus when the agent that held it is gone. */}
      <h3 id={channelHeadingId(channel.name)} tabIndex={-1} style={styles.cardHeading}>
        {name}
      </h3>
      <div style={styles.cardBody}>
        {channel.topic === "" ? null : <p style={styles.text}>Topic: {cleanText(channel.topic)}</p>}
        <p style={styles.text}>
          {channel.count} {channel.count === 1 ? "member" : "members"}. Credits used: {formatUsage(channel.credits.used, channel.credits.total)}
        </p>
        <h4 style={styles.subheading}>Agents</h4>
        {channel.agents.length === 0 ? (
          <p style={styles.hint}>No agents in this channel.</p>
        ) : (
          <ul aria-label={`Agents in ${name}`} style={styles.list}>
            {channel.agents.map((agent) => (
              <AgentRow key={agent.nick} agent={agent} id={agentRowId(channel.name, agent.nick)}>
                {agentControls?.(agent, channel)}
              </AgentRow>
            ))}
          </ul>
        )}
        <h4 style={styles.subheading}>Latest commits</h4>
        {channel.commits.length === 0 ? (
          <p style={styles.hint}>No commits yet.</p>
        ) : (
          <ul aria-label={`Latest commits in ${name}`} style={styles.plainList}>
            {[...channel.commits].reverse().map((commit) => (
              <li key={`${commit.sha}-${commit.ts}`}>
                <code>{cleanText(commit.sha)}</code> by {cleanText(commit.agent)}, {commit.files} {commit.files === 1 ? "file" : "files"},{" "}
                <time dateTime={isoTime(commit.ts)}>{formatTime(commit.ts)}</time>
              </li>
            ))}
          </ul>
        )}
        <LogPanel channel={channel.name} lines={channel.lines} />
      </div>
    </Card>
  );
}
