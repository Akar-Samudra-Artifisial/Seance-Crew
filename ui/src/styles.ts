// Shared inline styles and design tokens. The host uses Tailwind with its own purged class set, so app class names would
// not exist; these styles read the host theme variables, with fallbacks for when a variable is missing. No CSS file, no
// CSS-in-JS. The one exception is FOCUS_CSS: a single scoped rule for the focus ring, because :focus-visible cannot be an
// inline style.
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
  /** Surface of buttons, pills, banners and tracks. */
  surface: v("bg-hover"),
  /** Card and dialog background. */
  card: v("card"),
  /** Body text. */
  cardFg: v("card-fg"),
  /** Secondary text (hints, times, labels). */
  mutedText: v("muted"),
  border: v("border"),
  accent: v("accent"),
  accentFg: v("accent-fg"),
  danger: v("danger"),
  // Status colours for borders, bars and icons only (never text). They always come with a word.
  ok: v("accent"),
  warn: "#f59e0b",
} as const;

// ---- tokens ------------------------------------------------------------------------------------

export const space = { xs: "0.25rem", icon: "0.375rem", sm: "0.5rem", md: "0.75rem", lg: "1rem", xl: "1.5rem", xxl: "2rem" } as const;
export const radius = { control: "0.375rem", button: "0.5rem", panel: "0.75rem", pill: "999px" } as const;
export const fontSize = { label: "0.75rem", code: "0.8125rem", small: "0.875rem", title: "1rem", stat: "1.5rem" } as const;
export const fontWeight = { regular: 400, medium: 500, bold: 600 } as const;
export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const tabular = { fontVariantNumeric: "tabular-nums" } as const satisfies CSSProperties;

export type Tone = "neutral" | "accent" | "warn" | "danger" | "muted";

/** The border/icon colour of a tone. Text stays --card-fg (or --muted) whatever the tone. */
export const toneColor: Readonly<Record<Tone, string>> = {
  neutral: color.border,
  accent: color.accent,
  warn: color.warn,
  danger: color.danger,
  muted: color.border,
};

/** Scope attribute of the page root and the dialog (the focus ring rule only applies inside). */
export const SCOPE_ATTR = "data-seance";

/** Visible focus ring for every interactive element of the page, keyboard focus only. */
export const FOCUS_CSS = `[${SCOPE_ATTR}] :is(button,a,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid ${color.accent};outline-offset:2px}`;

/** Attribute of the tile grid; TILES_CSS selects on it. */
export const TILES_ATTR = "data-seance-tiles";
/** Container widths (px) where the tile grid changes: 6 columns from TILES_WIDE_PX up, 3 below it, 2 below TILES_NARROW_PX. */
export const TILES_WIDE_PX = 900;
export const TILES_NARROW_PX = 500;

/**
 * Columns of the overview tiles from the width of their container (a container query, so the host's sidebar does not
 * matter): six in one row when wide, 3 + 3 under 900 px, three rows of two under 500 px. Inline styles cannot express a
 * query, so this is the second scoped rule next to FOCUS_CSS, rendered once by the page.
 */
export const TILES_CSS =
  `[${TILES_ATTR}]{grid-template-columns:repeat(6,minmax(0,1fr))}` +
  `@container (max-width:${TILES_WIDE_PX - 1}px){[${TILES_ATTR}]{grid-template-columns:repeat(3,minmax(0,1fr))}}` +
  `@container (max-width:${TILES_NARROW_PX - 1}px){[${TILES_ATTR}]{grid-template-columns:repeat(2,minmax(0,1fr))}}`;

// ---- styles ------------------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

const buttonBase: CSSProperties = {
  font: "inherit",
  fontSize: fontSize.small,
  fontWeight: fontWeight.medium,
  lineHeight: 1.25,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: space.icon,
  borderRadius: radius.button,
  border: `1px solid ${color.border}`,
  background: color.surface,
  color: color.cardFg,
  whiteSpace: "nowrap",
};

const buttonVariants: Readonly<Record<ButtonVariant, CSSProperties>> = {
  secondary: {},
  primary: { background: color.accent, color: color.accentFg, borderColor: color.accent },
  // Black on the host red: 5.6:1. White would only reach 3.8:1.
  danger: { background: color.danger, color: color.accentFg, borderColor: color.danger },
  // Card-coloured text on the card itself.
  ghost: { background: "transparent", borderColor: "transparent" },
};

const buttonSizes: Readonly<Record<ButtonSize, CSSProperties>> = {
  md: { padding: `${space.icon} 0.875rem` },
  sm: { padding: `${space.xs} 0.625rem` },
};

export const styles = {
  page: { padding: `0 ${space.xl} ${space.xxl}`, display: "flex", flexDirection: "column", gap: space.lg, color: color.cardFg } satisfies CSSProperties,
  heading: { fontSize: fontSize.title, fontWeight: fontWeight.bold, margin: 0 } satisfies CSSProperties,
  subheading: { fontSize: fontSize.label, fontWeight: fontWeight.bold, textTransform: "uppercase", letterSpacing: "0.04em", color: color.mutedText, margin: `${space.sm} 0 ${space.xs}` } satisfies CSSProperties,
  cardHeading: { fontSize: fontSize.title, fontWeight: fontWeight.bold, margin: 0, minWidth: 0, overflowWrap: "anywhere" } satisfies CSSProperties,
  text: { margin: `${space.xs} 0` } satisfies CSSProperties,
  hint: { margin: `${space.xs} 0`, color: color.mutedText, fontSize: fontSize.small } satisfies CSSProperties,
  label: { fontWeight: fontWeight.bold, fontSize: fontSize.small } satisfies CSSProperties,
  muted: { color: color.mutedText } satisfies CSSProperties,
  mono: { fontFamily: MONO } satisfies CSSProperties,
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: space.sm } satisfies CSSProperties,
  plainList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: space.xs } satisfies CSSProperties,
  row: { display: "flex", flexWrap: "wrap", gap: space.sm, alignItems: "center", padding: `${space.sm} ${space.md}`, border: `1px solid ${color.border}`, borderRadius: radius.control } satisfies CSSProperties,
  cardBody: { display: "flex", flexDirection: "column", gap: space.md } satisfies CSSProperties,
  controls: { display: "inline-flex", flexWrap: "wrap", gap: space.sm } satisfies CSSProperties,
  /** Pill base: neutral surface and body text; a tone only changes the border and the icon. */
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    padding: "0.125rem 0.5rem",
    borderRadius: radius.pill,
    border: `1px solid ${color.border}`,
    background: color.surface,
    color: color.cardFg,
    fontSize: fontSize.label,
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  panel: { background: color.card, color: color.cardFg, border: `1px solid ${color.border}`, borderRadius: radius.panel, padding: space.lg, minWidth: 0, display: "flex", flexDirection: "column", gap: space.md } satisfies CSSProperties,
  sectionHeader: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" } satisfies CSSProperties,
  // The overview row: the section is a size container and TILES_CSS picks the columns from ITS width (not the window's).
  statBox: { containerType: "inline-size" } satisfies CSSProperties,
  statGrid: { display: "grid", gap: space.md } satisfies CSSProperties,
  statTile: { gap: space.xs, padding: `${space.md} ${space.lg}` } satisfies CSSProperties,
  statusText: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, margin: 0 } satisfies CSSProperties,
  inboxItem: { display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, border: `1px solid ${color.border}`, borderRadius: radius.control } satisfies CSSProperties,
  inboxHead: { display: "flex", gap: space.sm, alignItems: "flex-start" } satisfies CSSProperties,
  stack: { display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 } satisfies CSSProperties,
  wrapRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm } satisfies CSSProperties,
  smallRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.icon, fontSize: fontSize.label } satisfies CSSProperties,
  commitRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, fontSize: fontSize.small } satisfies CSSProperties,
  summarySpread: { display: "flex", alignItems: "center", gap: space.icon } satisfies CSSProperties,
  logSummary: { cursor: "pointer", display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.small, fontWeight: fontWeight.bold } satisfies CSSProperties,
  form: { display: "flex", flexDirection: "column", gap: space.md } satisfies CSSProperties,
  bannerStack: { display: "flex", flexDirection: "column", gap: space.sm } satisfies CSSProperties,
  monoMuted: { fontFamily: MONO, color: color.mutedText, fontSize: fontSize.code, overflowWrap: "anywhere" } satisfies CSSProperties,
  controlsEnd: { display: "inline-flex", flexWrap: "wrap", gap: space.sm, justifyContent: "flex-end" } satisfies CSSProperties,
  statLabel: { display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.label, textTransform: "uppercase", letterSpacing: "0.04em", color: color.mutedText } satisfies CSSProperties,
  statValue: { fontSize: fontSize.stat, fontWeight: fontWeight.bold, ...tabular, margin: 0 } satisfies CSSProperties,
  columns: { display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" } satisfies CSSProperties,
  mainColumn: { flex: "999 1 34rem", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg } satisfies CSSProperties,
  aside: { flex: "1 1 20rem", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg } satisfies CSSProperties,
  statusBar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, fontSize: fontSize.small, margin: 0 } satisfies CSSProperties,
  empty: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: space.xs, padding: `${space.lg} ${space.sm}`, color: color.cardFg } satisfies CSSProperties,
  emptyTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, margin: 0 } satisfies CSSProperties,
  emptyHint: { fontSize: fontSize.small, color: color.mutedText, margin: 0 } satisfies CSSProperties,
  skeleton: { background: color.surface, borderRadius: radius.control } satisfies CSSProperties,
  meterTrack: { height: space.icon, borderRadius: radius.pill, background: color.surface, overflow: "hidden" } satisfies CSSProperties,
  meterFill: { height: "100%", borderRadius: radius.pill, background: color.accent } satisfies CSSProperties,
  agentRow: {
    display: "grid",
    gridTemplateColumns: "minmax(8rem, 1fr) auto auto 1fr",
    alignItems: "center",
    gap: space.sm,
    padding: `${space.sm} ${space.md}`,
    border: `1px solid ${color.border}`,
    borderRadius: radius.control,
  } satisfies CSSProperties,
  logBox: {
    fontFamily: MONO,
    fontSize: fontSize.code,
    maxHeight: "16rem",
    overflowY: "auto",
    overflowWrap: "anywhere",
    background: color.page,
    color: color.cardFg,
    border: `1px solid ${color.border}`,
    borderRadius: radius.control,
    padding: space.sm,
    margin: `${space.xs} 0`,
    listStyle: "none",
  } satisfies CSSProperties,
  logLine: { display: "grid", gridTemplateColumns: "auto 1fr", gap: space.sm, margin: 0, whiteSpace: "pre-wrap" } satisfies CSSProperties,
  logTime: { color: color.mutedText, fontSize: fontSize.label, ...tabular } satisfies CSSProperties,
  logMeta: { color: color.mutedText, fontStyle: "italic" } satisfies CSSProperties,
  untrusted: { display: "flex", alignItems: "center", gap: space.xs, margin: `${space.xs} 0`, fontSize: fontSize.code, fontWeight: fontWeight.bold, color: color.cardFg } satisfies CSSProperties,
  field: { display: "flex", flexDirection: "column", gap: space.xs, flex: "1 1 10rem", minWidth: 0 } satisfies CSSProperties,
  fieldRow: { display: "flex", flexWrap: "wrap", gap: space.md } satisfies CSSProperties,
  input: { font: "inherit", fontSize: fontSize.small, padding: `${space.icon} ${space.sm}`, borderRadius: radius.control, border: `1px solid ${color.border}`, background: color.card, color: color.cardFg, width: "100%", boxSizing: "border-box" } satisfies CSSProperties,
  summaryRow: { display: "flex", justifyContent: "space-between", gap: space.sm, fontSize: fontSize.small } satisfies CSSProperties,
  number: { ...tabular, textAlign: "right" } satisfies CSSProperties,
  overlay: { position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.5)" } satisfies CSSProperties,
  dialog: { background: color.card, color: color.cardFg, maxWidth: "28rem", width: "90%", padding: space.xl, borderRadius: radius.panel, border: `1px solid ${color.border}` } satisfies CSSProperties,
  dialogActions: { display: "flex", gap: space.sm, justifyContent: "flex-end" } satisfies CSSProperties,
  srOnly: { position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 } satisfies CSSProperties,
} as const;

export type BannerLevel = "ok" | "wait" | "problem";

/** Banner box: a coloured left bar and border on the host surface. The words and icon carry the meaning. */
export function bannerStyle(level: BannerLevel): CSSProperties {
  const tone = level === "ok" ? color.ok : level === "wait" ? color.warn : color.danger;
  return { margin: 0, padding: `${space.sm} ${space.md}`, borderRadius: radius.control, border: `1px solid ${tone}`, borderLeft: `${space.icon} solid ${tone}`, background: color.surface, color: color.cardFg, display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" };
}

/** A button style for a variant and size, with the disabled look when `aria-disabled` is in effect. */
export function buttonStyle(variant: ButtonVariant, disabled = false, size: ButtonSize = "md"): CSSProperties {
  const base = { ...buttonBase, ...buttonVariants[variant], ...buttonSizes[size] };
  return disabled ? { ...base, opacity: 0.6, cursor: "not-allowed" } : base;
}

/** A pill with a tone on the border only. */
export function pillStyle(tone: Tone): CSSProperties {
  return tone === "muted" ? { ...styles.badge, borderStyle: "dashed" } : { ...styles.badge, borderColor: toneColor[tone] };
}
