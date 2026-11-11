import { Card, CardTitle } from "@kirocrew/app-sdk/ui";
import { cleanText, formatCredits } from "./format.js";
import { styles } from "./styles.js";
import type { Summary } from "./types.js";

export interface SummaryCardProps {
  /** `undefined` while the first answer is pending; `null` means there is no summary yet. */
  readonly summary: Summary | null | undefined;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  return (
    <Card>
      <CardTitle>Daily summary</CardTitle>
      {summary === undefined ? (
        <p style={styles.text}>Loading summary…</p>
      ) : summary === null ? (
        <p style={styles.text}>No summary yet</p>
      ) : (
        <>
          <p style={styles.text}>
            {cleanText(summary.date)}: total credits {formatCredits(summary.totalCredits)}.
            {summary.stale ? " Figures were not refreshed in this run." : ""}
          </p>
          {summary.channels.length === 0 ? (
            <p style={styles.hint}>No channel figures.</p>
          ) : (
            <ul aria-label="Credits per channel" style={styles.plainList}>
              {summary.channels.map((c) => (
                <li key={c.name}>
                  {cleanText(c.name)}: {formatCredits(c.used)}
                  {c.total === null ? "" : ` of ${formatCredits(c.total)}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
