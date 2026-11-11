import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseNotice } from "../src/irc/notices.js";

const CS = "ChanServ!ChanServ@services.seance.local";
const SRV = "seance.local";
const chan = (text: string, prefix = CS, target = "#dev") => parseNotice({ prefix, target, text }, "crew");
const ops = (text: string, prefix = SRV, target = "crew") => parseNotice({ prefix, target, text }, "crew");

describe("ChanServ channel notices", () => {
  it("parses worktree ready", () => {
    expect(chan("worktree ready: workspaces/dev @ a1b2c3d")).toEqual({ kind: "worktree", dir: "workspaces/dev", sha: "a1b2c3d" });
  });

  it("parses agent ready", () => {
    expect(chan("coder is ready")).toEqual({ kind: "ready", agent: "coder" });
  });

  it("parses session closed and cancelled", () => {
    expect(chan("session closed, worktree reset to a1b2c3d")).toEqual({ kind: "closed", sha: "a1b2c3d", cancelled: false });
    expect(chan("session cancelled, worktree reset to deadbeef01")).toEqual({ kind: "closed", sha: "deadbeef01", cancelled: true });
  });

  it("parses both 'N file(s) reverted' and '1 file reverted'", () => {
    expect(chan("3 file(s) reverted · 0.12 credits used")).toEqual({ kind: "reverted", files: 3, credits: 0.12 });
    expect(chan("1 file reverted · 0.03 credits used")).toEqual({ kind: "reverted", files: 1, credits: 0.03 });
    expect(chan("2 files reverted · 1.50 credits used")).toEqual({ kind: "reverted", files: 2, credits: 1.5 });
  });

  it("parses commits", () => {
    expect(chan("coder committed a1b2c3d (2 file(s))")).toEqual({ kind: "commit", agent: "coder", sha: "a1b2c3d", files: 2 });
    expect(chan("coder committed a1b2c3d (1 file)")).toEqual({ kind: "commit", agent: "coder", sha: "a1b2c3d", files: 1 });
  });

  it("matches a service nick case-insensitively", () => {
    expect(chan("coder is ready", "chanserv!x@y")).toEqual({ kind: "ready", agent: "coder" });
  });

  it.each([
    "worktree ready: workspaces/dev @ XYZ",
    "worktree ready: workspaces/dev @ a1b2c3",
    "worktree ready: workspaces/dev @ a1b2c3d extra",
    "Worktree ready: workspaces/dev @ a1b2c3d",
    "session closed worktree reset to a1b2c3d",
    "x file(s) reverted · 0.12 credits used",
    "3 file(s) reverted · 0.1 credits used",
    "coder committed a1b2c3d",
    "coder committed zzzzzzz (2 file(s))",
    "coder is ready now",
    "hello",
    "",
  ])("does not match near-miss %j", (text) => {
    expect(chan(text)).toBeNull();
  });

  it("ignores channel-notice text from a user, from NickServ spoof lookalikes and with no prefix", () => {
    expect(chan("coder is ready", "mallory!m@evil")).toBeNull();
    expect(chan("coder is ready", "ChanServ2!x@y")).toBeNull();
    expect(parseNotice({ prefix: undefined, target: "#dev", text: "coder is ready" }, "crew")).toBeNull();
  });

  it("ignores channel patterns sent to a nick instead of a channel", () => {
    expect(chan("coder is ready", CS, "crew")).toBeNull();
  });
});

describe("ops notices", () => {
  it("parses a needs-op denial from a server prefix addressed to our nick", () => {
    expect(ops("ops: coder denied Run npm test: needs-op")).toEqual({
      kind: "denied",
      agent: "coder",
      action: "Run npm test",
      reason: "needs-op",
    });
  });

  it.each(["no-mode", "outside-worktree", "unclassified", "unresolved-path", "deny-list", "protected-path", "private-session"])(
    "parses reason %s",
    (reason) => {
      expect(ops(`ops: coder denied Write file: ${reason}`)).toMatchObject({ kind: "denied", reason });
    },
  );

  it("parses the trailing path detail", () => {
    expect(ops("ops: coder denied Edit .env: protected-path (/work/.env)")).toEqual({
      kind: "denied",
      agent: "coder",
      action: "Edit .env",
      reason: "protected-path",
      detail: "/work/.env",
    });
  });

  it("is case-insensitive about our nick but rejects other targets", () => {
    expect(ops("ops: coder denied X: needs-op", SRV, "CREW")).not.toBeNull();
    expect(ops("ops: coder denied X: needs-op", SRV, "other")).toBeNull();
    expect(ops("ops: coder denied X: needs-op", SRV, "#dev")).toBeNull();
  });

  it("ignores the same text from a user prefix or a service nick (forgery)", () => {
    expect(ops("ops: coder denied X: needs-op", "mallory!m@evil")).toBeNull();
    expect(ops("ops: coder denied X: needs-op", CS)).toBeNull();
    expect(ops("ops: coder denied X: needs-op", "ChanServ")).toBeNull();
    expect(parseNotice({ prefix: undefined, target: "crew", text: "ops: coder denied X: needs-op" }, "crew")).toBeNull();
  });

  it("rejects unknown reasons and malformed text", () => {
    expect(ops("ops: coder denied X: because")).toBeNull();
    expect(ops("ops: coder denied X needs-op")).toBeNull();
    expect(ops("note: coder denied X: needs-op")).toBeNull();
  });
});

describe("Property 5: notices cannot be forged", () => {
  it("a channel notice never parses when the prefix carries a user mask that is not a service nick", () => {
    const text = fc.constantFrom(
      "worktree ready: d @ a1b2c3d",
      "coder is ready",
      "session closed, worktree reset to a1b2c3d",
      "1 file reverted · 0.01 credits used",
      "coder committed a1b2c3d (1 file)",
    );
    const nick = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/).filter((n) => !["chanserv", "nickserv"].includes(n));
    fc.assert(fc.property(text, nick, (t, n) => parseNotice({ prefix: `${n}!u@h`, target: "#dev", text: t }, "crew") === null));
  });

  it("an ops notice never parses with a user-mask prefix", () => {
    const nick = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
    fc.assert(
      fc.property(nick, (n) => parseNotice({ prefix: `${n}!u@h`, target: "crew", text: "ops: coder denied X: needs-op" }, "crew") === null),
    );
  });
});
