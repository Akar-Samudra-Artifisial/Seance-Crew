import type { ReactNode } from "react";
import { cleanText, modeLabel } from "./format.js";
import { space, styles } from "./styles.js";
import type { AgentView } from "./types.js";
import { Pill, SrOnly } from "./ui.js";

export interface AgentRowProps {
  readonly agent: AgentView;
  /** Controls for this agent (mode control, Exorcise). */
  readonly children?: ReactNode;
  /** DOM id; the row can take programmatic focus (tabIndex -1) when its controls were replaced. */
  readonly id?: string;
}

/** One agent as a table-like row: nick, mode pill, model, ready pill, and the controls aligned right. */
export function AgentRow({ agent, children, id }: AgentRowProps) {
  const mode = modeLabel(agent.modes);
  const model = cleanText(agent.model);
  return (
    <li id={id} tabIndex={id === undefined ? undefined : -1} style={styles.agentRow}>
      <strong style={{ overflowWrap: "anywhere" }}>{cleanText(agent.nick)}</strong>
      <span style={{ ...styles.controls, gap: space.icon }}>
        <Pill tone={mode.tone} icon={mode.icon}>
          <SrOnly>Modes: </SrOnly>
          {mode.text}
        </Pill>
        <Pill tone={agent.ready ? "accent" : "muted"} icon={agent.ready ? "check-circle" : "circle-dashed"}>
          {agent.ready ? "Ready" : "Starting"}
        </Pill>
      </span>
      <span style={styles.monoMuted}>
        <SrOnly>Model: </SrOnly>
        {model === "" ? "unknown model" : model}
      </span>
      <span style={styles.controlsEnd}>{children}</span>
    </li>
  );
}
