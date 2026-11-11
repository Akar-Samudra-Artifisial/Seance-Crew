import { cleanText, formatTime } from "./format.js";
import { bannerStyle, type BannerLevel } from "./styles.js";
import type { BridgeState, PollStatus, State } from "./types.js";

interface BannerCopy {
  readonly level: BannerLevel;
  readonly icon: string;
  readonly label: string;
  readonly message: (bridge: State["bridge"]) => string;
}

const CHECK_SETTINGS = "Check host, nick and secret in the app settings.";

/** One message per bridge state. The label and icon carry the level, so colour is never the only signal. */
export const BANNER: Readonly<Record<BridgeState, BannerCopy>> = {
  registered: { level: "ok", icon: "●", label: "Connected", message: (b) => `Connected to ${cleanText(b.host)} as ${cleanText(b.nick)}.` },
  connecting: { level: "wait", icon: "◌", label: "Connecting", message: (b) => `Connecting to ${b.host === "" ? "the Séance server" : cleanText(b.host)}…` },
  reconnecting: { level: "wait", icon: "◌", label: "Reconnecting", message: () => "The connection to the Séance server was lost. Reconnecting…" },
  unconfigured: { level: "problem", icon: "▲", label: "Not configured", message: () => `The app is not configured yet. ${CHECK_SETTINGS}` },
  "auth-failed": { level: "problem", icon: "▲", label: "Sign-in failed", message: () => `The Séance server refused the account. ${CHECK_SETTINGS}` },
  "nick-rejected": { level: "problem", icon: "▲", label: "Nick rejected", message: () => `The Séance server rejected the nick. ${CHECK_SETTINGS}` },
  "config-invalid": { level: "problem", icon: "▲", label: "Settings invalid", message: () => `The app settings are not valid. ${CHECK_SETTINGS}` },
  "duplicate-instance": {
    level: "problem",
    icon: "▲",
    label: "Another copy is running",
    message: () => "Another copy of this app already holds the Séance connection, so this one stays disconnected.",
  },
};

/** For a state this page does not know (a newer backend): say what was reported instead of crashing. */
const UNKNOWN: BannerCopy = {
  level: "wait",
  icon: "?",
  label: "Unknown state",
  message: (b) => `The app reported a bridge state this page does not know: ${cleanText(String(b.state))}.`,
};

export function bannerFor(state: string): BannerCopy {
  return Object.hasOwn(BANNER, state) ? BANNER[state as BridgeState] : UNKNOWN;
}

export interface StatusBannerProps {
  /** Null until the first state arrives. */
  readonly bridge: State["bridge"] | null;
  readonly status: PollStatus | null;
}

export function StatusBanner({ bridge, status }: StatusBannerProps) {
  const copy = bridge === null ? null : bannerFor(bridge.state);
  const failed = status !== null && !status.ok ? status : null;
  return (
    <div>
      {bridge === null || copy === null ? (
        <p role="status" style={bannerStyle("wait")}>
          {failed !== null ? "Waiting for the app…" : "Loading…"}
        </p>
      ) : (
        <p role="status" data-level={copy.level} style={bannerStyle(copy.level)}>
          <span aria-hidden="true">{copy.icon} </span>
          <strong>{copy.label}.</strong> <span>{copy.message(bridge)}</span>
        </p>
      )}
      {failed !== null ? (
        <p role="alert" style={bannerStyle("problem")}>
          <span aria-hidden="true">▲ </span>
          <strong>Connection to the app lost.</strong>{" "}
          <span>{failed.lastSuccess === null ? "No successful update yet." : `Last update at ${formatTime(failed.lastSuccess)}.`} Trying again every 10 seconds.</span>
        </p>
      ) : null}
    </div>
  );
}
