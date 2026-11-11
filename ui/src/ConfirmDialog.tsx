import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { nextFocusIndex } from "./confirmFlow.js";
import { CHANNELS_HEADING_ID, focusEscaped, returnFocusTarget } from "./focus.js";
import { SCOPE_ATTR, space, styles } from "./styles.js";
import { Button } from "./ui.js";

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
  /** DOM id of the button that opened the dialog; focus goes back to it on close when it still exists. */
  readonly triggerId?: string;
  /** Danger style for the confirm button (exorcise, revoke); false gives the primary style (a grant). Default true. */
  readonly destructive?: boolean;
}

/** A control that can take focus back on close: still in the page, and an actual control rather than a container. */
const isUsableControl = (el: HTMLElement): boolean => el.isConnected && el.matches(FOCUSABLE) && el.tabIndex >= 0;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: focus moves in on open (to Cancel, the safe choice), Tab stays inside, Escape cancels, and focus
 * goes back to the element that opened it (or to a fallback heading when that element is gone) on unmount.
 *
 * Buttons use `aria-disabled` and a guard in the handler instead of `disabled`: a disabled button drops focus to the
 * body, which would break the Tab trap and Escape while a request is on its way.
 */
export function ConfirmDialog({ title, body, confirmLabel, busy, error, onConfirm, onCancel, triggerId, destructive = true }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerIdRef = useRef(triggerId);
  triggerIdRef.current = triggerId;

  // Layout effect: Cancel has focus before the browser paints and before any later effect runs.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    cancelRef.current?.focus();
    // aria-modal is a promise to assistive technology, so keep it: if anything moves focus out while the dialog is
    // open (a click on the overlay, or the host page focusing its own <main tabindex="-1">), bring it back to Cancel.
    const reclaim = (event: FocusEvent): void => {
      if (focusEscaped(dialogRef.current, event.target)) cancelRef.current?.focus();
    };
    document.addEventListener("focusin", reclaim, true);
    // Focus can also leave without a focusin landing anywhere (focus moved to <body>): check once after the frame.
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => {
      if (focusEscaped(dialogRef.current, document.activeElement)) cancelRef.current?.focus();
    }) : null;
    return () => {
      document.removeEventListener("focusin", reclaim, true);
      if (frame !== null) cancelAnimationFrame(frame);
      const id = triggerIdRef.current;
      const trigger = id === undefined ? null : document.getElementById(id);
      const target = returnFocusTarget(trigger, opener, isUsableControl);
      (target ?? document.getElementById(FOCUS_FALLBACK_ID))?.focus();
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

  const dialog = (
    <div style={styles.overlay} {...{ [SCOPE_ATTR]: "" }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onKeyDown={onKeyDown} style={styles.dialog}>
        <h2 id={titleId} style={{ ...styles.heading, marginBottom: space.sm }}>
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
          <Button ref={cancelRef} disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={destructive ? "danger" : "primary"} disabled={busy} label={confirmLabel} onClick={onConfirm}>
            {busy ? "Working…" : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
  // In the browser the dialog lives in document.body, outside the host's scrolling <main>, so no host container can
  // clip it, cover it or move it, and `position: fixed` is always relative to the viewport. Server rendering (tests)
  // has no document and renders it in place.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
