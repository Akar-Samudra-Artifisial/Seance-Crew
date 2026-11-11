import { cleanText, modeChangesFor, type ModeChange } from "./format.js";
import { controlId } from "./focus.js";
import { buttonStyle, styles } from "./styles.js";
import type { AgentView } from "./types.js";

export interface AgentControlsProps {
  readonly agent: AgentView;
  readonly channel: string;
  /** Open the confirmation for a mode change. Sends nothing by itself. */
  readonly onMode: (agent: AgentView, channel: string, mode: ModeChange) => void;
  /** Open the confirmation for an exorcise. Sends nothing by itself. */
  readonly onExorcise: (agent: AgentView, channel: string) => void;
  /** True while a request for this agent is on its way: the buttons are aria-disabled (still focusable) and do nothing. */
  readonly busy?: boolean;
}

const verb = (mode: ModeChange): string => (mode.startsWith("-") ? "Revoke" : "Give");
const preposition = (mode: ModeChange): string => (mode.startsWith("-") ? "from" : "to");

/**
 * The mode control (+v <-> +o and back) and the Exorcise button of one agent. Every change goes through the dialog.
 * Buttons use `aria-disabled` and a guard instead of `disabled`, so a button that has focus keeps it while busy.
 */
export function AgentControls({ agent, channel, onMode, onExorcise, busy = false }: AgentControlsProps) {
  const nick = cleanText(agent.nick);
  const where = cleanText(channel);
  return (
    <span style={styles.controls}>
      {modeChangesFor(agent.modes).map((mode) => (
        <button
          key={mode}
          id={controlId(channel, agent.nick, mode)}
          type="button"
          style={buttonStyle("plain", busy)}
          aria-disabled={busy}
          onClick={() => (busy ? undefined : onMode(agent, channel, mode))}
          aria-label={`${verb(mode)} ${mode} ${preposition(mode)} ${nick} in ${where}`}
        >
          {verb(mode)} {mode}
        </button>
      ))}
      <button
        id={controlId(channel, agent.nick, "x")}
        type="button"
        style={buttonStyle("danger", busy)}
        aria-disabled={busy}
        onClick={() => (busy ? undefined : onExorcise(agent, channel))}
        aria-label={`Exorcise ${nick} from ${where}`}
      >
        Exorcise
      </button>
    </span>
  );
}
