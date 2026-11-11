import type { ReactNode } from "react";
import { cleanText, modeLabel } from "./format.js";
import { styles } from "./styles.js";
import type { AgentView } from "./types.js";

export interface AgentRowProps {
  readonly agent: AgentView;
  /** Controls for this agent (mode control, Exorcise). */
  readonly children?: ReactNode;
  /** DOM id; the row can take programmatic focus (tabIndex -1) when its controls were replaced. */
  readonly id?: string;
}

/** One agent: nick, modes as icon and text, model, and a ready or starting indicator. */
export function AgentRow({ agent, children, id }: AgentRowProps) {
  const mode = modeLabel(agent.modes);
  const model = cleanText(agent.model);
  return (
    <li id={id} tabIndex={id === undefined ? undefined : -1} style={styles.row}>
      <strong>{cleanText(agent.nick)}</strong>
      <span style={styles.badge}>
        <span aria-hidden="true">{mode.icon} </span>
        <span>Modes: {mode.text}</span>
      </span>
      <span>Model: {model === "" ? "unknown" : model}</span>
      <span style={styles.badge}>
        <span aria-hidden="true">{agent.ready ? "✔ " : "◌ "}</span>
        {agent.ready ? "Ready" : "Starting"}
      </span>
      {children}
    </li>
  );
}
