import { Card, CardTitle } from "@kirocrew/app-sdk/ui";
import { useId, type FormEvent } from "react";
import { buttonStyle, styles } from "./styles.js";

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
  const channelId = useId();
  const agentId = useId();
  const hintId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!pending) onSubmit();
  };
  return (
    <Card>
      <CardTitle>Summon an agent</CardTitle>
      <form onSubmit={submit} aria-busy={pending}>
        <div style={styles.field}>
          <label htmlFor={channelId} style={styles.label}>
            Channel
          </label>
          <input id={channelId} name="channel" style={styles.input} value={channel} placeholder="#fix-bug" onChange={(e) => onChange("channel", e.target.value)} aria-describedby={hintId} required />
          <span id={hintId} style={styles.hint}>
            The channel name must start with #. The crew account joins the channel first if it is not in it yet.
          </span>
        </div>
        <div style={styles.field}>
          <label htmlFor={agentId} style={styles.label}>
            Agent (optional)
          </label>
          <input id={agentId} name="agent" style={styles.input} value={agent} placeholder="coder" onChange={(e) => onChange("agent", e.target.value)} />
        </div>
        <button type="submit" style={buttonStyle("primary", pending)} disabled={pending}>
          {pending ? "Summoning…" : "Summon"}
        </button>
        {pending ? (
          <p role="status" style={styles.hint}>
            Joining the channel if needed, then waiting for the agent to say it is ready. This can take up to 30 seconds.
          </p>
        ) : null}
        {message === null ? null : message.ok ? (
          <p role="status" style={styles.text}>
            {message.text}
          </p>
        ) : (
          <p role="alert" style={{ ...styles.text, fontWeight: 600 }}>
            Failed: {message.text}
          </p>
        )}
      </form>
    </Card>
  );
}
