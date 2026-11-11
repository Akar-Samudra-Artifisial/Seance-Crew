// What changed between two states, for the aria-live announcements: new commit shas and new inbox ids.
import type { State } from "./types.js";

export interface Diff {
  readonly newCommits: ReadonlyArray<{ readonly channel: string; readonly agent: string; readonly sha: string }>;
  readonly newInbox: ReadonlyArray<{ readonly id: string; readonly channel: string | null; readonly agent: string; readonly action: string }>;
}

const EMPTY: Diff = { newCommits: [], newInbox: [] };

/** `prev` null is the first load: nothing is announced for what was already there. */
export function diffStates(prev: State | null, next: State): Diff {
  if (prev === null) return EMPTY;
  // A restarted backend is a fresh start, not a burst of new things.
  if (prev.bootId !== next.bootId) return EMPTY;
  const knownCommits = new Set(prev.channels.flatMap((c) => c.commits.map((k) => `${c.name}\u0000${k.sha}`)));
  const knownInbox = new Set(prev.inbox.map((i) => i.id));
  const newCommits = next.channels.flatMap((c) =>
    c.commits.filter((k) => !knownCommits.has(`${c.name}\u0000${k.sha}`)).map((k) => ({ channel: c.name, agent: k.agent, sha: k.sha })),
  );
  const newInbox = next.inbox.filter((i) => !knownInbox.has(i.id)).map((i) => ({ id: i.id, channel: i.channel, agent: i.agent, action: i.action }));
  return newCommits.length === 0 && newInbox.length === 0 ? EMPTY : { newCommits, newInbox };
}

/** Plain sentences for a live region. Every value is rendered as a text node by the caller. */
export function announcementsFor(diff: Diff): string[] {
  return [
    ...diff.newCommits.map((c) => `New commit ${c.sha} by ${c.agent} in ${c.channel}.`),
    ...diff.newInbox.map((i) => `${i.agent} needs permission${i.channel === null ? "" : ` in ${i.channel}`}: ${i.action}.`),
  ];
}
