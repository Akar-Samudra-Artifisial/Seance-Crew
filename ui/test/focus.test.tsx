import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createConfirmController, type PostApi } from "../src/actions.js";
import { AgentControls } from "../src/AgentControls.js";
import { ChannelCard } from "../src/ChannelCard.js";
import type { ConfirmRequest, ConfirmState } from "../src/confirmFlow.js";
import { Dashboard, IDLE_ACTIONS } from "../src/Dashboard.js";
import { agentRowId, applyFocus, CHANNELS_HEADING_ID, channelHeadingId, controlId, focusCandidates, type FocusableDocument } from "../src/focus.js";
import { Inbox } from "../src/Inbox.js";
import type { AgentView, ChannelView, InboxView, State } from "../src/types.js";

const noop = () => undefined;
const CH = "#fix-bug";

const agent = (modes: string): AgentView => ({ nick: "coder", modes, model: "m", ready: true });
const channel = (agents: AgentView[]): ChannelView => ({ name: CH, topic: "", count: agents.length + 1, credits: { used: null, total: null }, agents, commits: [], lines: [] });

/** Ids present in a rendered page. */
const idsIn = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? "");

const stateWith = (agents: AgentView[], inbox: InboxView[] = []): State => ({
  bootId: "b",
  revision: 1,
  serverTime: 1_000,
  bridge: { state: "registered", host: "h", nick: "crew" },
  channels: [channel(agents)],
  inbox,
  totalCredits: null,
  truncated: false,
});

const page = (agents: AgentView[], confirm?: ConfirmState): string =>
  renderToStaticMarkup(<Dashboard state={stateWith(agents)} summary={null} status={null} actions={confirm === undefined ? IDLE_ACTIONS : { ...IDLE_ACTIONS, confirm }} />);

describe("focusCandidates", () => {
  it("after a mode change: the replacement control first, then the agent row, the channel heading and the Channels heading", () => {
    expect(focusCandidates({ kind: "mode", channel: CH, agent: "coder", mode: "+o" })).toEqual([
      controlId(CH, "coder", "-o"),
      agentRowId(CH, "coder"),
      channelHeadingId(CH),
      CHANNELS_HEADING_ID,
    ]);
    expect(focusCandidates({ kind: "mode", channel: CH, agent: "coder", mode: "-o" })[0]).toBe(controlId(CH, "coder", "+o"));
    expect(focusCandidates({ kind: "mode", channel: CH, agent: "coder", mode: "+v" })[0]).toBe(controlId(CH, "coder", "-v"));
    expect(focusCandidates({ kind: "mode", channel: CH, agent: "coder", mode: "-v" })[0]).toBe(controlId(CH, "coder", "+v"));
  });

  it("a grant from the inbox is a +o: focus the Revoke -o control", () => {
    expect(focusCandidates({ kind: "grant", channel: CH, agent: "coder", mode: "+o", inboxId: "i1" })[0]).toBe(controlId(CH, "coder", "-o"));
  });

  it("after an exorcise: the Exorcise button if the agent is still listed, otherwise the channel card heading", () => {
    expect(focusCandidates({ kind: "exorcise", channel: CH, agent: "coder" })).toEqual([controlId(CH, "coder", "x"), channelHeadingId(CH), CHANNELS_HEADING_ID]);
  });

  it("keeps ids free of characters that would break an id lookup", () => {
    for (const id of focusCandidates({ kind: "mode", channel: "#a b\"c", agent: "x y", mode: "+v" })) expect(id).toMatch(/^[A-Za-z0-9%_.~!*'()-]+$/);
  });
});

describe("the candidate ids exist in the page after the change", () => {
  const request = (r: ConfirmRequest): readonly string[] => focusCandidates(r);

  it("Give +o on a voiced agent: the new Revoke -o control is the first candidate and is rendered", () => {
    const before = idsIn(page([agent("v")]));
    const after = idsIn(page([agent("vo")]));
    const [first] = request({ kind: "mode", channel: CH, agent: "coder", mode: "+o" });
    expect(before).not.toContain(first);
    expect(after).toContain(first);
  });

  it("Revoke -o: the Give +o control is rendered afterwards", () => {
    const [first] = request({ kind: "mode", channel: CH, agent: "coder", mode: "-o" });
    expect(idsIn(page([agent("o")]))).not.toContain(first);
    expect(idsIn(page([agent("v")]))).toContain(first);
  });

  it("every agent row can take programmatic focus", () => {
    const html = page([agent("v")]);
    expect(html).toMatch(new RegExp(`<li id="${agentRowId(CH, "coder")}" tabindex="-1"`));
  });

  it("exorcise: with the agent gone, the first existing candidate is the channel card heading, which has tabindex -1", () => {
    const html = page([]);
    const ids = idsIn(html);
    const existing = request({ kind: "exorcise", channel: CH, agent: "coder" }).filter((id) => ids.includes(id));
    expect(existing[0]).toBe(channelHeadingId(CH));
    expect(html).toMatch(new RegExp(`<h3 id="${channelHeadingId(CH)}" tabindex="-1"`));
  });

  it("exorcise: while the agent is still listed, the Exorcise button is the first existing candidate", () => {
    const ids = idsIn(page([agent("v")]));
    expect(request({ kind: "exorcise", channel: CH, agent: "coder" }).filter((id) => ids.includes(id))[0]).toBe(controlId(CH, "coder", "x"));
  });

  it("the channel heading is a heading with the channel name", () => {
    expect(renderToStaticMarkup(<ChannelCard channel={channel([])} />)).toMatch(/<h3 id="[^"]+" tabindex="-1"[^>]*>#fix-bug<\/h3>/);
  });
});

describe("applyFocus", () => {
  const fakeDoc = (present: string[], active: unknown = null) => {
    const body = { name: "body" };
    const focused: string[] = [];
    const doc: FocusableDocument = {
      body,
      activeElement: active === "body" ? body : active,
      getElementById: (id) => (present.includes(id) ? { focus: () => focused.push(id) } : null),
    };
    return { doc, focused };
  };

  it("focuses the first candidate that exists", () => {
    const { doc, focused } = fakeDoc(["b", "c"], "body");
    expect(applyFocus(doc, ["a", "b", "c"])).toBe("b");
    expect(focused).toEqual(["b"]);
  });

  it("also works when nothing is focused at all", () => {
    const { doc, focused } = fakeDoc(["a"], null);
    expect(applyFocus(doc, ["a"])).toBe("a");
    expect(focused).toEqual(["a"]);
  });

  it("does nothing when none exists", () => {
    const { doc, focused } = fakeDoc([], "body");
    expect(applyFocus(doc, ["a", "b"])).toBeNull();
    expect(focused).toEqual([]);
  });

  it("does not steal focus from an element the user is on", () => {
    const { doc, focused } = fakeDoc(["a"], { name: "input" });
    expect(applyFocus(doc, ["a"])).toBeNull();
    expect(focused).toEqual([]);
  });
});

describe("the controller hands the succeeded request to the page", () => {
  it("calls onSuccess with the message and the request, after the dialog closed", async () => {
    const api: PostApi = { post: vi.fn(async () => ({ ok: true })) };
    const seen: Array<{ message: string; request: ConfirmRequest }> = [];
    const states: ConfirmState[] = [];
    const controller = createConfirmController({ api, onState: (s) => states.push(s), onSuccess: (message, request) => seen.push({ message, request }), refresh: noop });
    const request: ConfirmRequest = { kind: "mode", channel: CH, agent: "coder", mode: "+o" };
    controller.open(request);
    await controller.confirm();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toEqual(request);
    expect(states.at(-1)).toEqual({ phase: "idle" });
  });

  it("does not call onSuccess when the request fails", async () => {
    const api: PostApi = { post: vi.fn(async () => { throw new Error("nope"); }) };
    const onSuccess = vi.fn();
    const controller = createConfirmController({ api, onState: noop, onSuccess, refresh: noop });
    controller.open({ kind: "exorcise", channel: CH, agent: "coder" });
    await controller.confirm();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("triggers are aria-disabled while the request runs", () => {
  const render = (busy: boolean, modes = "v") => renderToStaticMarkup(<AgentControls agent={agent(modes)} channel={CH} onMode={noop} onExorcise={noop} busy={busy} />);

  it("AgentControls: every button is aria-disabled when busy, none otherwise, and none uses the disabled attribute", () => {
    const busyHtml = render(true);
    const buttons = busyHtml.match(/<button /g)?.length ?? 0;
    expect(buttons).toBe(3);
    expect(busyHtml.match(/aria-disabled="true"/g)).toHaveLength(buttons);
    expect(busyHtml).not.toMatch(/\sdisabled(=|\s|>)/);
    const idle = render(false);
    expect(idle.match(/aria-disabled="false"/g)).toHaveLength(buttons);
    expect(idle).not.toContain('aria-disabled="true"');
  });

  it("a busy button does not open the dialog", () => {
    const onMode = vi.fn();
    const onExorcise = vi.fn();
    const tree = AgentControls({ agent: agent("v"), channel: CH, onMode, onExorcise, busy: true }) as unknown as { props: { children: unknown[] } };
    const [modes, exorcise] = tree.props.children as [Array<{ props: { onClick: () => void } }>, { props: { onClick: () => void } }];
    for (const b of modes) b.props.onClick();
    exorcise.props.onClick();
    expect(onMode).not.toHaveBeenCalled();
    expect(onExorcise).not.toHaveBeenCalled();
  });

  it("Dashboard: only the agent of the in-flight request is aria-disabled", () => {
    const other: AgentView = { nick: "reviewer", modes: "", model: "m", ready: true };
    const html = renderToStaticMarkup(
      <Dashboard
        state={stateWith([agent("v"), other])}
        summary={null}
        status={null}
        actions={{ ...IDLE_ACTIONS, confirm: { phase: "submitting", request: { kind: "exorcise", channel: CH, agent: "coder" } } }}
      />,
    );
    const coderButtons = [...html.matchAll(/<button [^>]*aria-label="[^"]*(?:coder)[^"]*"[^>]*>/g)].map((m) => m[0]).filter((b) => b.includes(`id="ctl-`));
    expect(coderButtons.length).toBe(3);
    for (const b of coderButtons) expect(b).toContain('aria-disabled="true"');
    const reviewerButtons = [...html.matchAll(/<button [^>]*aria-label="[^"]*reviewer[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(reviewerButtons.length).toBe(3);
    for (const b of reviewerButtons) expect(b).toContain('aria-disabled="false"');
  });

  it("Dashboard: nothing is disabled while the dialog only asks", () => {
    const html = page([agent("v")], { phase: "confirming", request: { kind: "exorcise", channel: CH, agent: "coder" } });
    const triggers = [...html.matchAll(/<button [^>]*id="ctl-[^>]*>/g)].map((m) => m[0]);
    expect(triggers.length).toBe(3);
    for (const b of triggers) expect(b).toContain('aria-disabled="false"');
  });

  it("Inbox: the Grant buttons of the item being granted are aria-disabled", () => {
    const item: InboxView = { id: "i1", ts: 0, agent: "coder", channel: CH, candidates: [], action: "edit" };
    const props = { items: [item], now: 1_000, onGrant: noop, onDismiss: noop, pendingId: null, errors: {} };
    const grant = (html: string) => /<button [^>]*aria-label="Grant op to coder in #fix-bug"[^>]*>/.exec(html)?.[0] ?? "";
    expect(grant(renderToStaticMarkup(<Inbox {...props} grantingId="i1" />))).toContain('aria-disabled="true"');
    expect(grant(renderToStaticMarkup(<Inbox {...props} grantingId={null} />))).toContain('aria-disabled="false"');
    expect(grant(renderToStaticMarkup(<Inbox {...props} />))).toContain('aria-disabled="false"');
  });
});
