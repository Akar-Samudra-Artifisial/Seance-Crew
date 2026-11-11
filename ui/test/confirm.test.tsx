import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog, FOCUS_FALLBACK_ID } from "../src/ConfirmDialog.js";
import { Dashboard } from "../src/Dashboard.js";
import { confirmCopy, confirmReducer, initialConfirm, nextFocusIndex, type ConfirmRequest, type ConfirmState } from "../src/confirmFlow.js";

const grant: ConfirmRequest = { kind: "grant", channel: "#fix-bug", agent: "coder", mode: "+o", inboxId: "i1" };
const exorcise: ConfirmRequest = { kind: "exorcise", channel: "#fix-bug", agent: "coder" };

describe("confirmReducer", () => {
  it("opens a dialog, and only an explicit confirm moves to submitting", () => {
    const opened = confirmReducer(initialConfirm, { type: "open", request: grant });
    expect(opened).toEqual({ phase: "confirming", request: grant });
    expect(confirmReducer(opened, { type: "confirm" })).toEqual({ phase: "submitting", request: grant });
  });

  it("never reaches submitting without confirm", () => {
    let state: ConfirmState = initialConfirm;
    for (const action of [{ type: "open", request: grant }, { type: "cancel" }, { type: "succeeded" }, { type: "failed", message: "x" }] as const) {
      state = confirmReducer(state, action);
      expect(state.phase).not.toBe("submitting");
    }
  });

  it("cancel returns to idle and sends nothing", () => {
    const opened = confirmReducer(initialConfirm, { type: "open", request: exorcise });
    expect(confirmReducer(opened, { type: "cancel" })).toEqual(initialConfirm);
  });

  it("confirm without an open dialog does nothing", () => {
    expect(confirmReducer(initialConfirm, { type: "confirm" })).toEqual(initialConfirm);
  });

  it("cannot be cancelled or replaced while submitting", () => {
    const submitting = confirmReducer(confirmReducer(initialConfirm, { type: "open", request: grant }), { type: "confirm" });
    expect(confirmReducer(submitting, { type: "cancel" })).toBe(submitting);
    expect(confirmReducer(submitting, { type: "open", request: exorcise })).toBe(submitting);
  });

  it("success closes the dialog", () => {
    const submitting = confirmReducer(confirmReducer(initialConfirm, { type: "open", request: grant }), { type: "confirm" });
    expect(confirmReducer(submitting, { type: "succeeded" })).toEqual(initialConfirm);
  });

  it("failure keeps the dialog with the backend message; a retry needs another confirm", () => {
    const submitting = confirmReducer(confirmReducer(initialConfirm, { type: "open", request: grant }), { type: "confirm" });
    const failed = confirmReducer(submitting, { type: "failed", message: "not registered" });
    expect(failed).toEqual({ phase: "failed", request: grant, message: "not registered" });
    expect(confirmReducer(failed, { type: "confirm" })).toEqual({ phase: "submitting", request: grant });
    expect(confirmReducer(failed, { type: "cancel" })).toEqual(initialConfirm);
  });

  it("ignores results that arrive when nothing is in flight", () => {
    expect(confirmReducer(initialConfirm, { type: "succeeded" })).toBe(initialConfirm);
    expect(confirmReducer(initialConfirm, { type: "failed", message: "late" })).toBe(initialConfirm);
  });
});

describe("confirmCopy", () => {
  it("names the agent, channel and the effect of +o", () => {
    const copy = confirmCopy(grant);
    expect(copy.title).toBe("Grant +o to coder in #fix-bug?");
    expect(copy.body).toContain("edit files and run commands");
    expect(copy.confirmLabel).toContain("coder");
    expect(copy.confirmLabel).toContain("#fix-bug");
  });

  it("states that exorcise reverts uncommitted work", () => {
    const copy = confirmCopy(exorcise);
    expect(copy.title).toBe("Exorcise coder from #fix-bug?");
    expect(copy.body).toContain("uncommitted work in the worktree is reverted");
  });

  it("words a revoke as a revoke", () => {
    expect(confirmCopy({ kind: "mode", channel: "#a", agent: "coder", mode: "-o" }).title).toBe("Revoke -o from coder in #a?");
  });
});

describe("nextFocusIndex", () => {
  it("wraps in both directions and handles focus outside the dialog", () => {
    expect(nextFocusIndex(2, 1, false)).toBe(0);
    expect(nextFocusIndex(2, 0, true)).toBe(1);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});

describe("ConfirmDialog markup", () => {
  const render = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}): string =>
    renderToStaticMarkup(
      <ConfirmDialog title="Exorcise coder from #fix-bug?" body="Work is reverted." confirmLabel="Exorcise coder from #fix-bug" busy={false} onConfirm={() => undefined} onCancel={() => undefined} {...props} />,
    );

  it("is a modal dialog labelled by its title and described by its body", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(new RegExp(`<h2 id="${labelledBy}"[^>]*>Exorcise coder from #fix-bug\\?</h2>`));
  });

  it("gives the confirm button an accessible name with agent and channel", () => {
    expect(render()).toContain('aria-label="Exorcise coder from #fix-bug"');
  });

  it("shows the backend error as an alert, and disables the buttons while busy", () => {
    const html = render({ error: "The bridge is reconnecting", busy: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The bridge is reconnecting");
    // aria-disabled, not disabled: a disabled button drops focus to the body and breaks the Tab trap and Escape.
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("keeps the buttons enabled and focusable when idle", () => {
    const html = render();
    expect(html.match(/aria-disabled="false"/g)).toHaveLength(2);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("names the fallback focus target and gives it to a heading that can take focus", () => {
    expect(FOCUS_FALLBACK_ID).toBe("channels-heading");
    const page = renderToStaticMarkup(<Dashboard state={null} summary={null} status={null} />);
    expect(page).toContain(`id="${FOCUS_FALLBACK_ID}"`);
    expect(page).toMatch(new RegExp(`<h2 id="${FOCUS_FALLBACK_ID}" tabindex="-1"`));
  });

  it("renders server text as text, not HTML", () => {
    const html = render({ title: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
