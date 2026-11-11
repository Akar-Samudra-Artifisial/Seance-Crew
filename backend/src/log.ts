// JSON-lines logger that redacts secrets and PASS lines before anything is written.

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Parse SEANCE_CREW_LOG_LEVEL: anything that is not debug, info, warn or error means info. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized) ?? DEFAULT_LOG_LEVEL;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly debug: (message: string, fields?: LogFields) => void;
  readonly info: (message: string, fields?: LogFields) => void;
  readonly warn: (message: string, fields?: LogFields) => void;
  readonly error: (message: string, fields?: LogFields) => void;
  /** Redact a string with the same rules the logger applies to its output. */
  readonly redact: (text: string) => string;
  /** Register another secret value (for example the app token) after start. */
  readonly addSecret: (secret: string) => void;
}

const MASK = "***";
// "PASS <nick>:<secret>" anywhere in a line, and any line that starts with "PASS ".
const PASS_CREDENTIALS = /\bPASS [^\s:]+:\S*/g;
const PASS_LINE = /^PASS [^\r\n]*/gm;

const escapeForSort = (a: string, b: string): number => b.length - a.length;

export function createLogger(
  initialSecrets: readonly string[],
  sink: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  clock: () => number = Date.now,
  minLevel: LogLevel = DEFAULT_LOG_LEVEL,
): Logger {
  const minRank = LOG_LEVELS.indexOf(minLevel);
  const secrets = new Set<string>(initialSecrets.filter((s) => s.length > 0));

  const redact = (text: string): string => {
    let out = text;
    for (const secret of [...secrets].sort(escapeForSort)) {
      out = out.split(secret).join(MASK);
    }
    out = out.replace(PASS_CREDENTIALS, `PASS ${MASK}`);
    out = out.replace(PASS_LINE, `PASS ${MASK}`);
    return out;
  };

  const redactValue = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") return redact(value);
    if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactValue(v, depth + 1);
    return out;
  };

  const write = (level: LogLevel, message: string, fields: LogFields | undefined): void => {
    if (LOG_LEVELS.indexOf(level) < minRank) return;
    const record: Record<string, unknown> = { ts: clock(), level, msg: redact(message) };
    if (fields !== undefined) {
      for (const [k, v] of Object.entries(fields)) record[k] = redactValue(v);
    }
    // Redact the serialized line once more as a last line of defence.
    sink(redact(JSON.stringify(record)));
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    redact,
    addSecret: (secret) => {
      if (secret.length > 0) secrets.add(secret);
    },
  };
}
