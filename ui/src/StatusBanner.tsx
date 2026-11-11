import { cleanText, formatAgo, formatTime } from "./format.js";
import { Icon, type IconName } from "./Icon.js";
import { bannerStyle, color, styles, type BannerLevel } from "./styles.js";
import type { BridgeState, PollStatus, State } from "./types.js";
import { useNow } from "./useAging.js";

interface BannerCopy {
  readonly level: BannerLevel;
  readonly icon: IconName;
  readonly label: string;
  readonly message: (bridge: State["bridge"]) => string;
}

const CHECK_SETTINGS = "Check host, nick and secret in the app settings.";

/** One message per bridge state. The label and icon carry the level, so colour is never the only signal. */
export const BANNER: Readonly<Record<BridgeState, BannerCopy>> = {
  registered: { level: "ok", icon: "check-circle", label: "Connected", message: (b) => `${cleanText(b.host)} as ${cleanText(b.nick)}` },
  connecting: { level: "wait", icon: "circle-dashed", label: "Connecting", message: (b) => `Connecting to ${b.host === "" ? "the Séance server" : cleanText(b.host)}…` },
  reconnecting: { level: "wait", icon: "circle-dashed", label: "Reconnecting", message: () => "The connection to the Séance server was lost. Reconnecting…" },
  unconfigured: { level: "problem", icon: "alert-triangle", label: "Not configured", message: () => `The app is not configured yet. ${CHECK_SETTINGS}` },
  "auth-failed": { level: "problem", icon: "alert-triangle", label: "Sign-in failed", message: () => `The Séance server refused the account. ${CHECK_SETTINGS}` },
  "nick-rejected": { level: "problem", icon: "alert-triangle", label: "Nick rejected", message: () => `The Séance server rejected the nick. ${CHECK_SETTINGS}` },
  "config-invalid": { level: "problem", icon: "alert-triangle", label: "Settings invalid", message: () => `The app settings are not valid. ${CHECK_SETTINGS}` },
  "duplicate-instance": {
    level: "problem",
    icon: "alert-triangle",
    label: "Another copy is running",
    message: () => "Another copy of this app already holds the Séance connection, so this one stays disconnected.",
  },
};

/** For a state this page does not know (a newer backend): say what was reported instead of crashing. */
const UNKNOWN: BannerCopy = {
  level: "wait",
  icon: "circle-dashed",
  label: "Unknown state",
  message: (b) => `The app reported a bridge state this page does not know: ${cleanText(String(b.state))}.`,
};

export function bannerFor(state: string): BannerCopy {
  return Object.hasOwn(BANNER, state) ? BANNER[state as BridgeState] : UNKNOWN;
}

const LEVEL_COLOR: Readonly<Record<BannerLevel, string>> = { ok: color.ok, wait: color.warn, problem: color.danger };

export interface StatusBannerProps {
  /** Null until the first state arrives. */
  readonly bridge: State["bridge"] | null;
  readonly status: PollStatus | null;
  /** Local time in ms for "updated … ago" (defaults to now). */
  readonly now?: number;
}

/**
 * Connected: a slim status line (dot icon, "Connected", `host as nick`, "updated 5 s ago"). Any other state: the full
 * banner with the action text. A failed poll adds the "connection to the app lost" alert in both cases.
 */
export function StatusBanner({ bridge, status, now }: StatusBannerProps) {
  // The age text ticks every few seconds; it lives outside the role="status" element so it is not announced each time.
  const ticking = useNow();
  const current = now ?? ticking;
  const copy = bridge === null ? null : bannerFor(bridge.state);
  const failed = status !== null && !status.ok ? status : null;
  const updated = status?.lastSuccess ?? null;
  return (
    <div style={styles.bannerStack}>
      {bridge === null || copy === null ? (
        <p role="status" style={styles.statusBar}>
          <Icon name="circle-dashed" color={color.warn} />
          <span>{failed !== null ? "Waiting for the app…" : "Loading…"}</span>
        </p>
      ) : copy.level === "ok" ? (
        <div style={styles.statusText}>
          <p role="status" data-level={copy.level} style={styles.statusText}>
            <Icon name={copy.icon} color={LEVEL_COLOR[copy.level]} />
            <strong>{copy.label}</strong>
            <span style={styles.muted}>·</span>
            <span>{copy.message(bridge)}</span>
          </p>
          {updated === null || failed !== null ? null : (
            <span style={styles.muted}>
              · updated {formatAgo(Math.max(0, current - updated))}
            </span>
          )}
        </div>
      ) : (
        <p role="status" data-level={copy.level} style={bannerStyle(copy.level)}>
          <Icon name={copy.icon} color={LEVEL_COLOR[copy.level]} />
          <strong>{copy.label}.</strong> <span>{copy.message(bridge)}</span>
        </p>
      )}
      {failed !== null ? (
        <p role="alert" style={bannerStyle("problem")}>
          <Icon name="alert-triangle" color={color.danger} />
          <strong>Connection to the app lost.</strong>{" "}
          <span>{failed.lastSuccess === null ? "No successful update yet." : `Last update at ${formatTime(failed.lastSuccess)}.`} Trying again every 10 seconds.</span>
        </p>
      ) : null}
    </div>
  );
}
