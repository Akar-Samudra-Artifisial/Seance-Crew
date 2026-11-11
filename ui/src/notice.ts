// Short-lived messages (the result of an action, a new commit). A message is shown for 5 s and then cleared. Every
// message gets a new `id`, so the live region can be keyed on it and announce two identical messages in a row again.

export const NOTICE_MS = 5_000;

export interface Notice {
  readonly text: string;
  readonly id: number;
}

export const NO_NOTICE: Notice = { text: "", id: 0 };

export interface NoticeManager {
  /** Show `text` now, restart the 5 s clock. */
  show(text: string): void;
  /** Cancel the pending clear (on unmount). */
  stop(): void;
}

export function createNoticeManager(onChange: (notice: Notice) => void, ms: number = NOTICE_MS): NoticeManager {
  let id = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    show(text) {
      cancel();
      id += 1;
      const shown = id;
      onChange({ text, id: shown });
      timer = setTimeout(() => {
        timer = undefined;
        onChange({ text: "", id: shown });
      }, ms);
    },
    stop: cancel,
  };
}
