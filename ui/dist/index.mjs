// ui/src/App.tsx
import { useAppApi as useAppApi2 } from "@kirocrew/app-sdk";
import { useCallback as useCallback2, useEffect as useEffect4, useRef as useRef4, useState as useState3 } from "react";

// ui/src/api.ts
var APP_NAME = "seance-crew";
var API_BASE = `/apps/${APP_NAME}/api`;
var ROUTES = {
  state: `${API_BASE}/state`,
  summary: `${API_BASE}/summary`,
  summon: `${API_BASE}/summon`,
  grantOp: `${API_BASE}/grant-op`,
  exorcise: `${API_BASE}/exorcise`,
  inboxDismiss: `${API_BASE}/inbox/dismiss`
};
var stateUrl = (since) => since === null ? ROUTES.state : `${ROUTES.state}?since=${since}`;

// ui/src/confirmFlow.ts
var initialConfirm = { phase: "idle" };
function confirmReducer(state, action) {
  switch (action.type) {
    case "open":
      return state.phase === "submitting" ? state : { phase: "confirming", request: action.request };
    case "cancel":
      return state.phase === "submitting" ? state : initialConfirm;
    case "confirm":
      return state.phase === "confirming" || state.phase === "failed" ? { phase: "submitting", request: state.request } : state;
    case "succeeded":
      return state.phase === "submitting" ? initialConfirm : state;
    case "failed":
      return state.phase === "submitting" ? { phase: "failed", request: state.request, message: action.message } : state;
  }
}
var MODE_EFFECT = {
  "+v": "+v lets the agent speak in the channel.",
  "-v": "-v takes away the agent's voice.",
  "+o": "+o lets the agent edit files and run commands in the channel worktree.",
  "-o": "-o takes away the agent's right to edit files and run commands."
};
function confirmCopy(request) {
  switch (request.kind) {
    case "grant":
    case "mode":
      return {
        title: request.mode.startsWith("-") ? `Revoke ${request.mode} from ${request.agent} in ${request.channel}?` : `Grant ${request.mode} to ${request.agent} in ${request.channel}?`,
        body: MODE_EFFECT[request.mode],
        confirmLabel: `Apply ${request.mode} to ${request.agent} in ${request.channel}`,
        destructive: request.mode.startsWith("-")
      };
    case "exorcise":
      return {
        title: `Exorcise ${request.agent} from ${request.channel}?`,
        body: "The agent stops and uncommitted work in the worktree is reverted.",
        confirmLabel: `Exorcise ${request.agent} from ${request.channel}`,
        destructive: true
      };
  }
}
function nextFocusIndex(count, index, backwards) {
  if (count <= 0) return -1;
  if (index < 0) return backwards ? count - 1 : 0;
  return backwards ? (index - 1 + count) % count : (index + 1) % count;
}

// ui/src/actions.ts
var isRecord = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
function errorMessage(err) {
  if (!(err instanceof Error) || err.message === "") return "The request failed.";
  const match = /^API (\d{3}):\s*([\s\S]*)$/.exec(err.message);
  if (match === null) return err.message;
  const status = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  try {
    const parsed = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed["error"]) && typeof parsed["error"]["message"] === "string" && parsed["error"]["message"] !== "") {
      return parsed["error"]["message"];
    }
  } catch {
  }
  if (body === "" || body.startsWith("<") || body.length > 200) return `The request failed (HTTP ${status}).`;
  return `${body} (HTTP ${status})`;
}
function callFor(request) {
  switch (request.kind) {
    case "grant":
      return {
        path: ROUTES.grantOp,
        body: { channel: request.channel, agent: request.agent, mode: request.mode, confirm: true, ...request.inboxId === void 0 ? {} : { inboxId: request.inboxId } }
      };
    case "mode":
      return { path: ROUTES.grantOp, body: { channel: request.channel, agent: request.agent, mode: request.mode, confirm: true } };
    case "exorcise":
      return { path: ROUTES.exorcise, body: { channel: request.channel, agent: request.agent, confirm: true } };
  }
}
function successMessage(request, result) {
  if (request.kind === "exorcise") {
    const closed = isRecord(result) && result["closed"] === true;
    return `Exorcised ${request.agent} from ${request.channel}.${closed ? " The session is closed." : " The server did not report the session as closed yet."}`;
  }
  return `Applied ${request.mode} to ${request.agent} in ${request.channel}.`;
}
function createConfirmController(deps) {
  let current = initialConfirm;
  const dispatch = (action) => {
    const next = confirmReducer(current, action);
    if (next === current) return;
    current = next;
    deps.onState(current);
  };
  return {
    state: () => current,
    open: (request) => dispatch({ type: "open", request }),
    cancel: () => dispatch({ type: "cancel" }),
    async confirm() {
      if (current.phase !== "confirming" && current.phase !== "failed") return;
      const request = current.request;
      dispatch({ type: "confirm" });
      const { path, body } = callFor(request);
      try {
        const result = await deps.api.post(path, body);
        dispatch({ type: "succeeded" });
        deps.onSuccess(successMessage(request, result), request);
        deps.refresh();
      } catch (err) {
        dispatch({ type: "failed", message: errorMessage(err) });
      }
    }
  };
}
function channelError(raw) {
  const channel = raw.trim();
  if (channel === "") return "Enter a channel name.";
  if (!channel.startsWith("#") || channel.length < 2) return "A channel name must start with # (for example #fix-bug).";
  return null;
}
async function submitSummon(api, rawChannel, rawAgent) {
  const problem = channelError(rawChannel);
  if (problem !== null) return { ok: false, message: problem };
  const channel = rawChannel.trim();
  const agent = rawAgent.trim() === "" ? "coder" : rawAgent.trim();
  try {
    const result = await api.post(ROUTES.summon, { channel, ...agent === "coder" ? {} : { agent } });
    const ready = isRecord(result) && result["ready"] === true;
    return {
      ok: true,
      ready,
      message: ready ? `${agent} is ready in ${channel}.` : `${agent} is still starting in ${channel} and will appear when ready.`
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
async function submitDismiss(api, id) {
  try {
    await api.post(ROUTES.inboxDismiss, { id });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

// ui/src/Dashboard.tsx
import { PageHeader } from "@kirocrew/app-sdk/ui";

// ui/src/focus.ts
var CHANNELS_HEADING_ID = "channels-heading";
var enc = (s) => encodeURIComponent(s);
var controlId = (channel, agent, mode) => `ctl-${enc(channel)}-${enc(agent)}-${enc(mode)}`;
var agentRowId = (channel, agent) => `agent-${enc(channel)}-${enc(agent)}`;
var channelHeadingId = (channel) => `channel-${enc(channel)}`;
var inboxGrantId = (inboxId, channel) => `grant-${enc(inboxId)}-${enc(channel)}`;
function triggerIdFor(request) {
  if (request.kind === "exorcise") return controlId(request.channel, request.agent, "x");
  if (request.kind === "grant" && request.inboxId !== void 0) return inboxGrantId(request.inboxId, request.channel);
  return controlId(request.channel, request.agent, request.mode);
}
function focusEscaped(dialog, target) {
  return dialog !== null && target !== null && target !== void 0 && !dialog.contains(target);
}
function returnFocusTarget(trigger, opener, usable) {
  if (trigger !== null && usable(trigger)) return trigger;
  if (opener !== null && usable(opener)) return opener;
  return null;
}
var INVERSE = { "+v": "-v", "-v": "+v", "+o": "-o", "-o": "+o" };
function focusCandidates(request) {
  if (request.kind === "exorcise") return [controlId(request.channel, request.agent, "x"), channelHeadingId(request.channel), CHANNELS_HEADING_ID];
  return [controlId(request.channel, request.agent, INVERSE[request.mode]), agentRowId(request.channel, request.agent), channelHeadingId(request.channel), CHANNELS_HEADING_ID];
}
function applyFocus(doc, ids) {
  if (doc.activeElement !== null && doc.activeElement !== void 0 && doc.activeElement !== doc.body) return null;
  for (const id of ids) {
    const el = doc.getElementById(id);
    if (el !== null) {
      el.focus();
      return id;
    }
  }
  return null;
}

// ui/src/format.ts
var UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
function cleanText(text) {
  return text.replace(UNSAFE_TEXT, "");
}
function formatCredits(value) {
  return value === null || value === void 0 || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
}
function formatUsage(used, total) {
  if (used === null) return "n/a";
  return total === null ? formatCredits(used) : `${formatCredits(used)} of ${formatCredits(total)}`;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function isoTime(ts) {
  return new Date(ts).toISOString();
}
function formatAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1e3));
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86400)} d`;
}
function formatAgo(ms) {
  return `${formatAge(ms)} ago`;
}
function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function formatDateTime(ts) {
  return new Date(ts).toLocaleString();
}
function modeLabel(modes) {
  const hasO = modes.includes("o");
  const hasV = modes.includes("v");
  if (hasO && hasV) return { icon: "shield-check", text: "+o +v operator, voice", tone: "accent" };
  if (hasO) return { icon: "shield-check", text: "+o operator", tone: "accent" };
  if (hasV) return { icon: "shield", text: "+v voice", tone: "neutral" };
  return { icon: "minus", text: "no modes", tone: "muted" };
}
function modeChangesFor(modes) {
  if (modes.includes("o")) return ["-o"];
  if (modes.includes("v")) return ["+o", "-v"];
  return ["+v", "+o"];
}

// ui/src/styles.ts
var HOST_THEME = {
  bg: "#12141a",
  "bg-hover": "#262a35",
  card: "#181b22",
  "card-fg": "#f4f4f5",
  muted: "#909098",
  border: "#27272a",
  accent: "#00d492",
  "accent-fg": "#000000",
  danger: "#ef4444"
};
var v = (name) => `var(--${name}, ${HOST_THEME[name]})`;
var color = {
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
  warn: "#f59e0b"
};
var space = { xs: "0.25rem", icon: "0.375rem", sm: "0.5rem", md: "0.75rem", lg: "1rem", xl: "1.5rem", xxl: "2rem" };
var radius = { control: "0.375rem", button: "0.5rem", panel: "0.75rem", pill: "999px" };
var fontSize = { label: "0.75rem", code: "0.8125rem", small: "0.875rem", title: "1rem", stat: "1.5rem" };
var fontWeight = { regular: 400, medium: 500, bold: 600 };
var MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
var tabular = { fontVariantNumeric: "tabular-nums" };
var toneColor = {
  neutral: color.border,
  accent: color.accent,
  warn: color.warn,
  danger: color.danger,
  muted: color.border
};
var SCOPE_ATTR = "data-seance";
var FOCUS_CSS = `[${SCOPE_ATTR}] :is(button,a,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid ${color.accent};outline-offset:2px}`;
var buttonBase = {
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
  whiteSpace: "nowrap"
};
var buttonVariants = {
  secondary: {},
  primary: { background: color.accent, color: color.accentFg, borderColor: color.accent },
  // Black on the host red: 5.6:1. White would only reach 3.8:1.
  danger: { background: color.danger, color: color.accentFg, borderColor: color.danger },
  // Card-coloured text on the card itself.
  ghost: { background: "transparent", borderColor: "transparent" }
};
var buttonSizes = {
  md: { padding: `${space.icon} 0.875rem` },
  sm: { padding: `${space.xs} 0.625rem` }
};
var styles = {
  page: { padding: `0 ${space.xl} ${space.xxl}`, display: "flex", flexDirection: "column", gap: space.lg, color: color.cardFg },
  heading: { fontSize: fontSize.title, fontWeight: fontWeight.bold, margin: 0 },
  subheading: { fontSize: fontSize.label, fontWeight: fontWeight.bold, textTransform: "uppercase", letterSpacing: "0.04em", color: color.mutedText, margin: `${space.sm} 0 ${space.xs}` },
  cardHeading: { fontSize: fontSize.title, fontWeight: fontWeight.bold, margin: 0, minWidth: 0, overflowWrap: "anywhere" },
  text: { margin: `${space.xs} 0` },
  hint: { margin: `${space.xs} 0`, color: color.mutedText, fontSize: fontSize.small },
  label: { fontWeight: fontWeight.bold, fontSize: fontSize.small },
  muted: { color: color.mutedText },
  mono: { fontFamily: MONO },
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: space.sm },
  plainList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: space.xs },
  row: { display: "flex", flexWrap: "wrap", gap: space.sm, alignItems: "center", padding: `${space.sm} ${space.md}`, border: `1px solid ${color.border}`, borderRadius: radius.control },
  cardBody: { display: "flex", flexDirection: "column", gap: space.md },
  controls: { display: "inline-flex", flexWrap: "wrap", gap: space.sm },
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
    whiteSpace: "nowrap"
  },
  panel: { background: color.card, color: color.cardFg, border: `1px solid ${color.border}`, borderRadius: radius.panel, padding: space.lg, minWidth: 0, display: "flex", flexDirection: "column", gap: space.md },
  sectionHeader: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  // Two groups of three tiles. Side by side when the row is wide (6 in one row); stacked when narrow (3 + 3). Inside a
  // group the tiles fit as many as the width allows (3, then 2, then 1).
  statGrid: { display: "flex", flexWrap: "wrap", gap: space.md },
  statGroup: { flex: "1 1 23rem", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 7rem), 1fr))", gap: space.md },
  statTile: { gap: space.xs, padding: `${space.md} ${space.lg}` },
  statusText: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, margin: 0 },
  inboxItem: { display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, border: `1px solid ${color.border}`, borderRadius: radius.control },
  inboxHead: { display: "flex", gap: space.sm, alignItems: "flex-start" },
  stack: { display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 },
  wrapRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm },
  smallRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.icon, fontSize: fontSize.label },
  commitRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, fontSize: fontSize.small },
  summarySpread: { display: "flex", alignItems: "center", gap: space.icon },
  logSummary: { cursor: "pointer", display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.small, fontWeight: fontWeight.bold },
  form: { display: "flex", flexDirection: "column", gap: space.md },
  bannerStack: { display: "flex", flexDirection: "column", gap: space.sm },
  monoMuted: { fontFamily: MONO, color: color.mutedText, fontSize: fontSize.code, overflowWrap: "anywhere" },
  controlsEnd: { display: "inline-flex", flexWrap: "wrap", gap: space.sm, justifyContent: "flex-end" },
  statLabel: { display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.label, textTransform: "uppercase", letterSpacing: "0.04em", color: color.mutedText },
  statValue: { fontSize: fontSize.stat, fontWeight: fontWeight.bold, ...tabular, margin: 0 },
  columns: { display: "flex", flexWrap: "wrap", gap: space.lg, alignItems: "flex-start" },
  mainColumn: { flex: "999 1 34rem", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg },
  aside: { flex: "1 1 20rem", minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg },
  statusBar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm, fontSize: fontSize.small, margin: 0 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: space.xs, padding: `${space.lg} ${space.sm}`, color: color.cardFg },
  emptyTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, margin: 0 },
  emptyHint: { fontSize: fontSize.small, color: color.mutedText, margin: 0 },
  skeleton: { background: color.surface, borderRadius: radius.control },
  meterTrack: { height: space.icon, borderRadius: radius.pill, background: color.surface, overflow: "hidden" },
  meterFill: { height: "100%", borderRadius: radius.pill, background: color.accent },
  agentRow: {
    display: "grid",
    gridTemplateColumns: "minmax(8rem, 1fr) auto auto 1fr",
    alignItems: "center",
    gap: space.sm,
    padding: `${space.sm} ${space.md}`,
    border: `1px solid ${color.border}`,
    borderRadius: radius.control
  },
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
    listStyle: "none"
  },
  logLine: { display: "grid", gridTemplateColumns: "auto 1fr", gap: space.sm, margin: 0, whiteSpace: "pre-wrap" },
  logTime: { color: color.mutedText, fontSize: fontSize.label, ...tabular },
  logMeta: { color: color.mutedText, fontStyle: "italic" },
  untrusted: { display: "flex", alignItems: "center", gap: space.xs, margin: `${space.xs} 0`, fontSize: fontSize.code, fontWeight: fontWeight.bold, color: color.cardFg },
  field: { display: "flex", flexDirection: "column", gap: space.xs, flex: "1 1 10rem", minWidth: 0 },
  fieldRow: { display: "flex", flexWrap: "wrap", gap: space.md },
  input: { font: "inherit", fontSize: fontSize.small, padding: `${space.icon} ${space.sm}`, borderRadius: radius.control, border: `1px solid ${color.border}`, background: color.card, color: color.cardFg, width: "100%", boxSizing: "border-box" },
  summaryRow: { display: "flex", justifyContent: "space-between", gap: space.sm, fontSize: fontSize.small },
  number: { ...tabular, textAlign: "right" },
  overlay: { position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.5)" },
  dialog: { background: color.card, color: color.cardFg, maxWidth: "28rem", width: "90%", padding: space.xl, borderRadius: radius.panel, border: `1px solid ${color.border}` },
  dialogActions: { display: "flex", gap: space.sm, justifyContent: "flex-end" },
  srOnly: { position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }
};
function bannerStyle(level) {
  const tone = level === "ok" ? color.ok : level === "wait" ? color.warn : color.danger;
  return { margin: 0, padding: `${space.sm} ${space.md}`, borderRadius: radius.control, border: `1px solid ${tone}`, borderLeft: `${space.icon} solid ${tone}`, background: color.surface, color: color.cardFg, display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" };
}
function buttonStyle(variant, disabled = false, size = "md") {
  const base = { ...buttonBase, ...buttonVariants[variant], ...buttonSizes[size] };
  return disabled ? { ...base, opacity: 0.6, cursor: "not-allowed" } : base;
}
function pillStyle(tone) {
  return tone === "muted" ? { ...styles.badge, borderStyle: "dashed" } : { ...styles.badge, borderColor: toneColor[tone] };
}

// ui/src/ui.tsx
import { forwardRef } from "react";

// ui/src/Icon.tsx
import { jsx } from "react/jsx-runtime";
var circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
var SHIELD = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";
var ICONS = {
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
  bot: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9, 7, 4), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  coins: [circle(8, 8, 6), "M18.09 10.37A6 6 0 1 1 10.34 18", "M7 6h1v4", "m16.71 13.88.7.71-2.82 2.82"],
  shield: [SHIELD],
  "shield-check": [SHIELD, "m9 12 2 2 4-4"],
  "git-commit": [circle(12, 12, 3), "M3 12h6", "M15 12h6"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  wand: ["M15 4V2", "M15 16v-2", "M8 9h2", "M20 9h2", "M17.8 11.8 19 13", "M15 9h.01", "M17.8 6.2 19 5", "m3 21 9-9", "M12.2 6.2 11 5"],
  "check-circle": [circle(12, 12, 10), "m9 12 2 2 4-4"],
  "circle-dashed": [
    "M10.1 2.182a10 10 0 0 1 3.8 0",
    "M13.9 21.818a10 10 0 0 1-3.8 0",
    "M17.609 3.721a10 10 0 0 1 2.69 2.7",
    "M2.182 13.9a10 10 0 0 1 0-3.8",
    "M20.279 17.609a10 10 0 0 1-2.7 2.69",
    "M21.818 10.1a10 10 0 0 1 0 3.8",
    "M3.721 6.391a10 10 0 0 1 2.7-2.69",
    "M6.391 20.279a10 10 0 0 1-2.69-2.7"
  ],
  "alert-triangle": ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  plus: ["M5 12h14", "M12 5v14"],
  minus: ["M5 12h14"],
  clock: [circle(12, 12, 10), "M12 6v6l4 2"],
  ghost: ["M9 10h.01", "M15 10h.01", "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"]
};
var ICON_NAMES = Object.keys(ICONS);
function Icon({ name, size = 16, color: color2 }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color2 ?? "currentColor",
      strokeWidth: 1.75,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      style: { flexShrink: 0 },
      children: ICONS[name].map((d) => /* @__PURE__ */ jsx("path", { d }, d))
    }
  );
}

// ui/src/ui.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function Panel({ children, labelledBy, label, style }) {
  return /* @__PURE__ */ jsx2("section", { "aria-labelledby": labelledBy, "aria-label": label, style: style === void 0 ? styles.panel : { ...styles.panel, ...style }, children });
}
function SectionHeader({ icon, title, count, actions, level = 2, id, focusable = false }) {
  const Heading = level === 2 ? "h2" : "h3";
  return /* @__PURE__ */ jsxs("div", { style: styles.sectionHeader, children: [
    icon === void 0 ? null : /* @__PURE__ */ jsx2(Icon, { name: icon, color: color.mutedText }),
    /* @__PURE__ */ jsx2(Heading, { id, tabIndex: focusable ? -1 : void 0, style: styles.heading, children: title }),
    count === void 0 ? null : /* @__PURE__ */ jsx2(Pill, { tone: "neutral", children: count }),
    actions === void 0 ? null : /* @__PURE__ */ jsx2("div", { style: { marginLeft: "auto", ...styles.controls }, children: actions })
  ] });
}
function Pill({ tone = "neutral", icon, children, title }) {
  return /* @__PURE__ */ jsxs("span", { style: pillStyle(tone), title, children: [
    icon === void 0 ? null : /* @__PURE__ */ jsx2(Icon, { name: icon, size: 12, color: tone === "neutral" || tone === "muted" ? color.mutedText : toneColor[tone] }),
    children
  ] });
}
var Button = forwardRef(function Button2({ variant = "secondary", size = "md", icon, disabled = false, onClick, type = "button", id, label, expanded, children }, ref) {
  return /* @__PURE__ */ jsxs(
    "button",
    {
      ref,
      id,
      type,
      "aria-label": label,
      "aria-expanded": expanded,
      "aria-disabled": disabled,
      style: buttonStyle(variant, disabled, size),
      onClick: type === "submit" ? void 0 : () => disabled ? void 0 : onClick?.(),
      children: [
        icon === void 0 ? null : /* @__PURE__ */ jsx2(Icon, { name: icon, size: size === "sm" ? 14 : 16 }),
        children
      ]
    }
  );
});
function EmptyState({ icon = "ghost", title, hint }) {
  return /* @__PURE__ */ jsxs("div", { style: styles.empty, children: [
    /* @__PURE__ */ jsx2(Icon, { name: icon, size: 24, color: color.mutedText }),
    /* @__PURE__ */ jsx2("p", { style: styles.emptyTitle, children: title }),
    hint === void 0 ? null : /* @__PURE__ */ jsx2("p", { style: styles.emptyHint, children: hint })
  ] });
}
function Skeleton({ height = "1rem", width = "100%" }) {
  return /* @__PURE__ */ jsx2("div", { "aria-hidden": "true", style: { ...styles.skeleton, height, width } });
}
function StatTile({ icon, label, value, tone = "neutral" }) {
  const accent = tone === "neutral" || tone === "muted" ? null : toneColor[tone];
  return /* @__PURE__ */ jsxs("div", { style: { ...styles.panel, ...styles.statTile, ...accent === null ? {} : { borderColor: accent } }, children: [
    /* @__PURE__ */ jsxs("span", { style: styles.statLabel, children: [
      /* @__PURE__ */ jsx2(Icon, { name: icon, color: accent ?? color.mutedText }),
      label
    ] }),
    /* @__PURE__ */ jsx2("p", { style: styles.statValue, children: value })
  ] });
}
function Meter({ value, max, valueText, label }) {
  const scaled = Number.isFinite(max) && max > 0;
  const top = scaled ? max : 0;
  const now = scaled && Number.isFinite(value) ? Math.min(top, Math.max(0, value)) : 0;
  const ratio = scaled ? now / top : 0;
  return /* @__PURE__ */ jsx2("div", { role: "meter", "aria-label": label, "aria-valuenow": now, "aria-valuemin": 0, "aria-valuemax": top, "aria-valuetext": scaled ? valueText : "n/a", style: styles.meterTrack, children: /* @__PURE__ */ jsx2("div", { style: { ...styles.meterFill, width: `${(ratio * 100).toFixed(1)}%` } }) });
}
function SrOnly({ children }) {
  return /* @__PURE__ */ jsx2("span", { style: styles.srOnly, children });
}

// ui/src/AgentControls.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var verb = (mode) => mode.startsWith("-") ? "Revoke" : "Give";
var preposition = (mode) => mode.startsWith("-") ? "from" : "to";
function AgentControls({ agent, channel, onMode, onExorcise, busy = false }) {
  const nick = cleanText(agent.nick);
  const where = cleanText(channel);
  return /* @__PURE__ */ jsxs2("span", { style: styles.controls, children: [
    modeChangesFor(agent.modes).map((mode) => /* @__PURE__ */ jsxs2(
      Button,
      {
        id: controlId(channel, agent.nick, mode),
        size: "sm",
        icon: mode.startsWith("-") ? "minus" : "plus",
        disabled: busy,
        onClick: () => busy ? void 0 : onMode(agent, channel, mode),
        label: `${verb(mode)} ${mode} ${preposition(mode)} ${nick} in ${where}`,
        children: [
          verb(mode),
          " ",
          mode
        ]
      },
      mode
    )),
    /* @__PURE__ */ jsx3(
      Button,
      {
        id: controlId(channel, agent.nick, "x"),
        variant: "danger",
        size: "sm",
        icon: "x",
        disabled: busy,
        onClick: () => busy ? void 0 : onExorcise(agent, channel),
        label: `Exorcise ${nick} from ${where}`,
        children: "Exorcise"
      }
    )
  ] });
}

// ui/src/AgentRow.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function AgentRow({ agent, children, id }) {
  const mode = modeLabel(agent.modes);
  const model = cleanText(agent.model);
  return /* @__PURE__ */ jsxs3("li", { id, tabIndex: id === void 0 ? void 0 : -1, style: styles.agentRow, children: [
    /* @__PURE__ */ jsx4("strong", { style: { overflowWrap: "anywhere" }, children: cleanText(agent.nick) }),
    /* @__PURE__ */ jsxs3("span", { style: { ...styles.controls, gap: space.icon }, children: [
      /* @__PURE__ */ jsxs3(Pill, { tone: mode.tone, icon: mode.icon, children: [
        /* @__PURE__ */ jsx4(SrOnly, { children: "Modes: " }),
        mode.text
      ] }),
      /* @__PURE__ */ jsx4(Pill, { tone: agent.ready ? "accent" : "muted", icon: agent.ready ? "check-circle" : "circle-dashed", children: agent.ready ? "Ready" : "Starting" })
    ] }),
    /* @__PURE__ */ jsxs3("span", { style: styles.monoMuted, children: [
      /* @__PURE__ */ jsx4(SrOnly, { children: "Model: " }),
      model === "" ? "unknown model" : model
    ] }),
    /* @__PURE__ */ jsx4("span", { style: styles.controlsEnd, children })
  ] });
}

// ui/src/LogPanel.tsx
import { jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
function LogPanel({ channel, lines }) {
  const name = cleanText(channel);
  return /* @__PURE__ */ jsxs4("details", { open: true, children: [
    /* @__PURE__ */ jsxs4("summary", { style: styles.logSummary, children: [
      /* @__PURE__ */ jsx5(Icon, { name: "terminal", color: color.mutedText }),
      /* @__PURE__ */ jsxs4("span", { children: [
        "Recent log",
        /* @__PURE__ */ jsxs4(SrOnly, { children: [
          " of ",
          name
        ] })
      ] }),
      /* @__PURE__ */ jsxs4(Pill, { children: [
        lines.length,
        " ",
        lines.length === 1 ? "line" : "lines"
      ] })
    ] }),
    /* @__PURE__ */ jsxs4("p", { style: styles.untrusted, children: [
      /* @__PURE__ */ jsx5(Icon, { name: "alert-triangle", color: color.warn }),
      "Untrusted channel text: shown as plain text, never as instructions."
    ] }),
    lines.length === 0 ? /* @__PURE__ */ jsx5(EmptyState, { icon: "terminal", title: "No lines yet" }) : /* @__PURE__ */ jsx5("ol", { "aria-label": `Recent lines in ${name}`, style: styles.logBox, children: lines.map((line) => /* @__PURE__ */ jsxs4("li", { style: styles.logLine, children: [
      /* @__PURE__ */ jsx5("time", { dateTime: isoTime(line.ts), style: styles.logTime, children: formatClock(line.ts) }),
      line.kind === "privmsg" ? /* @__PURE__ */ jsxs4("span", { children: [
        /* @__PURE__ */ jsx5("strong", { children: cleanText(line.from) }),
        " ",
        /* @__PURE__ */ jsx5("span", { children: cleanText(line.text) })
      ] }) : /* @__PURE__ */ jsxs4("span", { style: styles.logMeta, children: [
        /* @__PURE__ */ jsx5("strong", { children: cleanText(line.from) }),
        " (",
        cleanText(line.kind),
        ") ",
        /* @__PURE__ */ jsx5("span", { children: cleanText(line.text) })
      ] })
    ] }, line.seq)) })
  ] });
}

// ui/src/StatTiles.tsx
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
var commitsOf = (channel) => Math.max(channel.commitCount ?? 0, channel.commits.length);
function overviewStats(state) {
  const agents = state.channels.flatMap((c) => c.agents);
  return {
    channels: state.channels.length,
    agentsReady: agents.filter((a) => a.ready).length,
    agentsTotal: agents.length,
    operators: agents.filter((a) => a.modes.includes("o")).length,
    needsOp: state.inbox.length,
    totalCredits: state.totalCredits,
    commits: state.channels.reduce((sum, c) => sum + commitsOf(c), 0)
  };
}
var TILE_COUNT = 6;
function StatTiles({ state }) {
  if (state === null) {
    return /* @__PURE__ */ jsx6("section", { "aria-label": "Overview", style: styles.statGrid, children: [0, 1].map((group) => /* @__PURE__ */ jsx6("div", { style: styles.statGroup, children: Array.from({ length: TILE_COUNT / 2 }, (_, i) => /* @__PURE__ */ jsx6(Skeleton, { height: "4.5rem" }, i)) }, group)) });
  }
  const o = overviewStats(state);
  return /* @__PURE__ */ jsxs5("section", { "aria-label": "Overview", style: styles.statGrid, children: [
    /* @__PURE__ */ jsxs5("div", { style: styles.statGroup, children: [
      /* @__PURE__ */ jsx6(StatTile, { icon: "hash", label: "Channels", value: o.channels }),
      /* @__PURE__ */ jsx6(StatTile, { icon: "bot", label: "Agents ready", value: `${o.agentsReady} / ${o.agentsTotal}` }),
      /* @__PURE__ */ jsx6(StatTile, { icon: "shield-check", label: "Operators", value: o.operators })
    ] }),
    /* @__PURE__ */ jsxs5("div", { style: styles.statGroup, children: [
      /* @__PURE__ */ jsx6(StatTile, { icon: "shield", label: "Needs op", value: o.needsOp, tone: o.needsOp > 0 ? "warn" : "neutral" }),
      /* @__PURE__ */ jsx6(StatTile, { icon: "coins", label: "Total credits", value: formatCredits(o.totalCredits) }),
      /* @__PURE__ */ jsx6(StatTile, { icon: "git-commit", label: "Commits", value: o.commits })
    ] })
  ] });
}

// ui/src/ChannelCard.tsx
import { Fragment, jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
var COMMITS_SHOWN = 5;
function lastActivity(channel, now) {
  if (channel.lines.length === 0) return null;
  return Math.max(0, now - Math.max(...channel.lines.map((l) => l.ts)));
}
var plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function CreditsRow({ used, total }) {
  const text = formatUsage(used, total);
  return /* @__PURE__ */ jsxs6("div", { style: { ...styles.stack, gap: space.icon }, children: [
    /* @__PURE__ */ jsxs6("div", { style: styles.summaryRow, children: [
      /* @__PURE__ */ jsxs6("span", { style: { ...styles.muted, ...styles.summarySpread }, children: [
        /* @__PURE__ */ jsx7(Icon, { name: "coins" }),
        "Credits used"
      ] }),
      /* @__PURE__ */ jsx7("span", { style: styles.number, children: text })
    ] }),
    used === null || total === null ? null : /* @__PURE__ */ jsx7(Meter, { value: used, max: total, label: "Credits used", valueText: `${text} credits used` })
  ] });
}
function CommitList({ commits, total, now, channel }) {
  const shown = [...commits].reverse().slice(0, COMMITS_SHOWN);
  if (commits.length === 0) return /* @__PURE__ */ jsx7(EmptyState, { icon: "git-commit", title: "No commits yet" });
  return /* @__PURE__ */ jsxs6(Fragment, { children: [
    /* @__PURE__ */ jsx7("ul", { "aria-label": `Latest commits in ${channel}`, style: styles.plainList, children: shown.map((commit, index) => /* @__PURE__ */ jsxs6("li", { style: styles.commitRow, children: [
      /* @__PURE__ */ jsx7(Icon, { name: "git-commit", color: color.mutedText }),
      /* @__PURE__ */ jsx7("span", { style: { ...styles.badge, ...styles.mono }, children: cleanText(commit.sha) }),
      /* @__PURE__ */ jsx7("span", { children: cleanText(commit.agent) }),
      /* @__PURE__ */ jsx7("span", { style: styles.muted, children: plural(commit.files, "file", "files") }),
      /* @__PURE__ */ jsx7("time", { dateTime: isoTime(commit.ts), title: formatDateTime(commit.ts), style: { ...styles.muted, marginLeft: "auto" }, children: formatAgo(now - commit.ts) })
    ] }, `${commit.sha}-${commit.ts}-${index}`)) }),
    total > shown.length ? /* @__PURE__ */ jsxs6("p", { style: { ...styles.hint, margin: 0 }, children: [
      "Showing the newest ",
      shown.length,
      " of ",
      total,
      " commits."
    ] }) : null
  ] });
}
function ChannelCard({ channel, agentControls, now }) {
  const name = cleanText(channel.name);
  const topic = cleanText(channel.topic);
  const at = now ?? Math.max(0, ...channel.lines.map((l) => l.ts), ...channel.commits.map((c) => c.ts));
  const idle = lastActivity(channel, at);
  const headingId = channelHeadingId(channel.name);
  return /* @__PURE__ */ jsxs6(Panel, { labelledBy: headingId, children: [
    /* @__PURE__ */ jsxs6("div", { style: styles.stack, children: [
      /* @__PURE__ */ jsxs6("div", { style: styles.wrapRow, children: [
        /* @__PURE__ */ jsx7(Icon, { name: "hash", color: color.mutedText }),
        /* @__PURE__ */ jsx7("h3", { id: headingId, tabIndex: -1, style: styles.cardHeading, children: name }),
        /* @__PURE__ */ jsx7(Pill, { icon: "users", children: plural(channel.count, "member", "members") }),
        /* @__PURE__ */ jsx7(Pill, { icon: "bot", children: plural(channel.agents.length, "agent", "agents") }),
        idle === null ? null : /* @__PURE__ */ jsxs6(Pill, { icon: "clock", children: [
          "active ",
          formatAgo(idle)
        ] })
      ] }),
      topic === "" ? null : /* @__PURE__ */ jsxs6("p", { title: topic, style: { ...styles.hint, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: [
        /* @__PURE__ */ jsx7(SrOnly, { children: "Topic: " }),
        topic
      ] })
    ] }),
    /* @__PURE__ */ jsx7(CreditsRow, { used: channel.credits.used, total: channel.credits.total }),
    /* @__PURE__ */ jsxs6("div", { children: [
      /* @__PURE__ */ jsx7("h4", { style: styles.subheading, children: "Agents" }),
      channel.agents.length === 0 ? /* @__PURE__ */ jsx7(EmptyState, { icon: "bot", title: "No agents in this channel", hint: "Summon one with the form on this page." }) : /* @__PURE__ */ jsx7("ul", { "aria-label": `Agents in ${name}`, style: styles.list, children: channel.agents.map((agent) => /* @__PURE__ */ jsx7(AgentRow, { agent, id: agentRowId(channel.name, agent.nick), children: agentControls?.(agent, channel) }, agent.nick)) })
    ] }),
    /* @__PURE__ */ jsxs6("div", { children: [
      /* @__PURE__ */ jsx7("h4", { style: styles.subheading, children: "Latest commits" }),
      /* @__PURE__ */ jsx7(CommitList, { commits: channel.commits, total: commitsOf(channel), now: at, channel: name })
    ] }),
    /* @__PURE__ */ jsx7(LogPanel, { channel: channel.name, lines: channel.lines })
  ] });
}

// ui/src/ConfirmDialog.tsx
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
var FOCUS_FALLBACK_ID = CHANNELS_HEADING_ID;
var isUsableControl = (el) => el.isConnected && el.matches(FOCUSABLE) && el.tabIndex >= 0;
var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function ConfirmDialog({ title, body, confirmLabel, busy, error, onConfirm, onCancel, triggerId, destructive = true }) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const triggerIdRef = useRef(triggerId);
  triggerIdRef.current = triggerId;
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    cancelRef.current?.focus();
    const reclaim = (event) => {
      if (focusEscaped(dialogRef.current, event.target)) cancelRef.current?.focus();
    };
    document.addEventListener("focusin", reclaim, true);
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => {
      if (focusEscaped(dialogRef.current, document.activeElement)) cancelRef.current?.focus();
    }) : null;
    return () => {
      document.removeEventListener("focusin", reclaim, true);
      if (frame !== null) cancelAnimationFrame(frame);
      const id = triggerIdRef.current;
      const trigger = id === void 0 ? null : document.getElementById(id);
      const target = returnFocusTarget(trigger, opener, isUsableControl);
      (target ?? document.getElementById(FOCUS_FALLBACK_ID))?.focus();
    };
  }, []);
  useEffect(() => {
    if (error) cancelRef.current?.focus();
  }, [error]);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...dialogRef.current?.querySelectorAll(FOCUSABLE) ?? []];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const current = items.indexOf(document.activeElement);
    const next = nextFocusIndex(items.length, current, event.shiftKey);
    const atEdge = current === -1 || event.shiftKey && current === 0 || !event.shiftKey && current === items.length - 1;
    if (atEdge) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  const dialog = /* @__PURE__ */ jsx8("div", { style: styles.overlay, ...{ [SCOPE_ATTR]: "" }, children: /* @__PURE__ */ jsxs7("div", { ref: dialogRef, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": bodyId, onKeyDown, style: styles.dialog, children: [
    /* @__PURE__ */ jsx8("h2", { id: titleId, style: { ...styles.heading, marginBottom: space.sm }, children: title }),
    /* @__PURE__ */ jsx8("p", { id: bodyId, style: styles.text, children: body }),
    error ? /* @__PURE__ */ jsxs7("p", { role: "alert", style: { ...styles.text, fontWeight: 600 }, children: [
      "Failed: ",
      error
    ] }) : null,
    /* @__PURE__ */ jsxs7("div", { style: styles.dialogActions, children: [
      /* @__PURE__ */ jsx8(Button, { ref: cancelRef, disabled: busy, onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ jsx8(Button, { variant: destructive ? "danger" : "primary", disabled: busy, label: confirmLabel, onClick: onConfirm, children: busy ? "Working\u2026" : "Confirm" })
    ] })
  ] }) });
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

// ui/src/useAging.ts
import { useEffect as useEffect2, useRef as useRef2, useState } from "react";

// ui/src/ticker.ts
var AGE_TICK_MS = 3e4;
function startTicker(intervalMs, onTick) {
  const id = setInterval(onTick, intervalMs);
  return () => clearInterval(id);
}
function agedNow(anchor, localNow) {
  return anchor.server + Math.max(0, localNow - anchor.local);
}

// ui/src/useAging.ts
var UPDATED_TICK_MS = 5e3;
function useAgingNow(serverNow, tickMs = AGE_TICK_MS) {
  const anchor = useRef2({ server: serverNow, local: Date.now() });
  if (anchor.current.server !== serverNow) anchor.current = { server: serverNow, local: Date.now() };
  const [, setTick] = useState(0);
  useEffect2(() => startTicker(tickMs, () => setTick((t) => t + 1)), [tickMs]);
  return agedNow(anchor.current, Date.now());
}
function useNow(tickMs = UPDATED_TICK_MS) {
  const [now, setNow] = useState(() => Date.now());
  useEffect2(() => startTicker(tickMs, () => setNow(Date.now())), [tickMs]);
  return now;
}

// ui/src/Inbox.tsx
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
var INBOX_HEADING_ID = "inbox-heading";
function Inbox({ items, now, onGrant, onDismiss, pendingId, errors, grantingId = null }) {
  const current = useAgingNow(now);
  return /* @__PURE__ */ jsxs8(Panel, { labelledBy: INBOX_HEADING_ID, style: items.length > 0 ? { borderColor: color.warn } : void 0, children: [
    /* @__PURE__ */ jsx9(SectionHeader, { icon: "shield", title: "Needs op", id: INBOX_HEADING_ID, count: items.length }),
    items.length === 0 ? /* @__PURE__ */ jsx9(EmptyState, { icon: "shield-check", title: "No open requests", hint: "An agent that is denied an action it needs op for shows up here." }) : /* @__PURE__ */ jsx9("ul", { "aria-label": "Open permission requests", style: styles.list, children: items.map((item) => {
      const channels = item.channel === null ? item.candidates : [item.channel];
      const agent = cleanText(item.agent);
      const where = item.channel !== null ? cleanText(item.channel) : item.candidates.length === 0 ? "an unknown channel" : `one of ${item.candidates.map(cleanText).join(", ")}`;
      const busy = pendingId === item.id;
      const granting = grantingId === item.id;
      return /* @__PURE__ */ jsxs8("li", { style: styles.inboxItem, children: [
        /* @__PURE__ */ jsxs8("div", { style: styles.inboxHead, children: [
          /* @__PURE__ */ jsx9(Icon, { name: "shield", color: color.warn }),
          /* @__PURE__ */ jsxs8("div", { style: styles.stack, children: [
            /* @__PURE__ */ jsxs8("p", { style: { margin: 0, overflowWrap: "anywhere" }, children: [
              /* @__PURE__ */ jsx9("strong", { children: agent }),
              " \u2192 ",
              /* @__PURE__ */ jsx9("span", { children: cleanText(item.action) })
            ] }),
            /* @__PURE__ */ jsxs8("span", { style: styles.smallRow, children: [
              /* @__PURE__ */ jsx9(Pill, { icon: "hash", children: where }),
              /* @__PURE__ */ jsxs8("span", { style: styles.muted, children: [
                "was denied ",
                formatAgo(current - item.ts)
              ] })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs8("div", { style: styles.controls, children: [
          channels.map((channel) => /* @__PURE__ */ jsxs8(
            Button,
            {
              id: inboxGrantId(item.id, channel),
              variant: "primary",
              size: "sm",
              icon: "shield-check",
              disabled: granting,
              onClick: () => granting ? void 0 : onGrant(item, channel),
              label: channels.length > 1 ? `Grant op in ${cleanText(channel)} to ${agent}` : `Grant op to ${agent} in ${cleanText(channel)}`,
              children: [
                "Grant op",
                channels.length > 1 ? ` in ${cleanText(channel)}` : ""
              ]
            },
            channel
          )),
          /* @__PURE__ */ jsx9(
            Button,
            {
              variant: "ghost",
              size: "sm",
              disabled: busy,
              onClick: () => busy ? void 0 : onDismiss(item),
              label: `${busy ? "Dismissing\u2026 request" : "Dismiss the request"} from ${agent}${item.channel === null ? "" : ` in ${cleanText(item.channel)}`}`,
              children: busy ? "Dismissing\u2026" : "Dismiss"
            }
          )
        ] }),
        errors[item.id] === void 0 ? null : /* @__PURE__ */ jsxs8("p", { role: "alert", style: styles.text, children: [
          "Failed: ",
          errors[item.id]
        ] })
      ] }, item.id);
    }) })
  ] });
}

// ui/src/LiveRegion.tsx
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function LiveRegion({ announcement, notice }) {
  return /* @__PURE__ */ jsxs9("div", { "aria-live": "polite", "aria-atomic": "false", style: styles.srOnly, children: [
    /* @__PURE__ */ jsx10("p", { children: announcement.text }, `a-${announcement.id}`),
    /* @__PURE__ */ jsx10("p", { children: notice.text }, `n-${notice.id}`)
  ] });
}

// ui/src/notice.ts
var NOTICE_MS = 5e3;
var NO_NOTICE = { text: "", id: 0 };
function createNoticeManager(onChange, ms = NOTICE_MS) {
  let id = 0;
  let timer;
  const cancel = () => {
    if (timer !== void 0) clearTimeout(timer);
    timer = void 0;
  };
  return {
    show(text) {
      cancel();
      id += 1;
      const shown = id;
      onChange({ text, id: shown });
      timer = setTimeout(() => {
        timer = void 0;
        onChange({ text: "", id: shown });
      }, ms);
    },
    stop: cancel
  };
}

// ui/src/StatusBanner.tsx
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
var CHECK_SETTINGS = "Check host, nick and secret in the app settings.";
var BANNER = {
  registered: { level: "ok", icon: "check-circle", label: "Connected", message: (b) => `${cleanText(b.host)} as ${cleanText(b.nick)}` },
  connecting: { level: "wait", icon: "circle-dashed", label: "Connecting", message: (b) => `Connecting to ${b.host === "" ? "the S\xE9ance server" : cleanText(b.host)}\u2026` },
  reconnecting: { level: "wait", icon: "circle-dashed", label: "Reconnecting", message: () => "The connection to the S\xE9ance server was lost. Reconnecting\u2026" },
  unconfigured: { level: "problem", icon: "alert-triangle", label: "Not configured", message: () => `The app is not configured yet. ${CHECK_SETTINGS}` },
  "auth-failed": { level: "problem", icon: "alert-triangle", label: "Sign-in failed", message: () => `The S\xE9ance server refused the account. ${CHECK_SETTINGS}` },
  "nick-rejected": { level: "problem", icon: "alert-triangle", label: "Nick rejected", message: () => `The S\xE9ance server rejected the nick. ${CHECK_SETTINGS}` },
  "config-invalid": { level: "problem", icon: "alert-triangle", label: "Settings invalid", message: () => `The app settings are not valid. ${CHECK_SETTINGS}` },
  "duplicate-instance": {
    level: "problem",
    icon: "alert-triangle",
    label: "Another copy is running",
    message: () => "Another copy of this app already holds the S\xE9ance connection, so this one stays disconnected."
  }
};
var UNKNOWN = {
  level: "wait",
  icon: "circle-dashed",
  label: "Unknown state",
  message: (b) => `The app reported a bridge state this page does not know: ${cleanText(String(b.state))}.`
};
function bannerFor(state) {
  return Object.hasOwn(BANNER, state) ? BANNER[state] : UNKNOWN;
}
var LEVEL_COLOR = { ok: color.ok, wait: color.warn, problem: color.danger };
function StatusBanner({ bridge, status, now }) {
  const ticking = useNow();
  const current = now ?? ticking;
  const copy = bridge === null ? null : bannerFor(bridge.state);
  const failed = status !== null && !status.ok ? status : null;
  const updated = status?.lastSuccess ?? null;
  return /* @__PURE__ */ jsxs10("div", { style: styles.bannerStack, children: [
    bridge === null || copy === null ? /* @__PURE__ */ jsxs10("p", { role: "status", style: styles.statusBar, children: [
      /* @__PURE__ */ jsx11(Icon, { name: "circle-dashed", color: color.warn }),
      /* @__PURE__ */ jsx11("span", { children: failed !== null ? "Waiting for the app\u2026" : "Loading\u2026" })
    ] }) : copy.level === "ok" ? /* @__PURE__ */ jsxs10("div", { style: styles.statusText, children: [
      /* @__PURE__ */ jsxs10("p", { role: "status", "data-level": copy.level, style: styles.statusText, children: [
        /* @__PURE__ */ jsx11(Icon, { name: copy.icon, color: LEVEL_COLOR[copy.level] }),
        /* @__PURE__ */ jsx11("strong", { children: copy.label }),
        /* @__PURE__ */ jsx11("span", { style: styles.muted, children: "\xB7" }),
        /* @__PURE__ */ jsx11("span", { children: copy.message(bridge) })
      ] }),
      updated === null || failed !== null ? null : /* @__PURE__ */ jsxs10("span", { style: styles.muted, children: [
        "\xB7 updated ",
        formatAgo(Math.max(0, current - updated))
      ] })
    ] }) : /* @__PURE__ */ jsxs10("p", { role: "status", "data-level": copy.level, style: bannerStyle(copy.level), children: [
      /* @__PURE__ */ jsx11(Icon, { name: copy.icon, color: LEVEL_COLOR[copy.level] }),
      /* @__PURE__ */ jsxs10("strong", { children: [
        copy.label,
        "."
      ] }),
      " ",
      /* @__PURE__ */ jsx11("span", { children: copy.message(bridge) })
    ] }),
    failed !== null ? /* @__PURE__ */ jsxs10("p", { role: "alert", style: bannerStyle("problem"), children: [
      /* @__PURE__ */ jsx11(Icon, { name: "alert-triangle", color: color.danger }),
      /* @__PURE__ */ jsx11("strong", { children: "Connection to the app lost." }),
      " ",
      /* @__PURE__ */ jsxs10("span", { children: [
        failed.lastSuccess === null ? "No successful update yet." : `Last update at ${formatTime(failed.lastSuccess)}.`,
        " Trying again every 10 seconds."
      ] })
    ] }) : null
  ] });
}

// ui/src/SummaryCard.tsx
import { Fragment as Fragment2, jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
var isOldSummary = (summary, today) => today !== void 0 && summary.date !== today;
var SUMMARY_HEADING_ID = "summary-heading";
function SummaryCard({ summary, liveTotal, today }) {
  const old = summary !== void 0 && summary !== null && isOldSummary(summary, today);
  return /* @__PURE__ */ jsxs11(Panel, { labelledBy: SUMMARY_HEADING_ID, children: [
    /* @__PURE__ */ jsx12(SectionHeader, { icon: "coins", title: "Daily summary", id: SUMMARY_HEADING_ID, actions: summary?.stale === true ? /* @__PURE__ */ jsx12(Pill, { tone: "warn", icon: "alert-triangle", children: "Stale" }) : void 0 }),
    summary === void 0 ? /* @__PURE__ */ jsxs11(Fragment2, { children: [
      /* @__PURE__ */ jsx12(SrOnly, { children: "Loading summary\u2026" }),
      /* @__PURE__ */ jsx12(Skeleton, { height: "3rem" })
    ] }) : summary === null ? /* @__PURE__ */ jsx12(EmptyState, { icon: "clock", title: "No summary yet", hint: "The backend writes one once a day." }) : /* @__PURE__ */ jsxs11(Fragment2, { children: [
      /* @__PURE__ */ jsx12("h3", { style: { ...styles.label, margin: 0 }, children: old ? `Last summary: ${cleanText(summary.date)}` : cleanText(summary.date) }),
      old && liveTotal !== void 0 ? /* @__PURE__ */ jsxs11("div", { style: { ...styles.summaryRow, fontWeight: 600 }, children: [
        /* @__PURE__ */ jsx12("span", { children: "Total credits now" }),
        /* @__PURE__ */ jsx12("span", { style: styles.number, children: formatCredits(liveTotal) })
      ] }) : null,
      /* @__PURE__ */ jsxs11("div", { style: { ...styles.summaryRow, fontWeight: old ? 400 : 600 }, children: [
        /* @__PURE__ */ jsx12("span", { children: old ? "Total credits in that summary" : "Total credits" }),
        /* @__PURE__ */ jsx12("span", { style: styles.number, children: formatCredits(summary.totalCredits) })
      ] }),
      summary.stale ? /* @__PURE__ */ jsx12("p", { style: { ...styles.hint, margin: 0 }, children: "Figures were not refreshed in this run." }) : null,
      summary.channels.length === 0 ? /* @__PURE__ */ jsx12("p", { style: { ...styles.hint, margin: 0 }, children: "No channel figures." }) : /* @__PURE__ */ jsx12("ul", { "aria-label": "Credits per channel", style: styles.plainList, children: summary.channels.map((c) => /* @__PURE__ */ jsxs11("li", { style: styles.summaryRow, children: [
        /* @__PURE__ */ jsx12("span", { style: { overflowWrap: "anywhere" }, children: cleanText(c.name) }),
        /* @__PURE__ */ jsxs11("span", { style: styles.number, children: [
          formatCredits(c.used),
          c.total === null ? "" : ` of ${formatCredits(c.total)}`
        ] })
      ] }, c.name)) })
    ] })
  ] });
}

// ui/src/SummonForm.tsx
import { useId as useId2 } from "react";
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function SummonForm({ channel, agent, pending, message, onChange, onSubmit }) {
  const headingId = useId2();
  const channelId = useId2();
  const agentId = useId2();
  const hintId = useId2();
  const submit = (event) => {
    event.preventDefault();
    if (!pending) onSubmit();
  };
  return /* @__PURE__ */ jsxs12(Panel, { labelledBy: headingId, children: [
    /* @__PURE__ */ jsx13(SectionHeader, { icon: "wand", title: "Summon an agent", id: headingId }),
    /* @__PURE__ */ jsxs12("form", { onSubmit: submit, "aria-busy": pending, style: styles.form, children: [
      /* @__PURE__ */ jsxs12("div", { style: styles.fieldRow, children: [
        /* @__PURE__ */ jsxs12("div", { style: styles.field, children: [
          /* @__PURE__ */ jsx13("label", { htmlFor: channelId, style: styles.label, children: "Channel" }),
          /* @__PURE__ */ jsx13("input", { id: channelId, name: "channel", style: styles.input, value: channel, placeholder: "#fix-bug", onChange: (e) => onChange("channel", e.target.value), "aria-describedby": hintId, required: true })
        ] }),
        /* @__PURE__ */ jsxs12("div", { style: styles.field, children: [
          /* @__PURE__ */ jsx13("label", { htmlFor: agentId, style: styles.label, children: "Agent (optional)" }),
          /* @__PURE__ */ jsx13("input", { id: agentId, name: "agent", style: styles.input, value: agent, placeholder: "coder", onChange: (e) => onChange("agent", e.target.value) })
        ] })
      ] }),
      /* @__PURE__ */ jsx13("p", { id: hintId, style: { ...styles.hint, margin: 0 }, children: "The channel name must start with #. The crew account joins the channel first if it is not in it yet." }),
      /* @__PURE__ */ jsx13("div", { children: /* @__PURE__ */ jsx13(Button, { type: "submit", variant: "primary", icon: "wand", disabled: pending, children: pending ? "Summoning\u2026" : "Summon" }) }),
      pending ? /* @__PURE__ */ jsx13("p", { role: "status", style: { ...styles.hint, margin: 0 }, children: "Joining the channel if needed, then waiting for the agent to say it is ready. This can take up to 30 seconds." }) : null,
      message === null ? null : message.ok ? /* @__PURE__ */ jsx13("p", { role: "status", style: { ...styles.text, margin: 0 }, children: message.text }) : /* @__PURE__ */ jsxs12("p", { role: "alert", style: { ...styles.text, margin: 0, fontWeight: 600 }, children: [
        "Failed: ",
        message.text
      ] })
    ] })
  ] });
}

// ui/src/Dashboard.tsx
import { Fragment as Fragment3, jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
var noop = () => void 0;
var IDLE_ACTIONS = {
  summon: { channel: "", agent: "", pending: false, message: null, onChange: noop, onSubmit: noop },
  inbox: { pendingId: null, errors: {}, onGrant: noop, onDismiss: noop },
  onMode: noop,
  onExorcise: noop,
  confirm: initialConfirm,
  onConfirm: noop,
  onCancel: noop
};
var CHANNEL_PLACEHOLDERS = 2;
function Dashboard({ state, summary, status, actions = IDLE_ACTIONS, announcement = NO_NOTICE, notice = NO_NOTICE }) {
  const dialog = actions.confirm;
  const copy = dialog.phase === "idle" ? null : confirmCopy(dialog.request);
  const inFlight = dialog.phase === "submitting" ? dialog.request : null;
  const grantingId = inFlight?.kind === "grant" ? inFlight.inboxId ?? null : null;
  return /* @__PURE__ */ jsxs13("div", { ...{ [SCOPE_ATTR]: "" }, children: [
    /* @__PURE__ */ jsx14("style", { children: FOCUS_CSS }),
    /* @__PURE__ */ jsx14(PageHeader, { title: "S\xE9ance Crew", subtitle: "Channels, agents, credits and permission requests." }),
    /* @__PURE__ */ jsxs13("main", { style: styles.page, children: [
      /* @__PURE__ */ jsx14(LiveRegion, { announcement, notice }),
      /* @__PURE__ */ jsx14(StatusBanner, { bridge: state?.bridge ?? null, status }),
      notice.text === "" ? null : /* @__PURE__ */ jsx14("p", { style: styles.text, children: notice.text }),
      /* @__PURE__ */ jsx14(StatTiles, { state }),
      /* @__PURE__ */ jsxs13("div", { style: styles.columns, children: [
        /* @__PURE__ */ jsx14("div", { style: styles.mainColumn, children: /* @__PURE__ */ jsxs13(Panel, { labelledBy: FOCUS_FALLBACK_ID, children: [
          /* @__PURE__ */ jsx14(SectionHeader, { icon: "hash", title: "Channels", id: FOCUS_FALLBACK_ID, focusable: true, count: state?.channels.length }),
          state === null ? /* @__PURE__ */ jsxs13(Fragment3, { children: [
            /* @__PURE__ */ jsx14(SrOnly, { children: "Loading channels\u2026" }),
            Array.from({ length: CHANNEL_PLACEHOLDERS }, (_, i) => /* @__PURE__ */ jsx14(Skeleton, { height: "12rem" }, i))
          ] }) : state.channels.length === 0 ? /* @__PURE__ */ jsx14(EmptyState, { icon: "ghost", title: "No channels yet", hint: "Summon an agent into a channel whose name starts with #, e.g. #fix-bug" }) : state.channels.map((channel) => /* @__PURE__ */ jsx14(
            ChannelCard,
            {
              channel,
              now: state.serverTime,
              agentControls: (agent, ch) => /* @__PURE__ */ jsx14(
                AgentControls,
                {
                  agent,
                  channel: ch.name,
                  onMode: actions.onMode,
                  onExorcise: actions.onExorcise,
                  busy: inFlight !== null && inFlight.channel === ch.name && inFlight.agent === agent.nick
                }
              )
            },
            channel.name
          )),
          state?.truncated === true ? /* @__PURE__ */ jsx14("p", { style: styles.hint, children: "Some older log lines were left out to keep the page fast." }) : null
        ] }) }),
        /* @__PURE__ */ jsxs13("aside", { "aria-label": "Actions and summary", style: styles.aside, children: [
          state === null ? null : /* @__PURE__ */ jsx14(Inbox, { items: state.inbox, now: state.serverTime, grantingId, ...actions.inbox }),
          /* @__PURE__ */ jsx14(SummonForm, { ...actions.summon }),
          /* @__PURE__ */ jsx14(SummaryCard, { summary, liveTotal: state?.totalCredits, today: state === null ? void 0 : new Date(state.serverTime).toISOString().slice(0, 10) })
        ] })
      ] })
    ] }),
    copy === null || dialog.phase === "idle" ? null : /* @__PURE__ */ jsx14(
      ConfirmDialog,
      {
        title: copy.title,
        body: copy.body,
        confirmLabel: copy.confirmLabel,
        busy: dialog.phase === "submitting",
        error: dialog.phase === "failed" ? dialog.message : null,
        onConfirm: actions.onConfirm,
        onCancel: actions.onCancel,
        triggerId: triggerIdFor(dialog.request),
        destructive: copy.destructive
      }
    )
  ] });
}

// ui/src/useSeanceState.ts
import { useAppApi } from "@kirocrew/app-sdk";
import { useCallback, useEffect as useEffect3, useRef as useRef3, useState as useState2 } from "react";

// ui/src/diff.ts
var EMPTY = { newCommits: [], newInbox: [] };
function diffStates(prev, next) {
  if (prev === null) return EMPTY;
  if (prev.bootId !== next.bootId) return EMPTY;
  const knownCommits = new Set(prev.channels.flatMap((c) => c.commits.map((k) => `${c.name}\0${k.sha}`)));
  const knownInbox = new Set(prev.inbox.map((i) => i.id));
  const newCommits = next.channels.flatMap(
    (c) => c.commits.filter((k) => !knownCommits.has(`${c.name}\0${k.sha}`)).map((k) => ({ channel: c.name, agent: k.agent, sha: k.sha }))
  );
  const newInbox = next.inbox.filter((i) => !knownInbox.has(i.id)).map((i) => ({ id: i.id, channel: i.channel, agent: i.agent, action: i.action }));
  return newCommits.length === 0 && newInbox.length === 0 ? EMPTY : { newCommits, newInbox };
}
function announcementsFor(diff) {
  return [
    ...diff.newCommits.map((c) => `New commit ${c.sha} by ${c.agent} in ${c.channel}.`),
    ...diff.newInbox.map((i) => `${i.agent} needs permission${i.channel === null ? "" : ` in ${i.channel}`}: ${i.action}.`)
  ];
}

// ui/src/poller.ts
var POLL_MS = 3e3;
var BACKOFF_MS = 1e4;
var SUMMARY_MS = 6e4;
var isRecord2 = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
function isUnchanged(v2) {
  return isRecord2(v2) && v2["changed"] === false && typeof v2["revision"] === "number";
}
function isState(v2) {
  return isRecord2(v2) && typeof v2["revision"] === "number" && Array.isArray(v2["channels"]) && Array.isArray(v2["inbox"]) && isRecord2(v2["bridge"]);
}
function createPoller(deps) {
  let stopped = true;
  let revision = null;
  let bootId = null;
  let lastSuccess = null;
  let stateTimer;
  let summaryTimer;
  let stateInFlight = false;
  let rerun = false;
  let summaryInFlight = false;
  const clearState = () => {
    if (stateTimer !== void 0) clearTimeout(stateTimer);
    stateTimer = void 0;
  };
  const clearSummary = () => {
    if (summaryTimer !== void 0) clearTimeout(summaryTimer);
    summaryTimer = void 0;
  };
  const scheduleState = (ms) => {
    clearState();
    if (stopped || deps.isHidden()) return;
    stateTimer = setTimeout(() => void pollState(), ms);
  };
  const scheduleSummary = () => {
    clearSummary();
    if (stopped || deps.isHidden()) return;
    summaryTimer = setTimeout(() => void pollSummary(), SUMMARY_MS);
  };
  async function pollState() {
    clearState();
    if (stopped) return;
    if (deps.isHidden()) return;
    if (stateInFlight) {
      rerun = true;
      return;
    }
    stateInFlight = true;
    let delay = POLL_MS;
    try {
      const path = stateUrl(revision);
      const body = await deps.get(path);
      if (stopped) return;
      if (isUnchanged(body)) {
        if (bootId !== null && body.bootId !== void 0 && body.bootId !== bootId) {
          revision = null;
          bootId = body.bootId;
          rerun = true;
        } else {
          revision = body.revision;
        }
      } else if (isState(body)) {
        revision = body.revision;
        bootId = typeof body.bootId === "string" ? body.bootId : bootId;
        deps.onState(body);
      } else {
        throw new Error("unexpected answer from the state route");
      }
      lastSuccess = deps.now();
      deps.onStatus({ ok: true, lastSuccess });
    } catch {
      if (stopped) return;
      delay = BACKOFF_MS;
      deps.onStatus({ ok: false, lastSuccess });
    } finally {
      stateInFlight = false;
    }
    if (stopped) return;
    if (rerun) {
      rerun = false;
      void pollState();
      return;
    }
    scheduleState(delay);
  }
  async function pollSummary() {
    clearSummary();
    if (stopped || deps.isHidden() || summaryInFlight) return;
    summaryInFlight = true;
    try {
      const body = await deps.get(ROUTES.summary);
      if (!stopped && isRecord2(body) && "summary" in body) deps.onSummary(body.summary);
    } catch {
    } finally {
      summaryInFlight = false;
    }
    scheduleSummary();
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void pollState();
      void pollSummary();
    },
    stop() {
      stopped = true;
      clearState();
      clearSummary();
    },
    refresh() {
      if (stopped) return;
      void pollState();
    },
    visibilityChanged() {
      if (stopped) return;
      if (deps.isHidden()) {
        clearState();
        clearSummary();
        return;
      }
      void pollState();
      void pollSummary();
    }
  };
}

// ui/src/useSeanceState.ts
function useSeanceState() {
  const api = useAppApi();
  const apiRef = useRef3(api);
  apiRef.current = api;
  const pollerRef = useRef3(null);
  const [state, setState] = useState2(null);
  const [summary, setSummary] = useState2(void 0);
  const [status, setStatus] = useState2(null);
  const [announcement, setAnnouncement] = useState2(NO_NOTICE);
  const previous = useRef3(null);
  useEffect3(() => {
    const announcer = createNoticeManager(setAnnouncement);
    const poller = createPoller({
      get: (path) => apiRef.current.get(path),
      isHidden: () => document.visibilityState === "hidden",
      now: () => Date.now(),
      onState: (next) => {
        const lines = announcementsFor(diffStates(previous.current, next));
        previous.current = next;
        setState(next);
        if (lines.length > 0) announcer.show(lines.join(" "));
      },
      onStatus: setStatus,
      onSummary: setSummary
    });
    pollerRef.current = poller;
    const onVisibility = () => poller.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      announcer.stop();
      pollerRef.current = null;
    };
  }, []);
  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  return { state, summary, status, announcement, refresh };
}

// ui/src/App.tsx
import { jsx as jsx15 } from "react/jsx-runtime";
var FOCUS_WAIT_MS = 6e3;
function App() {
  const api = useAppApi2();
  const apiRef = useRef4(api);
  apiRef.current = api;
  const { state, summary, status, announcement, refresh } = useSeanceState();
  const refreshRef = useRef4(refresh);
  refreshRef.current = refresh;
  const [postApi] = useState3(() => ({ post: (path, body) => apiRef.current.post(path, body) }));
  const [form, setForm] = useState3({ channel: "", agent: "" });
  const [summonPending, setSummonPending] = useState3(false);
  const [summonMessage, setSummonMessage] = useState3(null);
  const [notice, setNotice] = useState3(NO_NOTICE);
  const [notices] = useState3(() => createNoticeManager(setNotice));
  useEffect4(() => () => notices.stop(), [notices]);
  const [confirm, setConfirm] = useState3(initialConfirm);
  const [dismissPending, setDismissPending] = useState3(null);
  const [dismissErrors, setDismissErrors] = useState3({});
  const stateRef = useRef4(state);
  stateRef.current = state;
  const pendingFocus = useRef4(null);
  const focusTimer = useRef4(null);
  const settleFocus = useCallback2((last) => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (!last && document.activeElement !== null && document.activeElement !== document.body) return;
    pendingFocus.current = null;
    if (focusTimer.current !== null) clearTimeout(focusTimer.current);
    focusTimer.current = null;
    applyFocus(document, pending.ids);
  }, []);
  useEffect4(() => {
    if (pendingFocus.current !== null && state !== pendingFocus.current.from) settleFocus(false);
  }, [state, settleFocus]);
  useEffect4(() => () => {
    if (focusTimer.current !== null) clearTimeout(focusTimer.current);
  }, []);
  const [controller] = useState3(
    () => createConfirmController({
      api: postApi,
      onState: setConfirm,
      onSuccess: (message, request) => {
        notices.show(message);
        pendingFocus.current = { ids: focusCandidates(request), from: stateRef.current };
        if (focusTimer.current !== null) clearTimeout(focusTimer.current);
        focusTimer.current = setTimeout(() => settleFocus(true), FOCUS_WAIT_MS);
      },
      refresh: () => refreshRef.current()
    })
  );
  const onSummon = useCallback2(async () => {
    setSummonPending(true);
    setSummonMessage(null);
    const outcome = await submitSummon(postApi, form.channel, form.agent);
    setSummonPending(false);
    setSummonMessage({ ok: outcome.ok, text: outcome.message });
    if (outcome.ok) refreshRef.current();
  }, [postApi, form.channel, form.agent]);
  const onDismiss = useCallback2(
    async (item) => {
      setDismissPending(item.id);
      setDismissErrors(({ [item.id]: _cleared, ...rest }) => rest);
      const outcome = await submitDismiss(postApi, item.id);
      setDismissPending(null);
      if (outcome.ok) {
        notices.show(`Dismissed the request from ${item.agent}.`);
        refreshRef.current();
      } else {
        setDismissErrors((errors) => ({ ...errors, [item.id]: outcome.message }));
      }
    },
    [postApi, notices]
  );
  const actions = {
    summon: {
      channel: form.channel,
      agent: form.agent,
      pending: summonPending,
      message: summonMessage,
      onChange: (field, value) => setForm((f) => ({ ...f, [field]: value })),
      onSubmit: () => void onSummon()
    },
    inbox: {
      pendingId: dismissPending,
      errors: dismissErrors,
      onGrant: (item, channel) => controller.open({ kind: "grant", channel, agent: item.agent, mode: "+o", inboxId: item.id }),
      onDismiss: (item) => void onDismiss(item)
    },
    onMode: (agent, channel, mode) => controller.open({ kind: "mode", channel, agent: agent.nick, mode }),
    onExorcise: (agent, channel) => controller.open({ kind: "exorcise", channel, agent: agent.nick }),
    confirm,
    onConfirm: () => void controller.confirm(),
    onCancel: () => controller.cancel()
  };
  return /* @__PURE__ */ jsx15(Dashboard, { state, summary, status, actions, announcement, notice });
}
export {
  App as default
};
