import { cleanText, formatCredits } from "./format.js";
import { styles } from "./styles.js";
import type { Summary } from "./types.js";
import { EmptyState, Panel, Pill, SectionHeader, Skeleton, SrOnly } from "./ui.js";

export interface SummaryCardProps {
  /** `undefined` while the first answer is pending; `null` means there is no summary yet. */
  readonly summary: Summary | null | undefined;
  /** Total credits now, from the live state. Shown next to a summary that is not from today. `undefined` = not known yet. */
  readonly liveTotal?: number | null | undefined;
  /** Today's date as YYYY-MM-DD (UTC, like the summary date). Without it the summary is treated as current. */
  readonly today?: string | undefined;
}

/** True when the summary is from an earlier day than `today`. */
export const isOldSummary = (summary: Summary, today: string | undefined): boolean => today !== undefined && summary.date !== today;

export const SUMMARY_HEADING_ID = "summary-heading";

export function SummaryCard({ summary, liveTotal, today }: SummaryCardProps) {
  const old = summary !== undefined && summary !== null && isOldSummary(summary, today);
  return (
    <Panel labelledBy={SUMMARY_HEADING_ID}>
      <SectionHeader icon="coins" title="Daily summary" id={SUMMARY_HEADING_ID} actions={summary?.stale === true ? <Pill tone="warn" icon="alert-triangle">Stale</Pill> : undefined} />
      {summary === undefined ? (
        <>
          <SrOnly>Loading summary…</SrOnly>
          <Skeleton height="3rem" />
        </>
      ) : summary === null ? (
        <EmptyState icon="clock" title="No summary yet" hint="The backend writes one once a day." />
      ) : (
        <>
          <h3 style={{ ...styles.label, margin: 0 }}>{old ? `Last summary: ${cleanText(summary.date)}` : cleanText(summary.date)}</h3>
          {old && liveTotal !== undefined ? (
            <div style={{ ...styles.summaryRow, fontWeight: 600 }}>
              <span>Total credits now</span>
              <span style={styles.number}>{formatCredits(liveTotal)}</span>
            </div>
          ) : null}
          <div style={{ ...styles.summaryRow, fontWeight: old ? 400 : 600 }}>
            <span>{old ? "Total credits in that summary" : "Total credits"}</span>
            <span style={styles.number}>{formatCredits(summary.totalCredits)}</span>
          </div>
          {summary.stale ? <p style={{ ...styles.hint, margin: 0 }}>Figures were not refreshed in this run.</p> : null}
          {summary.channels.length === 0 ? (
            <p style={{ ...styles.hint, margin: 0 }}>No channel figures.</p>
          ) : (
            <ul aria-label="Credits per channel" style={styles.plainList}>
              {summary.channels.map((c) => (
                <li key={c.name} style={styles.summaryRow}>
                  <span style={{ overflowWrap: "anywhere" }}>{cleanText(c.name)}</span>
                  <span style={styles.number}>
                    {formatCredits(c.used)}
                    {c.total === null ? "" : ` of ${formatCredits(c.total)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
