import { controlId } from "./focus.js";
import { cleanText, modeChangesFor, type ModeChange } from "./format.js";
import { styles } from "./styles.js";
import type { AgentView } from "./types.js";
import { Button } from "./ui.js";

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
        <Button
          key={mode}
          id={controlId(channel, agent.nick, mode)}
          size="sm"
          icon={mode.startsWith("-") ? "minus" : "plus"}
          disabled={busy}
          onClick={() => (busy ? undefined : onMode(agent, channel, mode))}
          label={`${verb(mode)} ${mode} ${preposition(mode)} ${nick} in ${where}`}
        >
          {verb(mode)} {mode}
        </Button>
      ))}
      <Button
        id={controlId(channel, agent.nick, "x")}
        variant="danger"
        size="sm"
        icon="x"
        disabled={busy}
        onClick={() => (busy ? undefined : onExorcise(agent, channel))}
        label={`Exorcise ${nick} from ${where}`}
      >
        Exorcise
      </Button>
    </span>
  );
}
