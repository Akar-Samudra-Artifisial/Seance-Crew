import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/Dashboard.js";
import { ChannelCard } from "../src/ChannelCard.js";
import { formatAge, formatCredits, formatUsage, modeChangesFor, modeLabel } from "../src/format.js";
import { LogPanel } from "../src/LogPanel.js";
import { BANNER, StatusBanner } from "../src/StatusBanner.js";
import { SummaryCard } from "../src/SummaryCard.js";
import type { BridgeState, ChannelView, State, Summary } from "../src/types.js";

const channel = (patch: Partial<ChannelView> = {}): ChannelView => ({
  name: "#fix-bug",
  topic: "fix the bug",
  count: 3,
  credits: { used: 1.5, total: 10 },
  agents: [
    { nick: "coder", modes: "o", model: "claude", ready: true },
    { nick: "reviewer", modes: "v", model: "", ready: false },
    { nick: "helper", modes: "", model: "m", ready: true },
  ],
  commits: [
    { agent: "coder", sha: "abc1234", files: 2, ts: 1_700_000_000_000 },
    { agent: "coder", sha: "def5678", files: 1, ts: 1_700_000_060_000 },
  ],
  lines: [
    { seq: 1, ts: 1_700_000_000_000, from: "coder", kind: "privmsg", text: "hello" },
    { seq: 2, ts: 1_700_000_001_000, from: "ChanServ", kind: "notice", text: "ready" },
  ],
  ...patch,
});

const state = (patch: Partial<State> = {}): State => ({
  bootId: "boot-1",
  revision: 1,
  serverTime: 1,
  bridge: { state: "registered", host: "irc.example.org", nick: "crew" },
  channels: [channel()],
  inbox: [],
  totalCredits: 1.5,
  truncated: false,
  ...patch,
});

describe("StatusBanner", () => {
  const states: BridgeState[] = ["registered", "connecting", "reconnecting", "unconfigured", "auth-failed", "nick-rejected", "config-invalid", "duplicate-instance"];

  it.each(states)("shows a message for the bridge state %s", (bridgeState) => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: bridgeState, host: "irc.example.org", nick: "crew" }} status={null} />);
    expect(html).toContain(BANNER[bridgeState].label);
    expect(html).toContain(BANNER[bridgeState].message({ state: bridgeState, host: "irc.example.org", nick: "crew" }).replace(/&/g, "&amp;"));
    // The level is a word and an icon, not only a colour.
    expect(html).toContain('aria-hidden="true"');
  });

  it.each(["unconfigured", "auth-failed"] as const)("tells the user to check host, nick and secret for %s", (bridgeState) => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: bridgeState, host: "", nick: "" }} status={null} />);
    expect(html).toContain("Check host, nick and secret in the app settings.");
  });

  it("names the host and nick when registered", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "registered", host: "irc.example.org", nick: "crew" }} status={{ ok: true, lastSuccess: 1 }} />);
    expect(html).toContain("Connected to irc.example.org as crew.");
    expect(html).not.toContain("Connection to the app lost");
  });

  it("shows the lost-connection notice with the last success time", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={null} status={{ ok: false, lastSuccess: 1_700_000_000_000 }} />);
    expect(html).toContain("Connection to the app lost.");
    expect(html).toContain("Last update at");
    expect(html).toContain('role="alert"');
  });

  it("says so when there was never a successful update", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={null} status={{ ok: false, lastSuccess: null }} />);
    expect(html).toContain("No successful update yet.");
  });
});

describe("ChannelCard", () => {
  const html = renderToStaticMarkup(<ChannelCard channel={channel()} />);

  it("shows name, topic, member count and credits with two decimals", () => {
    expect(html).toContain("#fix-bug");
    expect(html).toContain("Topic: fix the bug");
    expect(html).toContain("3 members");
    expect(html).toContain("1.50 of 10.00");
  });

  it("shows agents with modes as text and icon, model and ready state", () => {
    expect(html).toContain("Modes: +o operator");
    expect(html).toContain("Modes: +v voice");
    expect(html).toContain("Modes: no modes");
    expect(html).toContain("Model: claude");
    expect(html).toContain("Model: unknown");
    expect(html).toContain("Ready");
    expect(html).toContain("Starting");
  });

  it("shows the commits newest first with short sha and file counts", () => {
    expect(html.indexOf("def5678")).toBeGreaterThan(-1);
    expect(html.indexOf("def5678")).toBeLessThan(html.indexOf("abc1234"));
    expect(html).toContain("2 files");
    expect(html).toContain("1 file,");
  });

  it("shows n/a for unknown credits and empty states for no agents and no commits", () => {
    const bare = renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: null, total: null }, agents: [], commits: [], topic: "" })} />);
    expect(bare).toContain("Credits used: n/a");
    expect(bare).toContain("No agents in this channel.");
    expect(bare).toContain("No commits yet.");
    expect(bare).not.toContain("Topic:");
  });

  it("shows a used figure without a total", () => {
    expect(renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: 2, total: null } })} />)).toContain("Credits used: 2.00");
  });

  it("escapes HTML in the topic, nicks and log text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const out = renderToStaticMarkup(
      <ChannelCard
        channel={channel({
          topic: evil,
          agents: [{ nick: "<b>x</b>", modes: "", model: evil, ready: true }],
          lines: [{ seq: 1, ts: 1, from: "<i>bob</i>", kind: "privmsg", text: `<script>alert(1)</script>${evil}` }],
        })}
      />,
    );
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<b>x</b>");
    expect(out).not.toContain("<i>bob</i>");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("LogPanel", () => {
  it("labels the panel as untrusted channel text and lists lines oldest first", () => {
    const out = renderToStaticMarkup(<LogPanel channel="#fix-bug" lines={channel().lines} />);
    expect(out).toContain("Untrusted channel text");
    expect(out).toContain("<details>");
    expect(out.indexOf("hello")).toBeLessThan(out.indexOf("ready"));
    expect(out).toContain("(2 lines)");
    expect(out).toContain("<span>ChanServ</span> (notice): <span>ready</span>");
  });

  it("says so when there are no lines", () => {
    expect(renderToStaticMarkup(<LogPanel channel="#a" lines={[]} />)).toContain("No lines yet.");
  });
});

describe("SummaryCard", () => {
  const summary: Summary = { date: "2026-11-10", generatedAt: 1, totalCredits: 4.5, channels: [{ name: "#a", used: 3, total: 10 }, { name: "#b", used: 1.5, total: null }], stale: false };

  it("says 'No summary yet' when there is none", () => {
    expect(renderToStaticMarkup(<SummaryCard summary={null} />)).toContain("No summary yet");
  });

  it("shows loading before the first answer", () => {
    expect(renderToStaticMarkup(<SummaryCard summary={undefined} />)).toContain("Loading summary");
  });

  it("renders date, total and credits per channel", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={summary} />);
    expect(out).toContain("2026-11-10: total credits 4.50.");
    expect(out).toContain("#a: 3.00 of 10.00");
    expect(out).toContain("#b: 1.50");
    expect(out).not.toContain("not refreshed");
  });

  it("notes stale figures and escapes channel names", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={{ ...summary, stale: true, channels: [{ name: "<u>x</u>", used: 1, total: null }] }} />);
    expect(out).toContain("not refreshed");
    expect(out).not.toContain("<u>");
  });
});

describe("Dashboard", () => {
  it("shows an empty state that explains how to summon", () => {
    const out = renderToStaticMarkup(<Dashboard state={state({ channels: [] })} summary={null} status={{ ok: true, lastSuccess: 1 }} />);
    expect(out).toContain("No channels yet.");
    expect(out).toContain("summon an agent");
  });

  it("renders one card per channel and the total credits", () => {
    const out = renderToStaticMarkup(<Dashboard state={state({ channels: [channel(), channel({ name: "#other" })] })} summary={null} status={null} />);
    expect(out).toContain("#fix-bug");
    expect(out).toContain("#other");
    expect(out).toContain("Total credits");
    expect(out).toContain("1.50");
  });

  it("shows n/a for the total when unknown, and loading before the first state", () => {
    expect(renderToStaticMarkup(<Dashboard state={state({ totalCredits: null })} summary={null} status={null} />)).toContain("n/a");
    expect(renderToStaticMarkup(<Dashboard state={null} summary={undefined} status={null} />)).toContain("Loading channels");
  });

  it("mentions truncated logs", () => {
    expect(renderToStaticMarkup(<Dashboard state={state({ truncated: true })} summary={null} status={null} />)).toContain("older log lines were left out");
  });

  it("never uses dangerouslySetInnerHTML and carries no forbidden word", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "src");
    const forbidden = new RegExp(["m", "irc"].join(""), "i");
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toContain("dangerouslySetInnerHTML");
      expect(forbidden.test(text), name).toBe(false);
    }
  });
});

describe("format helpers", () => {
  it("formats credits with two decimals or n/a", () => {
    expect(formatCredits(1.5)).toBe("1.50");
    expect(formatCredits(0)).toBe("0.00");
    expect(formatCredits(null)).toBe("n/a");
    expect(formatCredits(undefined)).toBe("n/a");
    expect(formatCredits(Number.NaN)).toBe("n/a");
    expect(formatUsage(null, 5)).toBe("n/a");
    expect(formatUsage(1, null)).toBe("1.00");
  });

  it("formats ages", () => {
    expect(formatAge(5_000)).toBe("5 s");
    expect(formatAge(180_000)).toBe("3 min");
    expect(formatAge(7_200_000)).toBe("2 h");
    expect(formatAge(172_800_000)).toBe("2 d");
    expect(formatAge(-5)).toBe("0 s");
  });

  it("labels modes and offers the next changes, +v first", () => {
    expect(modeLabel("o").text).toBe("+o operator");
    expect(modeLabel("ov").text).toContain("+o");
    expect(modeLabel("").icon).toBeTruthy();
    expect(modeChangesFor("")).toEqual(["+v", "+o"]);
    expect(modeChangesFor("v")).toEqual(["+o", "-v"]);
    expect(modeChangesFor("o")).toEqual(["-o"]);
  });
});
