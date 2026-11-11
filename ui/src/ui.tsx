// Small shared building blocks, so every section of the page has one look: Panel, SectionHeader, Pill, Button,
// EmptyState, Skeleton, StatTile and Meter. Inline styles only (see styles.ts).
import { forwardRef, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";
import { buttonStyle, color, pillStyle, styles, toneColor, type ButtonSize, type ButtonVariant, type Tone } from "./styles.js";

/** A card surface. `labelledBy` names the region after its heading. */
export function Panel({ children, labelledBy, label, style }: { readonly children?: ReactNode | undefined; readonly labelledBy?: string | undefined; readonly label?: string | undefined; readonly style?: CSSProperties | undefined }) {
  return (
    <section aria-labelledby={labelledBy} aria-label={label} style={style === undefined ? styles.panel : { ...styles.panel, ...style }}>
      {children}
    </section>
  );
}

export interface SectionHeaderProps {
  readonly icon?: IconName | undefined;
  readonly title: ReactNode;
  readonly count?: number | undefined;
  readonly actions?: ReactNode | undefined;
  readonly level?: 2 | 3 | undefined;
  /** DOM id of the heading; with `focusable` it can take programmatic focus (tabIndex -1). */
  readonly id?: string | undefined;
  readonly focusable?: boolean | undefined;
}

export function SectionHeader({ icon, title, count, actions, level = 2, id, focusable = false }: SectionHeaderProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div style={styles.sectionHeader}>
      {icon === undefined ? null : <Icon name={icon} color={color.mutedText} />}
      <Heading id={id} tabIndex={focusable ? -1 : undefined} style={styles.heading}>
        {title}
      </Heading>
      {count === undefined ? null : <Pill tone="neutral">{count}</Pill>}
      {actions === undefined ? null : <div style={{ marginLeft: "auto", ...styles.controls }}>{actions}</div>}
    </div>
  );
}

export interface PillProps {
  readonly tone?: Tone | undefined;
  readonly icon?: IconName | undefined;
  readonly children?: ReactNode | undefined;
  readonly title?: string | undefined;
}

/** A small label. The tone colours the border and the icon only; the text is always readable body text. */
export function Pill({ tone = "neutral", icon, children, title }: PillProps) {
  return (
    <span style={pillStyle(tone)} title={title}>
      {icon === undefined ? null : <Icon name={icon} size={12} color={tone === "neutral" || tone === "muted" ? color.mutedText : toneColor[tone]} />}
      {children}
    </span>
  );
}

export interface ButtonProps {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly icon?: IconName | undefined;
  /** While true the button is aria-disabled: it keeps focus and its handler is not called. */
  readonly disabled?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly type?: "button" | "submit" | undefined;
  readonly id?: string | undefined;
  /** Accessible name; required when the visible text alone does not name the agent and channel. */
  readonly label?: string | undefined;
  /** For a disclosure toggle: rendered as aria-expanded. */
  readonly expanded?: boolean | undefined;
  readonly children?: ReactNode | undefined;
}

/**
 * A button that uses `aria-disabled` and a guard instead of `disabled`: a disabled button drops focus to <body>, which
 * would lose the keyboard user's place while a request is on its way.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", icon, disabled = false, onClick, type = "button", id, label, expanded, children }, ref) {
  return (
    <button
      ref={ref}
      id={id}
      type={type}
      aria-label={label}
      aria-expanded={expanded}
      aria-disabled={disabled}
      style={buttonStyle(variant, disabled, size)}
      onClick={type === "submit" ? undefined : () => (disabled ? undefined : onClick?.())}
    >
      {icon === undefined ? null : <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
});

export function EmptyState({ icon = "ghost", title, hint }: { readonly icon?: IconName | undefined; readonly title: string; readonly hint?: ReactNode }) {
  return (
    <div style={styles.empty}>
      <Icon name={icon} size={24} color={color.mutedText} />
      <p style={styles.emptyTitle}>{title}</p>
      {hint === undefined ? null : <p style={styles.emptyHint}>{hint}</p>}
    </div>
  );
}

/** A grey placeholder block shown while the first state loads. Hidden from assistive technology; no animation. */
export function Skeleton({ height = "1rem", width = "100%" }: { readonly height?: string | undefined; readonly width?: string }) {
  return <div aria-hidden="true" style={{ ...styles.skeleton, height, width }} />;
}

export interface StatTileProps {
  readonly icon: IconName;
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: Tone | undefined;
}

/** One overview figure. A warn tone colours the border and icon; the value is still plain text. */
export function StatTile({ icon, label, value, tone = "neutral" }: StatTileProps) {
  const accent = tone === "neutral" || tone === "muted" ? null : toneColor[tone];
  return (
    <div style={{ ...styles.panel, ...styles.statTile, ...(accent === null ? {} : { borderColor: accent }) }}>
      <span style={styles.statLabel}>
        <Icon name={icon} color={accent ?? color.mutedText} />
        {label}
      </span>
      <p style={styles.statValue}>{value}</p>
    </div>
  );
}

export interface MeterProps {
  readonly value: number;
  readonly max: number;
  /** Read by assistive technology instead of the bare number, for example "1.50 of 10.00 credits used". */
  readonly valueText: string;
  readonly label: string;
}

/**
 * A thin progress bar with role="meter". `aria-valuenow` is clamped to [0, max] and the fill to the track, so used above
 * total shows a full bar; the value text still tells the real figures.
 */
export function Meter({ value, max, valueText, label }: MeterProps) {
  // A total of zero (or less, or not a number) has no scale: no division, an empty bar, and "n/a" for assistive technology.
  const scaled = Number.isFinite(max) && max > 0;
  const top = scaled ? max : 0;
  const now = scaled && Number.isFinite(value) ? Math.min(top, Math.max(0, value)) : 0;
  const ratio = scaled ? now / top : 0;
  return (
    <div role="meter" aria-label={label} aria-valuenow={now} aria-valuemin={0} aria-valuemax={top} aria-valuetext={scaled ? valueText : "n/a"} style={styles.meterTrack}>
      <div style={{ ...styles.meterFill, width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

/** Text only screen readers get, for example a "Topic: " prefix in front of the visible topic. */
export function SrOnly({ children }: { readonly children?: ReactNode }) {
  return <span style={styles.srOnly}>{children}</span>;
}
