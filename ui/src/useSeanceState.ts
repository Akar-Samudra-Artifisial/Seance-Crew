// React wrapper around the poller: current state, latest summary, connection status and announcements.
import { useAppApi } from "@kirocrew/app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { announcementsFor, diffStates } from "./diff.js";
import { createNoticeManager, NO_NOTICE, type Notice } from "./notice.js";
import { createPoller, type Poller } from "./poller.js";
import type { PollStatus, State, Summary } from "./types.js";

export interface SeanceState {
  readonly state: State | null;
  /** `undefined` until the first answer; `null` means "No summary yet". */
  readonly summary: Summary | null | undefined;
  readonly status: PollStatus | null;
  /** Sentences for the aria-live region (a new commit or inbox item); cleared after 5 s. */
  readonly announcement: Notice;
  /** Poll right away (call after every action). */
  readonly refresh: () => void;
}

export function useSeanceState(): SeanceState {
  const api = useAppApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const pollerRef = useRef<Poller | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [summary, setSummary] = useState<Summary | null | undefined>(undefined);
  const [status, setStatus] = useState<PollStatus | null>(null);
  const [announcement, setAnnouncement] = useState<Notice>(NO_NOTICE);
  const previous = useRef<State | null>(null);

  useEffect(() => {
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
      onSummary: setSummary,
    });
    pollerRef.current = poller;
    const onVisibility = (): void => poller.visibilityChanged();
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
