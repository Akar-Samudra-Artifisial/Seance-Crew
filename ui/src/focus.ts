// Keyboard focus after an action. A successful grant, revoke or exorcise replaces the button that opened the dialog
// (Give +o becomes Revoke -o; an exorcised agent disappears), which would drop focus to <body>. These pure helpers name
// the DOM ids to try, in order; the page focuses the first one that exists once the new state has rendered.
import type { ConfirmRequest } from "./confirmFlow.js";

/** Where focus goes when nothing more specific exists: the "Channels" heading (see ConfirmDialog). */
export const CHANNELS_HEADING_ID = "channels-heading";

const enc = (s: string): string => encodeURIComponent(s);

/** The mode control or Exorcise button ("x") of one agent in one channel. */
export const controlId = (channel: string, agent: string, mode: string): string => `ctl-${enc(channel)}-${enc(agent)}-${enc(mode)}`;
export const agentRowId = (channel: string, agent: string): string => `agent-${enc(channel)}-${enc(agent)}`;
export const channelHeadingId = (channel: string): string => `channel-${enc(channel)}`;

const INVERSE = { "+v": "-v", "-v": "+v", "+o": "-o", "-o": "+o" } as const;

/**
 * Ids to try after `request` succeeded, best first.
 * - Mode change or grant: the replacement control (Give +o -> Revoke -o), then the agent row, then the channel heading.
 * - Exorcise: the Exorcise button if the agent is still listed, otherwise the channel card heading.
 */
export function focusCandidates(request: ConfirmRequest): readonly string[] {
  if (request.kind === "exorcise") return [controlId(request.channel, request.agent, "x"), channelHeadingId(request.channel), CHANNELS_HEADING_ID];
  return [controlId(request.channel, request.agent, INVERSE[request.mode]), agentRowId(request.channel, request.agent), channelHeadingId(request.channel), CHANNELS_HEADING_ID];
}

export interface FocusableDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
  getElementById(id: string): { focus(): void } | null;
}

/**
 * Focus the first candidate that exists. Does nothing when the user has already moved focus somewhere real (anything
 * but <body>), so a late state update never steals focus. Returns the id that got focus, or null.
 */
export function applyFocus(doc: FocusableDocument, ids: readonly string[]): string | null {
  if (doc.activeElement !== null && doc.activeElement !== undefined && doc.activeElement !== doc.body) return null;
  for (const id of ids) {
    const el = doc.getElementById(id);
    if (el !== null) {
      el.focus();
      return id;
    }
  }
  return null;
}
