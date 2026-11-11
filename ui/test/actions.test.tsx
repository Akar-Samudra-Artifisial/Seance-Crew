import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { callFor, channelError, createConfirmController, errorMessage, submitDismiss, submitSummon, successMessage, type PostApi } from "../src/actions.js";
import { AgentControls } from "../src/AgentControls.js";
import type { ConfirmRequest, ConfirmState } from "../src/confirmFlow.js";
import { Dashboard, IDLE_ACTIONS } from "../src/Dashboard.js";
import { Inbox } from "../src/Inbox.js";
import { SummonForm } from "../src/SummonForm.js";
import type { InboxView, State } from "../src/types.js";

interface Call {
  readonly path: string;
  readonly body: unknown;
}

function recorder(answer: (path: string) => unknown = () => ({ ok: true })): { api: PostApi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    api: {
      post: async (path, body) => {
        calls.push({ path, body });
        const out = answer(path);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

function controllerFor(api: PostApi) {
  const states: ConfirmState[] = [];
  const messages: string[] = [];
  const refresh = vi.fn();
  const controller = createConfirmController({ api, onState: (s) => states.push(s), onSuccess: (m) => messages.push(m), refresh });
  return { controller, states, messages, refresh };
}

const grant: ConfirmRequest = { kind: "grant", channel: "#fix-bug", agent: "coder", mode: "+o", inboxId: "i1" };

describe("confirm controller: nothing is sent without the user's confirm", () => {
  it("Grant op opens the dialog and sends nothing", () => {
    const { api, calls } = recorder();
    const { controller } = controllerFor(api);
    controller.open(grant);
    expect(controller.state()).toEqual({ phase: "confirming", request: grant });
    expect(calls).toEqual([]);
  });

  it("cancel sends nothing", async () => {
    const { api, calls } = recorder();
    const { controller } = controllerFor(api);
    controller.open(grant);
    controller.cancel();
    await controller.confirm();
    expect(controller.state().phase).toBe("idle");
    expect(calls).toEqual([]);
  });

  it("confirm posts confirm: true once, with the inbox id, then refreshes and reports success", async () => {
    const { api, calls } = recorder();
    const { controller, messages, refresh } = controllerFor(api);
    controller.open(grant);
    await controller.confirm();
    expect(calls).toEqual([{ path: "/apps/seance-crew/api/grant-op", body: { channel: "#fix-bug", agent: "coder", mode: "+o", confirm: true, inboxId: "i1" } }]);
    expect(messages).toEqual(["Applied +o to coder in #fix-bug."]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controller.state().phase).toBe("idle");
  });

  it("a confirm with no open dialog sends nothing", async () => {
    const { api, calls } = recorder();
    const { controller } = controllerFor(api);
    await controller.confirm();
    expect(calls).toEqual([]);
  });

  it("a double click on Confirm posts once", async () => {
    const { api, calls } = recorder();
    const { controller } = controllerFor(api);
    controller.open(grant);
    await Promise.all([controller.confirm(), controller.confirm()]);
    expect(calls).toHaveLength(1);
  });

  it("a mode change goes through the same dialog and posts the chosen mode", async () => {
    const { api, calls } = recorder();
    const { controller } = controllerFor(api);
    controller.open({ kind: "mode", channel: "#fix-bug", agent: "coder", mode: "-o" });
    expect(calls).toEqual([]);
    await controller.confirm();
    expect(calls).toEqual([{ path: "/apps/seance-crew/api/grant-op", body: { channel: "#fix-bug", agent: "coder", mode: "-o", confirm: true } }]);
  });

  it("exorcise posts confirm: true and reports whether the session closed", async () => {
    const { api, calls } = recorder(() => ({ ok: true, closed: true }));
    const { controller, messages } = controllerFor(api);
    controller.open({ kind: "exorcise", channel: "#fix-bug", agent: "coder" });
    expect(calls).toEqual([]);
    await controller.confirm();
    expect(calls).toEqual([{ path: "/apps/seance-crew/api/exorcise", body: { channel: "#fix-bug", agent: "coder", confirm: true } }]);
    expect(messages[0]).toContain("Exorcised coder from #fix-bug.");
    expect(messages[0]).toContain("session is closed");
  });

  it("keeps the dialog open with the backend message on failure, and a retry needs another confirm", async () => {
    let fail = true;
    const { api, calls } = recorder(() => (fail ? apiError(409, { error: { code: "not_registered", message: "The bridge is reconnecting, not registered" } }) : { ok: true }));
    const { controller, messages, refresh } = controllerFor(api);
    controller.open(grant);
    await controller.confirm();
    expect(controller.state()).toEqual({ phase: "failed", request: grant, message: "The bridge is reconnecting, not registered" });
    expect(messages).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    fail = false;
    await controller.confirm();
    expect(calls).toHaveLength(2);
    expect(controller.state().phase).toBe("idle");
  });

  it("callFor sets confirm: true only for these three request kinds", () => {
    for (const request of [grant, { kind: "mode", channel: "#a", agent: "x", mode: "+v" } as const, { kind: "exorcise", channel: "#a", agent: "x" } as const]) {
      expect(callFor(request).body["confirm"]).toBe(true);
    }
    expect(successMessage({ kind: "exorcise", channel: "#a", agent: "x" }, { closed: false })).toContain("did not report");
  });
});

describe("dismiss", () => {
  it("posts the id", async () => {
    const { api, calls } = recorder();
    expect(await submitDismiss(api, "i7")).toEqual({ ok: true });
    expect(calls).toEqual([{ path: "/apps/seance-crew/api/inbox/dismiss", body: { id: "i7" } }]);
  });

  it("returns the backend message on failure", async () => {
    const { api } = recorder(() => apiError(404, { error: { code: "not_found", message: "No open inbox item i7." } }));
    expect(await submitDismiss(api, "i7")).toEqual({ ok: false, message: "No open inbox item i7." });
  });
});

describe("summon", () => {
  it("posts the channel and, by default, no agent", async () => {
    const { api, calls } = recorder(() => ({ ready: true }));
    const outcome = await submitSummon(api, " #fix-bug ", "");
    expect(calls).toEqual([{ path: "/apps/seance-crew/api/summon", body: { channel: "#fix-bug" } }]);
    expect(outcome).toEqual({ ok: true, ready: true, message: "coder is ready in #fix-bug." });
  });

  it("posts a named agent", async () => {
    const { api, calls } = recorder(() => ({ ready: true }));
    await submitSummon(api, "#fix-bug", "reviewer");
    expect(calls[0]?.body).toEqual({ channel: "#fix-bug", agent: "reviewer" });
  });

  it("says the agent is still starting when ready is false", async () => {
    const { api } = recorder(() => ({ ready: false, waitedSec: 20 }));
    const outcome = await submitSummon(api, "#fix-bug", "");
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("coder is still starting in #fix-bug and will appear when ready.");
    expect(outcome.ok && outcome.ready).toBe(false);
  });

  it.each(["", "   ", "fix-bug", "#"])("rejects the channel %j without calling the backend", async (raw) => {
    const { api, calls } = recorder();
    const outcome = await submitSummon(api, raw, "");
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(channelError(raw)).not.toBeNull();
  });

  it("returns the backend error text", async () => {
    const { api } = recorder(() => apiError(409, { error: { code: "not_registered", message: "The bridge is connecting, not registered" } }));
    expect(await submitSummon(api, "#a", "")).toEqual({ ok: false, message: "The bridge is connecting, not registered" });
  });

  it("keeps the typed values in the form after a failure", () => {
    const html = renderToStaticMarkup(
      <SummonForm channel="#fix-bug" agent="reviewer" pending={false} message={{ ok: false, text: "The bridge is connecting, not registered" }} onChange={() => undefined} onSubmit={() => undefined} />,
    );
    expect(html).toContain('value="#fix-bug"');
    expect(html).toContain('value="reviewer"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Failed: The bridge is connecting, not registered");
  });

  it("shows progress and disables the button while pending", () => {
    const html = renderToStaticMarkup(<SummonForm channel="#a" agent="" pending message={null} onChange={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain("Summoning…");
    expect(html).toContain("disabled");
    expect(html).toContain("up to 30 seconds");
    expect(html).toContain('aria-busy="true"');
  });

  it("keeps the Summon button focusable while pending: aria-disabled, never the disabled attribute", () => {
    const render = (pending: boolean) => renderToStaticMarkup(<SummonForm channel="#a" agent="" pending={pending} message={null} onChange={() => undefined} onSubmit={() => undefined} />);
    const button = (html: string) => /<button [^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button(render(true))).toContain('aria-disabled="true"');
    expect(button(render(true))).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(button(render(false))).toContain('aria-disabled="false"');
    expect(button(render(false))).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("labels its fields", () => {
    const html = renderToStaticMarkup(<SummonForm channel="" agent="" pending={false} message={null} onChange={() => undefined} onSubmit={() => undefined} />);
    expect(html).toMatch(/<label for="[^"]+"[^>]*>Channel<\/label>/);
    expect(html).toMatch(/<label for="[^"]+"[^>]*>Agent \(optional\)<\/label>/);
    expect(html).toContain("must start with #");
  });
});

describe("errorMessage (SDK AppApiError: `API <status>: <body>`)", () => {
  it("shows the backend message from the JSON body", () => {
    expect(errorMessage(apiError(409, { error: { code: "not_registered", message: "The bridge is connecting, not registered" } }))).toBe("The bridge is connecting, not registered");
  });

  it("falls back to short non-JSON body text with the status", () => {
    expect(errorMessage(new Error("API 502: upstream unavailable"))).toBe("upstream unavailable (HTTP 502)");
  });

  it("does not show an HTML or empty body", () => {
    expect(errorMessage(new Error("API 404: <html><body>Not found</body></html>"))).toBe("The request failed (HTTP 404).");
    expect(errorMessage(new Error("API 500: "))).toBe("The request failed (HTTP 500).");
    expect(errorMessage(new Error(`API 500: ${"x".repeat(500)}`))).toBe("The request failed (HTTP 500).");
  });

  it("shows the message of the synchronous error for a path missing from permissions.api", () => {
    expect(errorMessage(new Error("Path /api/state is not allowed by permissions.api"))).toBe("Path /api/state is not allowed by permissions.api");
  });

  it("handles things that are not errors", () => {
    expect(errorMessage("nope")).toBe("The request failed.");
    expect(errorMessage(null)).toBe("The request failed.");
    expect(errorMessage(new Error(""))).toBe("The request failed.");
  });
});

const item = (patch: Partial<InboxView> = {}): InboxView => ({ id: "i1", channel: "#fix-bug", candidates: [], agent: "coder", action: "Run npm test", ts: 1_000, ...patch });

describe("Inbox", () => {
  const noop = () => undefined;
  const props = { now: 61_000, onGrant: noop, onDismiss: noop, pendingId: null, errors: {} };

  it("says so when the inbox is empty", () => {
    expect(renderToStaticMarkup(<Inbox items={[]} {...props} />)).toContain("No open permission requests.");
  });

  it("lists channel, agent, denied action and age", () => {
    const html = renderToStaticMarkup(<Inbox items={[item()]} {...props} />);
    expect(html).toContain("coder");
    expect(html).toContain("#fix-bug");
    expect(html).toContain("Run npm test");
    expect(html).toContain("Waiting 1 min");
  });

  it("gives the buttons accessible names with the agent and channel", () => {
    const html = renderToStaticMarkup(<Inbox items={[item()]} {...props} />);
    expect(html).toContain('aria-label="Grant op to coder in #fix-bug"');
    expect(html).toContain('aria-label="Dismiss the request from coder in #fix-bug"');
  });

  it("offers one Grant button per candidate when the channel is unknown", () => {
    const html = renderToStaticMarkup(<Inbox items={[item({ channel: null, candidates: ["#a", "#b"] })]} {...props} />);
    expect(html).toContain('aria-label="Grant op to coder in #a"');
    expect(html).toContain('aria-label="Grant op to coder in #b"');
  });

  it("offers no Grant button when the channel cannot be known", () => {
    const html = renderToStaticMarkup(<Inbox items={[item({ channel: null, candidates: [] })]} {...props} />);
    expect(html).not.toContain("Grant op to");
    expect(html).toContain("an unknown channel");
  });

  it("shows a per-item error and a pending state", () => {
    const html = renderToStaticMarkup(<Inbox items={[item()]} {...props} pendingId="i1" errors={{ i1: "No open inbox item i1." }} />);
    expect(html).toContain("Dismissing…");
    expect(html).toContain("Failed: No open inbox item i1.");
  });

  it("renders the denied action as text", () => {
    const html = renderToStaticMarkup(<Inbox items={[item({ action: "<script>x</script>", agent: "<b>a</b>" })]} {...props} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>a</b>");
  });
});

describe("AgentControls", () => {
  const noop = () => undefined;
  const render = (modes: string) => renderToStaticMarkup(<AgentControls agent={{ nick: "coder", modes, model: "m", ready: true }} channel="#fix-bug" onMode={noop} onExorcise={noop} />);

  it("names every button with the agent and the channel", () => {
    const labels = [...render("v").matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      expect(label).toContain("coder");
      expect(label).toContain("#fix-bug");
    }
    expect(labels).toContain("Exorcise coder from #fix-bug");
  });

  it("offers +v or +o with no modes, +o or -v with voice, and -o with op", () => {
    expect(render("")).toContain("Give +v to coder in #fix-bug");
    expect(render("")).toContain("Give +o to coder in #fix-bug");
    expect(render("v")).toContain("Give +o to coder in #fix-bug");
    expect(render("v")).toContain("Revoke -v from coder in #fix-bug");
    expect(render("o")).toContain("Revoke -o from coder in #fix-bug");
    expect(render("o")).not.toContain("Give +o");
  });
});

describe("Dashboard with actions", () => {
  const state: State = {
    bootId: "boot-1",
    revision: 1,
    serverTime: 61_000,
    bridge: { state: "registered", host: "h", nick: "crew" },
    channels: [{ name: "#fix-bug", topic: "", count: 2, credits: { used: null, total: null }, agents: [{ nick: "coder", modes: "v", model: "m", ready: true }], commits: [], lines: [] }],
    inbox: [item()],
    totalCredits: null,
    truncated: false,
  };

  it("renders the form, the inbox and the per-agent controls", () => {
    const html = renderToStaticMarkup(<Dashboard state={state} summary={null} status={null} />);
    expect(html).toContain("Summon an agent");
    expect(html).toContain("Needs op");
    expect(html).toContain('aria-label="Exorcise coder from #fix-bug"');
  });

  it("announces through one aria-live polite region and shows the notice once, without a second announcer", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={state}
        summary={null}
        status={null}
        announcement={{ id: 1, text: "New commit abc1234 by coder in #fix-bug." }}
        notice={{ id: 2, text: "Applied +o to coder in #fix-bug." }}
      />,
    );
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toMatch(/aria-live="polite"[^>]*><p>New commit abc1234 by coder in #fix-bug\.<\/p><p>Applied \+o to coder in #fix-bug\.<\/p><\/div>/);
    // The visible copy of the notice is not a live region or status role, so it is not read a second time.
    const visible = html.split("</div>").slice(1).join("</div>");
    expect(visible).toContain("Applied +o to coder in #fix-bug.</p>");
    expect(visible).not.toMatch(/role="status"[^>]*>Applied/);
  });

  it("shows nothing in the notice slot once it is cleared", () => {
    const html = renderToStaticMarkup(<Dashboard state={state} summary={null} status={null} notice={{ id: 3, text: "" }} />);
    expect(html).not.toContain("Applied");
  });

  it("shows the confirmation dialog only while a request is open", () => {
    const closed = renderToStaticMarkup(<Dashboard state={state} summary={null} status={null} />);
    expect(closed).not.toContain('role="dialog"');
    const open = renderToStaticMarkup(
      <Dashboard state={state} summary={null} status={null} actions={{ ...IDLE_ACTIONS, confirm: { phase: "confirming", request: grant } }} />,
    );
    expect(open).toContain('role="dialog"');
    expect(open).toContain("Grant +o to coder in #fix-bug?");
    expect(open).toContain("edit files and run commands");
  });

  it("shows the backend error inside the dialog after a failed confirm", () => {
    const html = renderToStaticMarkup(
      <Dashboard state={state} summary={null} status={null} actions={{ ...IDLE_ACTIONS, confirm: { phase: "failed", request: grant, message: "The server refused the mode change (482)." } }} />,
    );
    expect(html).toContain("Failed: The server refused the mode change (482).");
  });
});

/** What the SDK throws for a non-2xx answer: AppApiError with message `API <status>: <body>`. */
function apiError(status: number, body: unknown): Error {
  return Object.assign(new Error(`API ${status}: ${JSON.stringify(body)}`), { status });
}
