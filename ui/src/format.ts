// Small pure formatting helpers. Everything returns plain strings that components render as text nodes.

// C0 and C1 controls, DEL, and the bidi embedding/override/isolate controls (U+202A to U+202E, U+2066 to U+2069).
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** Channel text made safe to show: control and bidi-control characters are removed, so it cannot reorder what follows. */
export function cleanText(text: string): string {
  return text.replace(UNSAFE_TEXT, "");
}

/** Credits with two decimals, or "n/a" when unavailable. */
export function formatCredits(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
}

/** "1.50 of 10.00", "1.50" when the total is unknown, "n/a" when nothing is known. */
export function formatUsage(used: number | null, total: number | null): string {
  if (used === null) return "n/a";
  return total === null ? formatCredits(used) : `${formatCredits(used)} of ${formatCredits(total)}`;
}

/** Local wall-clock time, for example "14:03:09". */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function isoTime(ts: number): string {
  return new Date(ts).toISOString();
}

/** "5 s", "3 min", "2 h", "4 d" for an elapsed number of milliseconds. */
export function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86_400)} d`;
}

export interface ModeLabel {
  /** A glyph for sighted users; hidden from assistive technology. */
  readonly icon: string;
  /** The text that carries the meaning, so colour is never the only signal. */
  readonly text: string;
}

/** Modes as text and icon: "+o operator", "+v voice", both, or "no modes". */
export function modeLabel(modes: string): ModeLabel {
  const hasO = modes.includes("o");
  const hasV = modes.includes("v");
  if (hasO && hasV) return { icon: "◆", text: "+o +v operator, voice" };
  if (hasO) return { icon: "◆", text: "+o operator" };
  if (hasV) return { icon: "◇", text: "+v voice" };
  return { icon: "○", text: "no modes" };
}

export type ModeChange = "+v" | "-v" | "+o" | "-o";

/** The mode changes the mode control offers, +v first (the safer choice): none -> +v or +o, +v -> +o or -v, +o -> -o. */
export function modeChangesFor(modes: string): readonly ModeChange[] {
  if (modes.includes("o")) return ["-o"];
  if (modes.includes("v")) return ["+o", "-v"];
  return ["+v", "+o"];
}
