import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { nextFocusIndex } from "./confirmFlow.js";
import { CHANNELS_HEADING_ID } from "./focus.js";
import { buttonStyle, styles } from "./styles.js";

/** Where focus goes when the element that opened the dialog is gone (for example an inbox item removed after a grant). */
export const FOCUS_FALLBACK_ID = CHANNELS_HEADING_ID;

export interface ConfirmDialogProps {
  readonly title: string;
  readonly body: string;
  /** Accessible name of the confirm button; it includes the agent and channel. */
  readonly confirmLabel: string;
  /** True while the request is on its way: the buttons are aria-disabled (still focusable) and Escape does nothing. */
  readonly busy: boolean;
  /** The backend's error message from a failed attempt. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: focus moves in on open (to Cancel, the safe choice), Tab stays inside, Escape cancels, and focus
 * goes back to the element that opened it (or to a fallback heading when that element is gone) on unmount.
 *
 * Buttons use `aria-disabled` and a guard in the handler instead of `disabled`: a disabled button drops focus to the
 * body, which would break the Tab trap and Escape while a request is on its way.
 */
export function ConfirmDialog({ title, body, confirmLabel, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

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

  // A failed request leaves the dialog open: put focus back on Cancel so keyboard users are not left on a stale button.
  useEffect(() => {
    if (error) cancelRef.current?.focus();
  }, [error]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(items.length, current, event.shiftKey);
    // Only take over at the edges (or when focus is outside); inside, the browser's own order is right.
    const atEdge = current === -1 || (event.shiftKey && current === 0) || (!event.shiftKey && current === items.length - 1);
    if (atEdge) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <div style={styles.overlay}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onKeyDown={onKeyDown} style={styles.dialog}>
        <h2 id={titleId} style={{ ...styles.heading, marginTop: 0 }}>
          {title}
        </h2>
        <p id={bodyId} style={styles.text}>
          {body}
        </p>
        {error ? (
          <p role="alert" style={{ ...styles.text, fontWeight: 600 }}>
            Failed: {error}
          </p>
        ) : null}
        <div style={styles.dialogActions}>
          <button ref={cancelRef} type="button" aria-disabled={busy} style={buttonStyle("plain", busy)} onClick={() => (busy ? undefined : onCancel())}>
            Cancel
          </button>
          <button type="button" aria-disabled={busy} aria-label={confirmLabel} style={buttonStyle("danger", busy)} onClick={() => (busy ? undefined : onConfirm())}>
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
