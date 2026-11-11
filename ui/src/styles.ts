// Shared inline styles. The host uses Tailwind with its own purged class set, so app class names would not exist; these
// styles read the host theme variables, with fallbacks for when a variable is missing. No CSS file, no CSS-in-JS.
import type { CSSProperties } from "react";

/**
 * The host theme values (read from the host CSS) that are also the fallbacks. Keep them as one coherent set: every
 * text/background pair used below reaches 4.5:1 with exactly these values (ui/test/contrast.test.ts checks it).
 *
 * Note the host's naming: `--muted` is a muted TEXT colour, and `--muted-fg` is black. Never read `--muted-fg`.
 */
export const HOST_THEME = {
  bg: "#12141a",
  "bg-hover": "#262a35",
  card: "#181b22",
  "card-fg": "#f4f4f5",
  muted: "#909098",
  border: "#27272a",
  accent: "#00d492",
  "accent-fg": "#000000",
  danger: "#ef4444",
} as const;

const v = (name: keyof typeof HOST_THEME): string => `var(--${name}, ${HOST_THEME[name]})`;

export const color = {
  /** Page background. */
  page: v("bg"),
  /** Surface of buttons, banners and badges. */
  surface: v("bg-hover"),
  /** Card and dialog background. */
  card: v("card"),
  /** Body text. */
  cardFg: v("card-fg"),
  /** Secondary text (hints, times). */
  mutedText: v("muted"),
  border: v("border"),
  accent: v("accent"),
  accentFg: v("accent-fg"),
  danger: v("danger"),
  // Status colours for borders and bars only (never text). They always come with a word and an icon.
  ok: v("accent"),
  warn: "#f59e0b",
} as const;

const button: CSSProperties = {
  font: "inherit",
  cursor: "pointer",
  padding: "0.35rem 0.75rem",
  borderRadius: "0.375rem",
  border: `1px solid ${color.border}`,
  background: color.surface,
  color: color.cardFg,
};

export const styles = {
  page: { padding: "0 1.5rem 2rem", display: "flex", flexDirection: "column", gap: "1rem", color: color.cardFg } satisfies CSSProperties,
  heading: { fontSize: "1.125rem", fontWeight: 600, margin: "0.5rem 0" } satisfies CSSProperties,
  subheading: { fontSize: "0.95rem", fontWeight: 600, margin: "0.75rem 0 0.25rem" } satisfies CSSProperties,
  cardHeading: { fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" } satisfies CSSProperties,
  text: { margin: "0.25rem 0" } satisfies CSSProperties,
  hint: { margin: "0.25rem 0", color: color.mutedText, fontSize: "0.875rem" } satisfies CSSProperties,
  list: { listStyle: "none", padding: 0, margin: "0.25rem 0", display: "flex", flexDirection: "column", gap: "0.5rem" } satisfies CSSProperties,
  plainList: { margin: "0.25rem 0", paddingLeft: "1.25rem" } satisfies CSSProperties,
  row: { display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", padding: "0.4rem 0.6rem", border: `1px solid ${color.border}`, borderRadius: "0.375rem" } satisfies CSSProperties,
  cardBody: { display: "flex", flexDirection: "column", gap: "0.25rem" } satisfies CSSProperties,
  controls: { display: "inline-flex", flexWrap: "wrap", gap: "0.5rem" } satisfies CSSProperties,
  badge: { display: "inline-block", padding: "0 0.4rem", borderRadius: "999px", border: `1px solid ${color.border}`, background: color.surface, color: color.cardFg, fontSize: "0.8rem" } satisfies CSSProperties,
  button,
  buttonPrimary: { ...button, background: color.accent, color: color.accentFg, borderColor: color.accent } satisfies CSSProperties,
  // Black on the host red: 5.6:1. White would only reach 3.8:1.
  buttonDanger: { ...button, background: color.danger, color: color.accentFg, borderColor: color.danger } satisfies CSSProperties,
  buttonDisabled: { opacity: 0.6, cursor: "not-allowed" } satisfies CSSProperties,
  field: { display: "flex", flexDirection: "column", gap: "0.25rem", margin: "0.5rem 0" } satisfies CSSProperties,
  label: { fontWeight: 600, fontSize: "0.875rem" } satisfies CSSProperties,
  input: { font: "inherit", padding: "0.35rem 0.5rem", borderRadius: "0.375rem", border: `1px solid ${color.border}`, background: color.card, color: color.cardFg, maxWidth: "24rem" } satisfies CSSProperties,
  logBox: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "0.8125rem",
    maxHeight: "16rem",
    overflowY: "auto",
    overflowWrap: "anywhere",
    background: color.page,
    color: color.cardFg,
    border: `1px solid ${color.border}`,
    borderRadius: "0.375rem",
    padding: "0.5rem",
    margin: "0.25rem 0",
    listStyle: "none",
  } satisfies CSSProperties,
  logLine: { margin: 0, whiteSpace: "pre-wrap" } satisfies CSSProperties,
  logTime: { color: color.mutedText } satisfies CSSProperties,
  untrusted: { margin: "0.25rem 0", fontSize: "0.8125rem", fontWeight: 600, color: color.cardFg } satisfies CSSProperties,
  overlay: { position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.5)" } satisfies CSSProperties,
  dialog: { background: color.card, color: color.cardFg, maxWidth: "28rem", width: "90%", padding: "1.25rem", borderRadius: "0.75rem", border: `1px solid ${color.border}` } satisfies CSSProperties,
  dialogActions: { display: "flex", gap: "0.5rem", justifyContent: "flex-end" } satisfies CSSProperties,
  srOnly: { position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 } satisfies CSSProperties,
} as const;

export type BannerLevel = "ok" | "wait" | "problem";

/** Banner box: a coloured left bar and border on the host surface. The words and icon carry the meaning. */
export function bannerStyle(level: BannerLevel): CSSProperties {
  const tone = level === "ok" ? color.ok : level === "wait" ? color.warn : color.danger;
  return { margin: "0.25rem 0", padding: "0.5rem 0.75rem", borderRadius: "0.375rem", border: `1px solid ${tone}`, borderLeft: `0.375rem solid ${tone}`, background: color.surface, color: color.cardFg };
}

/** A button style for a role, with the disabled look when `aria-disabled` is in effect. */
export function buttonStyle(role: "plain" | "primary" | "danger", disabled = false): CSSProperties {
  const base = role === "primary" ? styles.buttonPrimary : role === "danger" ? styles.buttonDanger : styles.button;
  return disabled ? { ...base, ...styles.buttonDisabled } : base;
}
