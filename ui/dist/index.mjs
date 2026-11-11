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
        confirmLabel: `Apply ${request.mode} to ${request.agent} in ${request.channel}`
      };
    case "exorcise":
      return {
        title: `Exorcise ${request.agent} from ${request.channel}?`,
        body: "The agent stops and uncommitted work in the worktree is reverted.",
        confirmLabel: `Exorcise ${request.agent} from ${request.channel}`
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
import { PageHeader, StatCard } from "@kirocrew/app-sdk/ui";

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
function modeLabel(modes) {
  const hasO = modes.includes("o");
  const hasV = modes.includes("v");
  if (hasO && hasV) return { icon: "\u25C6", text: "+o +v operator, voice" };
  if (hasO) return { icon: "\u25C6", text: "+o operator" };
  if (hasV) return { icon: "\u25C7", text: "+v voice" };
  return { icon: "\u25CB", text: "no modes" };
}
function modeChangesFor(modes) {
  if (modes.includes("o")) return ["-o"];
  if (modes.includes("v")) return ["+o", "-v"];
  return ["+v", "+o"];
}

// ui/src/focus.ts
var CHANNELS_HEADING_ID = "channels-heading";
var enc = (s) => encodeURIComponent(s);
var controlId = (channel, agent, mode) => `ctl-${enc(channel)}-${enc(agent)}-${enc(mode)}`;
var agentRowId = (channel, agent) => `agent-${enc(channel)}-${enc(agent)}`;
var channelHeadingId = (channel) => `channel-${enc(channel)}`;
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
  warn: "#f59e0b"
};
var button = {
  font: "inherit",
  cursor: "pointer",
  padding: "0.35rem 0.75rem",
  borderRadius: "0.375rem",
  border: `1px solid ${color.border}`,
  background: color.surface,
  color: color.cardFg
};
var styles = {
  page: { padding: "0 1.5rem 2rem", display: "flex", flexDirection: "column", gap: "1rem", color: color.cardFg },
  heading: { fontSize: "1.125rem", fontWeight: 600, margin: "0.5rem 0" },
  subheading: { fontSize: "0.95rem", fontWeight: 600, margin: "0.75rem 0 0.25rem" },
  cardHeading: { fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" },
  text: { margin: "0.25rem 0" },
  hint: { margin: "0.25rem 0", color: color.mutedText, fontSize: "0.875rem" },
  list: { listStyle: "none", padding: 0, margin: "0.25rem 0", display: "flex", flexDirection: "column", gap: "0.5rem" },
  plainList: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
  row: { display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", padding: "0.4rem 0.6rem", border: `1px solid ${color.border}`, borderRadius: "0.375rem" },
  cardBody: { display: "flex", flexDirection: "column", gap: "0.25rem" },
  controls: { display: "inline-flex", flexWrap: "wrap", gap: "0.5rem" },
  badge: { display: "inline-block", padding: "0 0.4rem", borderRadius: "999px", border: `1px solid ${color.border}`, background: color.surface, color: color.cardFg, fontSize: "0.8rem" },
  button,
  buttonPrimary: { ...button, background: color.accent, color: color.accentFg, borderColor: color.accent },
  // Black on the host red: 5.6:1. White would only reach 3.8:1.
  buttonDanger: { ...button, background: color.danger, color: color.accentFg, borderColor: color.danger },
  buttonDisabled: { opacity: 0.6, cursor: "not-allowed" },
  field: { display: "flex", flexDirection: "column", gap: "0.25rem", margin: "0.5rem 0" },
  label: { fontWeight: 600, fontSize: "0.875rem" },
  input: { font: "inherit", padding: "0.35rem 0.5rem", borderRadius: "0.375rem", border: `1px solid ${color.border}`, background: color.card, color: color.cardFg, maxWidth: "24rem" },
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
    listStyle: "none"
  },
  logLine: { margin: 0, whiteSpace: "pre-wrap" },
  logTime: { color: color.mutedText },
  untrusted: { margin: "0.25rem 0", fontSize: "0.8125rem", fontWeight: 600, color: color.cardFg },
  overlay: { position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.5)" },
  dialog: { background: color.card, color: color.cardFg, maxWidth: "28rem", width: "90%", padding: "1.25rem", borderRadius: "0.75rem", border: `1px solid ${color.border}` },
  dialogActions: { display: "flex", gap: "0.5rem", justifyContent: "flex-end" },
  srOnly: { position: "absolute", width: "1px", height: "1px", margin: "-1px", padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }
};
function bannerStyle(level) {
  const tone = level === "ok" ? color.ok : level === "wait" ? color.warn : color.danger;
  return { margin: "0.25rem 0", padding: "0.5rem 0.75rem", borderRadius: "0.375rem", border: `1px solid ${tone}`, borderLeft: `0.375rem solid ${tone}`, background: color.surface, color: color.cardFg };
}
function buttonStyle(role, disabled = false) {
  const base = role === "primary" ? styles.buttonPrimary : role === "danger" ? styles.buttonDanger : styles.button;
  return disabled ? { ...base, ...styles.buttonDisabled } : base;
}

// ui/src/AgentControls.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var verb = (mode) => mode.startsWith("-") ? "Revoke" : "Give";
var preposition = (mode) => mode.startsWith("-") ? "from" : "to";
function AgentControls({ agent, channel, onMode, onExorcise, busy = false }) {
  const nick = cleanText(agent.nick);
  const where = cleanText(channel);
  return /* @__PURE__ */ jsxs("span", { style: styles.controls, children: [
    modeChangesFor(agent.modes).map((mode) => /* @__PURE__ */ jsxs(
      "button",
      {
        id: controlId(channel, agent.nick, mode),
        type: "button",
        style: buttonStyle("plain", busy),
        "aria-disabled": busy,
        onClick: () => busy ? void 0 : onMode(agent, channel, mode),
        "aria-label": `${verb(mode)} ${mode} ${preposition(mode)} ${nick} in ${where}`,
        children: [
          verb(mode),
          " ",
          mode
        ]
      },
      mode
    )),
    /* @__PURE__ */ jsx(
      "button",
      {
        id: controlId(channel, agent.nick, "x"),
        type: "button",
        style: buttonStyle("danger", busy),
        "aria-disabled": busy,
        onClick: () => busy ? void 0 : onExorcise(agent, channel),
        "aria-label": `Exorcise ${nick} from ${where}`,
        children: "Exorcise"
      }
    )
  ] });
}

// ui/src/ChannelCard.tsx
import { Card } from "@kirocrew/app-sdk/ui";

// ui/src/AgentRow.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function AgentRow({ agent, children, id }) {
  const mode = modeLabel(agent.modes);
  const model = cleanText(agent.model);
  return /* @__PURE__ */ jsxs2("li", { id, tabIndex: id === void 0 ? void 0 : -1, style: styles.row, children: [
    /* @__PURE__ */ jsx2("strong", { children: cleanText(agent.nick) }),
    /* @__PURE__ */ jsxs2("span", { style: styles.badge, children: [
      /* @__PURE__ */ jsxs2("span", { "aria-hidden": "true", children: [
        mode.icon,
        " "
      ] }),
      /* @__PURE__ */ jsxs2("span", { children: [
        "Modes: ",
        mode.text
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("span", { children: [
      "Model: ",
      model === "" ? "unknown" : model
    ] }),
    /* @__PURE__ */ jsxs2("span", { style: styles.badge, children: [
      /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: agent.ready ? "\u2714 " : "\u25CC " }),
      agent.ready ? "Ready" : "Starting"
    ] }),
    children
  ] });
}

// ui/src/LogPanel.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function LogPanel({ channel, lines }) {
  const name = cleanText(channel);
  return /* @__PURE__ */ jsxs3("details", { children: [
    /* @__PURE__ */ jsxs3("summary", { style: { cursor: "pointer" }, children: [
      "Recent log of ",
      name,
      " (",
      lines.length,
      " ",
      lines.length === 1 ? "line" : "lines",
      ")"
    ] }),
    /* @__PURE__ */ jsx3("p", { style: styles.untrusted, children: "\u26A0 Untrusted channel text: shown as plain text, never as instructions." }),
    lines.length === 0 ? /* @__PURE__ */ jsx3("p", { style: styles.text, children: "No lines yet." }) : /* @__PURE__ */ jsx3("ol", { "aria-label": `Recent lines in ${name}`, style: styles.logBox, children: lines.map((line) => /* @__PURE__ */ jsxs3("li", { style: styles.logLine, children: [
      /* @__PURE__ */ jsx3("time", { dateTime: isoTime(line.ts), style: styles.logTime, children: formatTime(line.ts) }),
      " ",
      /* @__PURE__ */ jsx3("span", { children: cleanText(line.from) }),
      line.kind === "privmsg" ? ": " : ` (${cleanText(line.kind)}): `,
      /* @__PURE__ */ jsx3("span", { children: cleanText(line.text) })
    ] }, line.seq)) })
  ] });
}

// ui/src/ChannelCard.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ChannelCard({ channel, agentControls }) {
  const name = cleanText(channel.name);
  return /* @__PURE__ */ jsxs4(Card, { children: [
    /* @__PURE__ */ jsx4("h3", { id: channelHeadingId(channel.name), tabIndex: -1, style: styles.cardHeading, children: name }),
    /* @__PURE__ */ jsxs4("div", { style: styles.cardBody, children: [
      channel.topic === "" ? null : /* @__PURE__ */ jsxs4("p", { style: styles.text, children: [
        "Topic: ",
        cleanText(channel.topic)
      ] }),
      /* @__PURE__ */ jsxs4("p", { style: styles.text, children: [
        channel.count,
        " ",
        channel.count === 1 ? "member" : "members",
        ". Credits used: ",
        formatUsage(channel.credits.used, channel.credits.total)
      ] }),
      /* @__PURE__ */ jsx4("h4", { style: styles.subheading, children: "Agents" }),
      channel.agents.length === 0 ? /* @__PURE__ */ jsx4("p", { style: styles.hint, children: "No agents in this channel." }) : /* @__PURE__ */ jsx4("ul", { "aria-label": `Agents in ${name}`, style: styles.list, children: channel.agents.map((agent) => /* @__PURE__ */ jsx4(AgentRow, { agent, id: agentRowId(channel.name, agent.nick), children: agentControls?.(agent, channel) }, agent.nick)) }),
      /* @__PURE__ */ jsx4("h4", { style: styles.subheading, children: "Latest commits" }),
      channel.commits.length === 0 ? /* @__PURE__ */ jsx4("p", { style: styles.hint, children: "No commits yet." }) : /* @__PURE__ */ jsx4("ul", { "aria-label": `Latest commits in ${name}`, style: styles.plainList, children: [...channel.commits].reverse().map((commit) => /* @__PURE__ */ jsxs4("li", { children: [
        /* @__PURE__ */ jsx4("code", { children: cleanText(commit.sha) }),
        " by ",
        cleanText(commit.agent),
        ", ",
        commit.files,
        " ",
        commit.files === 1 ? "file" : "files",
        ",",
        " ",
        /* @__PURE__ */ jsx4("time", { dateTime: isoTime(commit.ts), children: formatTime(commit.ts) })
      ] }, `${commit.sha}-${commit.ts}`)) }),
      /* @__PURE__ */ jsx4(LogPanel, { channel: channel.name, lines: channel.lines })
    ] })
  ] });
}

// ui/src/ConfirmDialog.tsx
import { useEffect, useId, useRef } from "react";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
var FOCUS_FALLBACK_ID = CHANNELS_HEADING_ID;
var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function ConfirmDialog({ title, body, confirmLabel, busy, error, onConfirm, onCancel }) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener !== null && opener.isConnected) {
        opener.focus();
        return;
      }
      document.getElementById(FOCUS_FALLBACK_ID)?.focus();
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
  return /* @__PURE__ */ jsx5("div", { style: styles.overlay, children: /* @__PURE__ */ jsxs5("div", { ref: dialogRef, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "aria-describedby": bodyId, onKeyDown, style: styles.dialog, children: [
    /* @__PURE__ */ jsx5("h2", { id: titleId, style: { ...styles.heading, marginTop: 0 }, children: title }),
    /* @__PURE__ */ jsx5("p", { id: bodyId, style: styles.text, children: body }),
    error ? /* @__PURE__ */ jsxs5("p", { role: "alert", style: { ...styles.text, fontWeight: 600 }, children: [
      "Failed: ",
      error
    ] }) : null,
    /* @__PURE__ */ jsxs5("div", { style: styles.dialogActions, children: [
      /* @__PURE__ */ jsx5("button", { ref: cancelRef, type: "button", "aria-disabled": busy, style: buttonStyle("plain", busy), onClick: () => busy ? void 0 : onCancel(), children: "Cancel" }),
      /* @__PURE__ */ jsx5("button", { type: "button", "aria-disabled": busy, "aria-label": confirmLabel, style: buttonStyle("danger", busy), onClick: () => busy ? void 0 : onConfirm(), children: busy ? "Working\u2026" : "Confirm" })
    ] })
  ] }) });
}

// ui/src/Inbox.tsx
import { Card as Card2, CardTitle } from "@kirocrew/app-sdk/ui";
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

// ui/src/Inbox.tsx
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function useAgingNow(serverNow) {
  const anchor = useRef2({ server: serverNow, local: Date.now() });
  if (anchor.current.server !== serverNow) anchor.current = { server: serverNow, local: Date.now() };
  const [, setTick] = useState(0);
  useEffect2(() => startTicker(AGE_TICK_MS, () => setTick((t) => t + 1)), []);
  return agedNow(anchor.current, Date.now());
}
function Inbox({ items, now, onGrant, onDismiss, pendingId, errors, grantingId = null }) {
  const current = useAgingNow(now);
  return /* @__PURE__ */ jsxs6(Card2, { children: [
    /* @__PURE__ */ jsx6(CardTitle, { children: "Needs op" }),
    items.length === 0 ? /* @__PURE__ */ jsx6("p", { style: styles.text, children: "No open permission requests." }) : /* @__PURE__ */ jsx6("ul", { "aria-label": "Open permission requests", style: styles.list, children: items.map((item) => {
      const channels = item.channel === null ? item.candidates : [item.channel];
      const agent = cleanText(item.agent);
      const where = item.channel !== null ? cleanText(item.channel) : item.candidates.length === 0 ? "an unknown channel" : `one of ${item.candidates.map(cleanText).join(", ")}`;
      const busy = pendingId === item.id;
      const granting = grantingId === item.id;
      return /* @__PURE__ */ jsxs6("li", { style: { ...styles.row, flexDirection: "column", alignItems: "flex-start" }, children: [
        /* @__PURE__ */ jsxs6("p", { style: styles.text, children: [
          /* @__PURE__ */ jsx6("strong", { children: agent }),
          " in ",
          where,
          " was denied: ",
          cleanText(item.action),
          ". Waiting ",
          formatAge(current - item.ts),
          "."
        ] }),
        /* @__PURE__ */ jsxs6("div", { style: styles.controls, children: [
          channels.map((channel) => /* @__PURE__ */ jsxs6(
            "button",
            {
              type: "button",
              style: buttonStyle("primary", granting),
              "aria-disabled": granting,
              onClick: () => granting ? void 0 : onGrant(item, channel),
              "aria-label": `Grant op to ${agent} in ${cleanText(channel)}`,
              children: [
                "Grant op",
                channels.length > 1 ? ` in ${cleanText(channel)}` : ""
              ]
            },
            channel
          )),
          /* @__PURE__ */ jsx6(
            "button",
            {
              type: "button",
              style: buttonStyle("plain", busy),
              "aria-disabled": busy,
              onClick: () => busy ? void 0 : onDismiss(item),
              "aria-label": `Dismiss the request from ${agent}${item.channel === null ? "" : ` in ${cleanText(item.channel)}`}`,
              children: busy ? "Dismissing\u2026" : "Dismiss"
            }
          )
        ] }),
        errors[item.id] === void 0 ? null : /* @__PURE__ */ jsxs6("p", { role: "alert", style: styles.text, children: [
          "Failed: ",
          errors[item.id]
        ] })
      ] }, item.id);
    }) })
  ] });
}

// ui/src/LiveRegion.tsx
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function LiveRegion({ announcement, notice }) {
  return /* @__PURE__ */ jsxs7("div", { "aria-live": "polite", "aria-atomic": "false", style: styles.srOnly, children: [
    /* @__PURE__ */ jsx7("p", { children: announcement.text }, `a-${announcement.id}`),
    /* @__PURE__ */ jsx7("p", { children: notice.text }, `n-${notice.id}`)
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
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
var CHECK_SETTINGS = "Check host, nick and secret in the app settings.";
var BANNER = {
  registered: { level: "ok", icon: "\u25CF", label: "Connected", message: (b) => `Connected to ${cleanText(b.host)} as ${cleanText(b.nick)}.` },
  connecting: { level: "wait", icon: "\u25CC", label: "Connecting", message: (b) => `Connecting to ${b.host === "" ? "the S\xE9ance server" : cleanText(b.host)}\u2026` },
  reconnecting: { level: "wait", icon: "\u25CC", label: "Reconnecting", message: () => "The connection to the S\xE9ance server was lost. Reconnecting\u2026" },
  unconfigured: { level: "problem", icon: "\u25B2", label: "Not configured", message: () => `The app is not configured yet. ${CHECK_SETTINGS}` },
  "auth-failed": { level: "problem", icon: "\u25B2", label: "Sign-in failed", message: () => `The S\xE9ance server refused the account. ${CHECK_SETTINGS}` },
  "nick-rejected": { level: "problem", icon: "\u25B2", label: "Nick rejected", message: () => `The S\xE9ance server rejected the nick. ${CHECK_SETTINGS}` },
  "config-invalid": { level: "problem", icon: "\u25B2", label: "Settings invalid", message: () => `The app settings are not valid. ${CHECK_SETTINGS}` },
  "duplicate-instance": {
    level: "problem",
    icon: "\u25B2",
    label: "Another copy is running",
    message: () => "Another copy of this app already holds the S\xE9ance connection, so this one stays disconnected."
  }
};
var UNKNOWN = {
  level: "wait",
  icon: "?",
  label: "Unknown state",
  message: (b) => `The app reported a bridge state this page does not know: ${cleanText(String(b.state))}.`
};
function bannerFor(state) {
  return Object.hasOwn(BANNER, state) ? BANNER[state] : UNKNOWN;
}
function StatusBanner({ bridge, status }) {
  const copy = bridge === null ? null : bannerFor(bridge.state);
  const failed = status !== null && !status.ok ? status : null;
  return /* @__PURE__ */ jsxs8("div", { children: [
    bridge === null || copy === null ? /* @__PURE__ */ jsx8("p", { role: "status", style: bannerStyle("wait"), children: failed !== null ? "Waiting for the app\u2026" : "Loading\u2026" }) : /* @__PURE__ */ jsxs8("p", { role: "status", "data-level": copy.level, style: bannerStyle(copy.level), children: [
      /* @__PURE__ */ jsxs8("span", { "aria-hidden": "true", children: [
        copy.icon,
        " "
      ] }),
      /* @__PURE__ */ jsxs8("strong", { children: [
        copy.label,
        "."
      ] }),
      " ",
      /* @__PURE__ */ jsx8("span", { children: copy.message(bridge) })
    ] }),
    failed !== null ? /* @__PURE__ */ jsxs8("p", { role: "alert", style: bannerStyle("problem"), children: [
      /* @__PURE__ */ jsx8("span", { "aria-hidden": "true", children: "\u25B2 " }),
      /* @__PURE__ */ jsx8("strong", { children: "Connection to the app lost." }),
      " ",
      /* @__PURE__ */ jsxs8("span", { children: [
        failed.lastSuccess === null ? "No successful update yet." : `Last update at ${formatTime(failed.lastSuccess)}.`,
        " Trying again every 10 seconds."
      ] })
    ] }) : null
  ] });
}

// ui/src/SummaryCard.tsx
import { Card as Card3, CardTitle as CardTitle2 } from "@kirocrew/app-sdk/ui";
import { Fragment, jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
function SummaryCard({ summary }) {
  return /* @__PURE__ */ jsxs9(Card3, { children: [
    /* @__PURE__ */ jsx9(CardTitle2, { children: "Daily summary" }),
    summary === void 0 ? /* @__PURE__ */ jsx9("p", { style: styles.text, children: "Loading summary\u2026" }) : summary === null ? /* @__PURE__ */ jsx9("p", { style: styles.text, children: "No summary yet" }) : /* @__PURE__ */ jsxs9(Fragment, { children: [
      /* @__PURE__ */ jsxs9("p", { style: styles.text, children: [
        cleanText(summary.date),
        ": total credits ",
        formatCredits(summary.totalCredits),
        ".",
        summary.stale ? " Figures were not refreshed in this run." : ""
      ] }),
      summary.channels.length === 0 ? /* @__PURE__ */ jsx9("p", { style: styles.hint, children: "No channel figures." }) : /* @__PURE__ */ jsx9("ul", { "aria-label": "Credits per channel", style: styles.plainList, children: summary.channels.map((c) => /* @__PURE__ */ jsxs9("li", { children: [
        cleanText(c.name),
        ": ",
        formatCredits(c.used),
        c.total === null ? "" : ` of ${formatCredits(c.total)}`
      ] }, c.name)) })
    ] })
  ] });
}

// ui/src/SummonForm.tsx
import { Card as Card4, CardTitle as CardTitle3 } from "@kirocrew/app-sdk/ui";
import { useId as useId2 } from "react";
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
function SummonForm({ channel, agent, pending, message, onChange, onSubmit }) {
  const channelId = useId2();
  const agentId = useId2();
  const hintId = useId2();
  const submit = (event) => {
    event.preventDefault();
    if (!pending) onSubmit();
  };
  return /* @__PURE__ */ jsxs10(Card4, { children: [
    /* @__PURE__ */ jsx10(CardTitle3, { children: "Summon an agent" }),
    /* @__PURE__ */ jsxs10("form", { onSubmit: submit, "aria-busy": pending, children: [
      /* @__PURE__ */ jsxs10("div", { style: styles.field, children: [
        /* @__PURE__ */ jsx10("label", { htmlFor: channelId, style: styles.label, children: "Channel" }),
        /* @__PURE__ */ jsx10("input", { id: channelId, name: "channel", style: styles.input, value: channel, placeholder: "#fix-bug", onChange: (e) => onChange("channel", e.target.value), "aria-describedby": hintId, required: true }),
        /* @__PURE__ */ jsx10("span", { id: hintId, style: styles.hint, children: "The channel name must start with #. The crew account joins the channel first if it is not in it yet." })
      ] }),
      /* @__PURE__ */ jsxs10("div", { style: styles.field, children: [
        /* @__PURE__ */ jsx10("label", { htmlFor: agentId, style: styles.label, children: "Agent (optional)" }),
        /* @__PURE__ */ jsx10("input", { id: agentId, name: "agent", style: styles.input, value: agent, placeholder: "coder", onChange: (e) => onChange("agent", e.target.value) })
      ] }),
      /* @__PURE__ */ jsx10("button", { type: "submit", style: buttonStyle("primary", pending), "aria-disabled": pending, children: pending ? "Summoning\u2026" : "Summon" }),
      pending ? /* @__PURE__ */ jsx10("p", { role: "status", style: styles.hint, children: "Joining the channel if needed, then waiting for the agent to say it is ready. This can take up to 30 seconds." }) : null,
      message === null ? null : message.ok ? /* @__PURE__ */ jsx10("p", { role: "status", style: styles.text, children: message.text }) : /* @__PURE__ */ jsxs10("p", { role: "alert", style: { ...styles.text, fontWeight: 600 }, children: [
        "Failed: ",
        message.text
      ] })
    ] })
  ] });
}

// ui/src/Dashboard.tsx
import { Fragment as Fragment2, jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
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
function Dashboard({ state, summary, status, actions = IDLE_ACTIONS, announcement = NO_NOTICE, notice = NO_NOTICE }) {
  const dialog = actions.confirm;
  const copy = dialog.phase === "idle" ? null : confirmCopy(dialog.request);
  const inFlight = dialog.phase === "submitting" ? dialog.request : null;
  const grantingId = inFlight?.kind === "grant" ? inFlight.inboxId ?? null : null;
  return /* @__PURE__ */ jsxs11(Fragment2, { children: [
    /* @__PURE__ */ jsx11(PageHeader, { title: "S\xE9ance Crew", subtitle: "Channels, agents, credits and permission requests." }),
    /* @__PURE__ */ jsxs11("main", { style: styles.page, children: [
      /* @__PURE__ */ jsx11(LiveRegion, { announcement, notice }),
      /* @__PURE__ */ jsx11(StatusBanner, { bridge: state?.bridge ?? null, status }),
      notice.text === "" ? null : /* @__PURE__ */ jsx11("p", { style: styles.text, children: notice.text }),
      /* @__PURE__ */ jsx11("section", { "aria-label": "Totals", children: /* @__PURE__ */ jsx11(StatCard, { label: "Total credits", value: formatCredits(state?.totalCredits) }) }),
      /* @__PURE__ */ jsx11(SummaryCard, { summary }),
      /* @__PURE__ */ jsx11(SummonForm, { ...actions.summon }),
      state === null ? null : /* @__PURE__ */ jsx11(Inbox, { items: state.inbox, now: state.serverTime, grantingId, ...actions.inbox }),
      /* @__PURE__ */ jsxs11("section", { "aria-labelledby": FOCUS_FALLBACK_ID, children: [
        /* @__PURE__ */ jsx11("h2", { id: FOCUS_FALLBACK_ID, tabIndex: -1, style: styles.heading, children: "Channels" }),
        state === null ? /* @__PURE__ */ jsx11("p", { style: styles.text, children: "Loading channels\u2026" }) : state.channels.length === 0 ? /* @__PURE__ */ jsx11("p", { style: styles.text, children: "No channels yet. To start one, summon an agent into a channel whose name starts with # (for example #fix-bug)." }) : state.channels.map((channel) => /* @__PURE__ */ jsx11(
          ChannelCard,
          {
            channel,
            agentControls: (agent, ch) => /* @__PURE__ */ jsx11(
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
        state?.truncated === true ? /* @__PURE__ */ jsx11("p", { style: styles.hint, children: "Some older log lines were left out to keep the page fast." }) : null
      ] })
    ] }),
    copy === null || dialog.phase === "idle" ? null : /* @__PURE__ */ jsx11(
      ConfirmDialog,
      {
        title: copy.title,
        body: copy.body,
        confirmLabel: copy.confirmLabel,
        busy: dialog.phase === "submitting",
        error: dialog.phase === "failed" ? dialog.message : null,
        onConfirm: actions.onConfirm,
        onCancel: actions.onCancel
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
import { jsx as jsx12 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsx12(Dashboard, { state, summary, status, actions, announcement, notice });
}
export {
  App as default
};
