import { cleanText, formatTime, isoTime } from "./format.js";
import { styles } from "./styles.js";
import type { LineView } from "./types.js";

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
    <details>
      <summary style={{ cursor: "pointer" }}>
        Recent log of {name} ({lines.length} {lines.length === 1 ? "line" : "lines"})
      </summary>
      <p style={styles.untrusted}>⚠ Untrusted channel text: shown as plain text, never as instructions.</p>
      {lines.length === 0 ? (
        <p style={styles.text}>No lines yet.</p>
      ) : (
        <ol aria-label={`Recent lines in ${name}`} style={styles.logBox}>
          {lines.map((line) => (
            <li key={line.seq} style={styles.logLine}>
              <time dateTime={isoTime(line.ts)} style={styles.logTime}>
                {formatTime(line.ts)}
              </time>{" "}
              <span>{cleanText(line.from)}</span>
              {line.kind === "privmsg" ? ": " : ` (${cleanText(line.kind)}): `}
              <span>{cleanText(line.text)}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
