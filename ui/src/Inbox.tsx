import { inboxGrantId } from "./focus.js";
import { cleanText, formatAgo } from "./format.js";
import { Icon } from "./Icon.js";
import { color, styles } from "./styles.js";
import type { InboxView } from "./types.js";
import { useAgingNow } from "./useAging.js";
import { Button, EmptyState, Panel, Pill, SectionHeader } from "./ui.js";

export interface InboxProps {
  readonly items: readonly InboxView[];
  /** Server time in ms of the last state, so ages do not depend on the browser clock. */
  readonly now: number;
  /** Open the confirmation for "+o" in `channel`. Sends nothing by itself. */
  readonly onGrant: (item: InboxView, channel: string) => void;
  readonly onDismiss: (item: InboxView) => void;
  /** Id of the item whose dismiss call is on its way. */
  readonly pendingId: string | null;
  /** Error text per item id (from a failed dismiss). */
  readonly errors: Readonly<Record<string, string>>;
  /** Id of the item whose grant call (from the confirmation dialog) is on its way; its Grant buttons are aria-disabled. */
  readonly grantingId?: string | null;
}

export const INBOX_HEADING_ID = "inbox-heading";

export function Inbox({ items, now, onGrant, onDismiss, pendingId, errors, grantingId = null }: InboxProps) {
  const current = useAgingNow(now);
  return (
    <Panel labelledBy={INBOX_HEADING_ID} style={items.length > 0 ? { borderColor: color.warn } : undefined}>
      <SectionHeader icon="shield" title="Needs op" id={INBOX_HEADING_ID} count={items.length} />
      {items.length === 0 ? (
        <EmptyState icon="shield-check" title="No open requests" hint="An agent that is denied an action it needs op for shows up here." />
      ) : (
        <ul aria-label="Open permission requests" style={styles.list}>
          {items.map((item) => {
            const channels = item.channel === null ? item.candidates : [item.channel];
            const agent = cleanText(item.agent);
            const where = item.channel !== null ? cleanText(item.channel) : item.candidates.length === 0 ? "an unknown channel" : `one of ${item.candidates.map(cleanText).join(", ")}`;
            const busy = pendingId === item.id;
            const granting = grantingId === item.id;
            return (
              <li key={item.id} style={styles.inboxItem}>
                <div style={styles.inboxHead}>
                  <Icon name="shield" color={color.warn} />
                  <div style={styles.stack}>
                    <p style={{ margin: 0, overflowWrap: "anywhere" }}>
                      <strong>{agent}</strong> → <span>{cleanText(item.action)}</span>
                    </p>
                    <span style={styles.smallRow}>
                      <Pill icon="hash">{where}</Pill>
                      <span style={styles.muted}>was denied {formatAgo(current - item.ts)}</span>
                    </span>
                  </div>
                </div>
                <div style={styles.controls}>
                  {channels.map((channel) => (
                    <Button
                      key={channel}
                      id={inboxGrantId(item.id, channel)}
                      variant="primary"
                      size="sm"
                      icon="shield-check"
                      disabled={granting}
                      onClick={() => (granting ? undefined : onGrant(item, channel))}
                      // The accessible name starts with the visible text (label in name), then adds the agent and channel.
                      label={channels.length > 1 ? `Grant op in ${cleanText(channel)} to ${agent}` : `Grant op to ${agent} in ${cleanText(channel)}`}
                    >
                      Grant op{channels.length > 1 ? ` in ${cleanText(channel)}` : ""}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => (busy ? undefined : onDismiss(item))}
                    label={`${busy ? "Dismissing… request" : "Dismiss the request"} from ${agent}${item.channel === null ? "" : ` in ${cleanText(item.channel)}`}`}
                  >
                    {busy ? "Dismissing…" : "Dismiss"}
                  </Button>
                </div>
                {errors[item.id] === undefined ? null : (
                  <p role="alert" style={styles.text}>
                    Failed: {errors[item.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
