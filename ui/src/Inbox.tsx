import { Card, CardTitle } from "@kirocrew/app-sdk/ui";
import { useEffect, useRef, useState } from "react";
import { cleanText, formatAge } from "./format.js";
import { buttonStyle, styles } from "./styles.js";
import { agedNow, AGE_TICK_MS, startTicker, type Anchor } from "./ticker.js";
import type { InboxView } from "./types.js";

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

/** Server time that keeps moving between polls: re-rendered every 30 s, timer removed on unmount. */
function useAgingNow(serverNow: number): number {
  const anchor = useRef<Anchor>({ server: serverNow, local: Date.now() });
  if (anchor.current.server !== serverNow) anchor.current = { server: serverNow, local: Date.now() };
  const [, setTick] = useState(0);
  useEffect(() => startTicker(AGE_TICK_MS, () => setTick((t) => t + 1)), []);
  return agedNow(anchor.current, Date.now());
}

export function Inbox({ items, now, onGrant, onDismiss, pendingId, errors, grantingId = null }: InboxProps) {
  const current = useAgingNow(now);
  return (
    <Card>
      <CardTitle>Needs op</CardTitle>
      {items.length === 0 ? (
        <p style={styles.text}>No open permission requests.</p>
      ) : (
        <ul aria-label="Open permission requests" style={styles.list}>
          {items.map((item) => {
            const channels = item.channel === null ? item.candidates : [item.channel];
            const agent = cleanText(item.agent);
            const where = item.channel !== null ? cleanText(item.channel) : item.candidates.length === 0 ? "an unknown channel" : `one of ${item.candidates.map(cleanText).join(", ")}`;
            const busy = pendingId === item.id;
            const granting = grantingId === item.id;
            return (
              <li key={item.id} style={{ ...styles.row, flexDirection: "column", alignItems: "flex-start" }}>
                <p style={styles.text}>
                  <strong>{agent}</strong> in {where} was denied: {cleanText(item.action)}. Waiting {formatAge(current - item.ts)}.
                </p>
                <div style={styles.controls}>
                  {channels.map((channel) => (
                    <button
                      key={channel}
                      type="button"
                      style={buttonStyle("primary", granting)}
                      aria-disabled={granting}
                      onClick={() => (granting ? undefined : onGrant(item, channel))}
                      aria-label={`Grant op to ${agent} in ${cleanText(channel)}`}
                    >
                      Grant op{channels.length > 1 ? ` in ${cleanText(channel)}` : ""}
                    </button>
                  ))}
                  <button
                    type="button"
                    style={buttonStyle("plain", busy)}
                    aria-disabled={busy}
                    onClick={() => (busy ? undefined : onDismiss(item))}
                    aria-label={`Dismiss the request from ${agent}${item.channel === null ? "" : ` in ${cleanText(item.channel)}`}`}
                  >
                    {busy ? "Dismissing…" : "Dismiss"}
                  </button>
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
    </Card>
  );
}
