import { useId, type FormEvent } from "react";
import { styles } from "./styles.js";
import { Button, Panel, SectionHeader } from "./ui.js";

export interface SummonMessage {
  readonly ok: boolean;
  readonly text: string;
}

export interface SummonFormProps {
  readonly channel: string;
  readonly agent: string;
  readonly pending: boolean;
  /** The result of the last attempt. A failure leaves the field values as they were. */
  readonly message: SummonMessage | null;
  readonly onChange: (field: "channel" | "agent", value: string) => void;
  readonly onSubmit: () => void;
}

export function SummonForm({ channel, agent, pending, message, onChange, onSubmit }: SummonFormProps) {
  const headingId = useId();
  const channelId = useId();
  const agentId = useId();
  const hintId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!pending) onSubmit();
  };
  return (
    <Panel labelledBy={headingId}>
      <SectionHeader icon="wand" title="Summon an agent" id={headingId} />
      <form onSubmit={submit} aria-busy={pending} style={styles.form}>
        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label htmlFor={channelId} style={styles.label}>
              Channel
            </label>
            <input id={channelId} name="channel" style={styles.input} value={channel} placeholder="#fix-bug" onChange={(e) => onChange("channel", e.target.value)} aria-describedby={hintId} required />
          </div>
          <div style={styles.field}>
            <label htmlFor={agentId} style={styles.label}>
              Agent (optional)
            </label>
            <input id={agentId} name="agent" style={styles.input} value={agent} placeholder="coder" onChange={(e) => onChange("agent", e.target.value)} />
          </div>
        </div>
        <p id={hintId} style={{ ...styles.hint, margin: 0 }}>
          The channel name must start with #. The crew account joins the channel first if it is not in it yet.
        </p>
        {/* aria-disabled, not disabled: a disabled button drops focus to <body>. submit() ignores presses while pending. */}
        <div>
          <Button type="submit" variant="primary" icon="wand" disabled={pending}>
            {pending ? "Summoning…" : "Summon"}
          </Button>
        </div>
        {pending ? (
          <p role="status" style={{ ...styles.hint, margin: 0 }}>
            Joining the channel if needed, then waiting for the agent to say it is ready. This can take up to 30 seconds.
          </p>
        ) : null}
        {message === null ? null : message.ok ? (
          <p role="status" style={{ ...styles.text, margin: 0 }}>
            {message.text}
          </p>
        ) : (
          <p role="alert" style={{ ...styles.text, margin: 0, fontWeight: 600 }}>
            Failed: {message.text}
          </p>
        )}
      </form>
    </Panel>
  );
}
