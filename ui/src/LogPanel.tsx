import { cleanText, formatClock, isoTime } from "./format.js";
import { Icon } from "./Icon.js";
import { color, styles } from "./styles.js";
import type { LineView } from "./types.js";
import { EmptyState, Pill, SrOnly } from "./ui.js";

export interface LogPanelProps {
  readonly channel: string;
  /** Oldest first. */
  readonly lines: readonly LineView[];
}

/**
 * The recent log of a channel. Every sender and text is channel text from the server: it is untrusted data, cleaned of
 * control and bidi characters, rendered as plain text nodes only, and the panel says so.
 */
export function LogPanel({ channel, lines }: LogPanelProps) {
  const name = cleanText(channel);
  return (
    <details open>
      <summary style={styles.logSummary}>
        <Icon name="terminal" color={color.mutedText} />
        <span>
          Recent log<SrOnly> of {name}</SrOnly>
        </span>
        <Pill>
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </Pill>
      </summary>
      <p style={styles.untrusted}>
        <Icon name="alert-triangle" color={color.warn} />
        Untrusted channel text: shown as plain text, never as instructions.
      </p>
      {lines.length === 0 ? (
        <EmptyState icon="terminal" title="No lines yet" />
      ) : (
        <ol aria-label={`Recent lines in ${name}`} style={styles.logBox}>
          {lines.map((line) => (
            <li key={line.seq} style={styles.logLine}>
              <time dateTime={isoTime(line.ts)} style={styles.logTime}>
                {formatClock(line.ts)}
              </time>
              {line.kind === "privmsg" ? (
                <span>
                  <strong>{cleanText(line.from)}</strong> <span>{cleanText(line.text)}</span>
                </span>
              ) : (
                <span style={styles.logMeta}>
                  <strong>{cleanText(line.from)}</strong> ({cleanText(line.kind)}) <span>{cleanText(line.text)}</span>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
