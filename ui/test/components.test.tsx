import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHANNEL_PLACEHOLDERS, Dashboard, IDLE_ACTIONS } from "../src/Dashboard.js";
import { ChannelCard, lastActivity } from "../src/ChannelCard.js";
import { formatAge, formatAgo, formatCredits, formatUsage, modeChangesFor, modeLabel } from "../src/format.js";
import { confirmCopy, type ConfirmRequest } from "../src/confirmFlow.js";
import { TILES_CSS, TILES_NARROW_PX, TILES_WIDE_PX } from "../src/styles.js";
import { ICON_NAMES, Icon } from "../src/Icon.js";
import { overviewStats, TILE_COUNT } from "../src/StatTiles.js";
import { Button, EmptyState, Meter, Pill } from "../src/ui.js";
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

  it("shows a slim status line when connected: word, host as nick, and how long ago the last update was", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "registered", host: "irc.example.org", nick: "crew" }} status={{ ok: true, lastSuccess: 1_000 }} now={6_000} />);
    expect(html).toContain("<strong>Connected</strong>");
    expect(html).toContain("irc.example.org as crew");
    expect(html).toContain("updated 5 s ago");
    expect(html).not.toContain("Connection to the app lost");
    expect(html).not.toContain("border-left");
  });

  it("keeps the full banner with its action text for states that are not ok", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "auth-failed", host: "h", nick: "n" }} status={{ ok: true, lastSuccess: 1 }} />);
    expect(html).toContain("border-left");
    expect(html).toContain("<strong>Sign-in failed.</strong>");
    expect(html).not.toContain("updated");
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
  const NOW = 1_700_000_181_000; // 3 min after the newest line
  const html = renderToStaticMarkup(<ChannelCard channel={channel()} now={NOW} />);

  it("shows name, topic (with a title), member and agent pills, and credits with two decimals", () => {
    expect(html).toMatch(/<h3 id="[^"]+" tabindex="-1"[^>]*>#fix-bug<\/h3>/);
    expect(html).toContain("Topic: </span>fix the bug");
    expect(html).toContain('title="fix the bug"');
    expect(html).toContain("3 members");
    expect(html).toContain("3 agents");
    expect(html).toContain("1.50 of 10.00");
  });

  it("shows the last activity from the newest log line, and hides it without lines", () => {
    expect(html).toContain("active 3 min ago");
    expect(renderToStaticMarkup(<ChannelCard channel={channel({ lines: [] })} now={NOW} />)).not.toContain("active ");
    expect(lastActivity(channel(), NOW)).toBe(180_000);
    expect(lastActivity(channel({ lines: [] }), NOW)).toBeNull();
  });

  it("draws a credits meter with its aria values", () => {
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="1.5"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-valuetext="1.50 of 10.00 credits used"');
    expect(html).toContain("width:15.0%");
  });

  it("omits the meter when the total is unknown", () => {
    const out = renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: 2, total: null } })} now={NOW} />);
    expect(out).toContain("2.00");
    expect(out).not.toContain('role="meter"');
  });

  it("shows agents with modes as text and icon, model and ready state", () => {
    expect(html).toContain("Modes: </span>+o operator");
    expect(html).toContain("Modes: </span>+v voice");
    expect(html).toContain("Modes: </span>no modes");
    expect(html).toContain("Model: </span>claude");
    expect(html).toContain("Model: </span>unknown model");
    expect(html).toContain("Ready");
    expect(html).toContain("Starting");
    // The text glyphs are gone in favour of SVG icons; the words stay.
    for (const glyph of ["◆", "◇", "○", "✔", "◌", "⚠"]) expect(html).not.toContain(glyph);
  });

  it("shows the commits newest first with a mono sha pill, file counts and a relative age with the absolute time as title", () => {
    expect(html.indexOf("def5678")).toBeGreaterThan(-1);
    expect(html.indexOf("def5678")).toBeLessThan(html.indexOf("abc1234"));
    expect(html).toContain("2 files");
    expect(html).toContain("1 file<");
    expect(html).toMatch(/<time dateTime="[^"]+" title="[^"]+"[^>]*>2 min ago<\/time>/);
  });

  it("shows at most 5 commit rows, newest first, and says how many the backend keeps", () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({ agent: "coder", sha: `aaaa00${i}`, files: 1, ts: 1_700_000_000_000 + i }));
    const out = renderToStaticMarkup(<ChannelCard channel={channel({ commits, commitCount: 12 })} now={NOW} />);
    expect(out.match(/aaaa00\d/g)).toHaveLength(5);
    expect(out).toContain("aaaa006"); // newest first
    expect(out).not.toContain("aaaa000");
    // No toggle that has nothing more to show: the text names the real total instead.
    expect(out).toContain("Showing the newest 5 of 12 commits.");
    expect(out).not.toContain("Show all");
    expect(out).not.toContain("aria-expanded");
    expect(html).not.toContain("Showing the newest");
  });

  it("keys equal commits apart: two commits with the same sha and time both render", () => {
    const twin = { agent: "coder", sha: "samesha", files: 1, ts: 5 };
    const out = renderToStaticMarkup(<ChannelCard channel={channel({ commits: [twin, twin] })} now={NOW} />);
    expect(out.match(/samesha/g)).toHaveLength(2);
  });

  it("counts every commit the backend keeps in the Commits tile, with a fallback for an older backend", () => {
    const withCount = state({ channels: [channel({ commitCount: 12 }), channel({ name: "#b", commitCount: 3, commits: [] })] });
    expect(overviewStats(withCount).commits).toBe(15);
    const older = state({ channels: [channel()] }); // no commitCount: the 2 rows it has
    expect(overviewStats(older).commits).toBe(2);
  });

  it("shows n/a for unknown credits and empty states for no agents and no commits", () => {
    const bare = renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: null, total: null }, agents: [], commits: [], lines: [], topic: "" })} now={NOW} />);
    expect(bare).toContain("n/a");
    expect(bare).not.toContain('role="meter"');
    expect(bare).toContain("No agents in this channel");
    expect(bare).toContain("No commits yet");
    expect(bare).toContain("No lines yet");
    expect(bare).not.toContain("Topic:");
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
    expect(out).toContain("<details open=\"\">"); // open by default; the summary still toggles it
    expect(out).toContain("<summary");
    expect(out).toContain("Recent log");
    expect(out.indexOf("hello")).toBeLessThan(out.indexOf("ready"));
    expect(out).toContain("2 lines");
  });

  it("renders each line as time | sender and text, other kinds muted italic with the kind named", () => {
    const out = renderToStaticMarkup(<LogPanel channel="#fix-bug" lines={channel().lines} />);
    expect(out).toContain("<strong>coder</strong> <span>hello</span>");
    expect(out).toMatch(/font-style:italic"><strong>ChanServ<\/strong> \(notice\) <span>ready<\/span>/);
    expect(out).toMatch(/<time dateTime="[^"]+" style="[^"]*">\d\d:\d\d:\d\d<\/time>/);
  });

  it("says so when there are no lines", () => {
    expect(renderToStaticMarkup(<LogPanel channel="#a" lines={[]} />)).toContain("No lines yet");
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

  it("renders the date heading, the total and label/value rows per channel", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={summary} />);
    expect(out).toMatch(/<h3[^>]*>2026-11-10<\/h3>/);
    expect(out).toMatch(/<span>Total credits<\/span><span style="[^"]*tabular-nums[^"]*">4.50<\/span>/);
    expect(out).toMatch(/<span[^>]*>#a<\/span><span style="[^"]*">3.00 of 10.00<\/span>/);
    expect(out).toMatch(/<span[^>]*>#b<\/span><span style="[^"]*">1.50<\/span>/);
    expect(out).not.toContain("not refreshed");
    expect(out).not.toContain("Stale");
  });

  it("notes stale figures with a pill and escapes channel names", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={{ ...summary, stale: true, channels: [{ name: "<u>x</u>", used: 1, total: null }] }} />);
    expect(out).toContain("not refreshed");
    expect(out).toContain("Stale");
    expect(out).not.toContain("<u>");
  });
});

describe("Dashboard", () => {
  it("shows an empty state that explains how to summon", () => {
    const out = renderToStaticMarkup(<Dashboard state={state({ channels: [] })} summary={null} status={{ ok: true, lastSuccess: 1 }} />);
    expect(out).toContain("No channels yet");
    expect(out).toContain("Summon an agent into a channel whose name starts with #, e.g. #fix-bug");
  });

  it("shows the overview tiles with values from the state", () => {
    const fixture = state({
      channels: [channel(), channel({ name: "#other", agents: [{ nick: "coder", modes: "o", model: "m", ready: false }], commits: [] })],
      inbox: [{ id: "i1", channel: "#fix-bug", candidates: [], agent: "coder", action: "edit", ts: 1 }],
      totalCredits: 2.5,
    });
    expect(overviewStats(fixture)).toEqual({ channels: 2, agentsReady: 2, agentsTotal: 4, operators: 2, needsOp: 1, totalCredits: 2.5, commits: 2 });
    const out = renderToStaticMarkup(<Dashboard state={fixture} summary={null} status={null} />);
    const tiles = out.slice(out.indexOf('aria-label="Overview"'));
    for (const [label, value] of [["Channels", "2"], ["Agents ready", "2 / 4"], ["Operators", "2"], ["Needs op", "1"], ["Total credits", "2.50"], ["Commits", "2"]]) {
      expect(tiles).toMatch(new RegExp(`</svg>${label}</span><p style="[^"]*">${value}</p>`));
    }
    // Needs op > 0 gets the warn border; with nothing open it stays neutral.
    expect(tiles).toMatch(/border-color:#f59e0b[^>]*><span[^>]*><svg[^>]*>[\s\S]*?<\/svg>Needs op/);
    const calm = renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />);
    expect(calm.slice(calm.indexOf('aria-label="Overview"'), calm.indexOf("</section>", calm.indexOf('aria-label="Overview"')))).not.toContain("#f59e0b");
  });

  it("lays out channels and the aside as two wrapping columns, the aside with Needs op first", () => {
    const out = renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />);
    expect(out).toContain("flex-wrap:wrap");
    expect(out).toContain("flex:999 1 34rem");
    expect(out).toContain("flex:1 1 20rem");
    const aside = out.slice(out.indexOf("<aside"));
    expect(aside.indexOf("Needs op")).toBeLessThan(aside.indexOf("Summon an agent"));
    expect(aside.indexOf("Summon an agent")).toBeLessThan(aside.indexOf("Daily summary"));
  });

  it("shows skeletons and a hidden loading text before the first state", () => {
    const out = renderToStaticMarkup(<Dashboard state={null} summary={undefined} status={null} />);
    expect(out).toContain("Loading channels…");
    const overview = out.slice(out.indexOf('aria-label="Overview"'), out.indexOf("</section>", out.indexOf('aria-label="Overview"')));
    expect(overview.match(/<div aria-hidden="true"/g)).toHaveLength(TILE_COUNT);
    const channels = out.slice(out.indexOf('id="channels-heading"'));
    expect(channels.match(/<div aria-hidden="true" style="background/g)?.length).toBeGreaterThanOrEqual(CHANNEL_PLACEHOLDERS);
  });

  it("carries a visible focus ring rule scoped to the page", () => {
    const out = renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />);
    expect(out).toContain("<div data-seance=\"\"><style>");
    expect(out).toContain(":focus-visible{outline:2px solid");
    expect(out).toContain("outline-offset:2px");
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

  it("formats relative ages", () => {
    expect(formatAgo(180_000)).toBe("3 min ago");
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

describe("Icon", () => {
  it.each(ICON_NAMES)("%s renders a decorative svg", (name) => {
    const out = renderToStaticMarkup(<Icon name={name} />);
    expect(out).toMatch(/^<svg [^>]*viewBox="0 0 24 24"[^>]*>/);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('focusable="false"');
    expect(out).toContain('fill="none"');
    expect(out).toContain('stroke="currentColor"');
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain("<path ");
    expect(out).toContain('width="16"');
  });

  it("covers the names the page needs", () => {
    for (const name of ["hash", "bot", "users", "coins", "shield", "shield-check", "git-commit", "terminal", "wand", "check-circle", "circle-dashed", "alert-triangle", "x", "plus", "minus", "clock", "ghost"]) {
      expect(ICON_NAMES, name).toContain(name);
    }
  });

  it("no button on the page is icon-only without an accessible name", () => {
    const busy = state({
      inbox: [{ id: "i1", channel: "#fix-bug", candidates: [], agent: "coder", action: "edit", ts: 1 }],
      channels: [channel({ commits: Array.from({ length: 6 }, (_, i) => ({ agent: "coder", sha: `bbbb00${i}`, files: 1, ts: i })) })],
    });
    const out = renderToStaticMarkup(<Dashboard state={busy} summary={null} status={null} actions={{ ...IDLE_ACTIONS, confirm: { phase: "confirming", request: { kind: "exorcise", channel: "#fix-bug", agent: "coder" } } }} />);
    const buttons = [...out.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.length).toBeGreaterThan(5);
    for (const [, attrs, inner] of buttons) {
      const text = (inner ?? "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
      expect(text !== "" || /aria-label="[^"]+"/.test(attrs ?? ""), attrs).toBe(true);
    }
  });
});

describe("primitives", () => {
  it("Pill keeps body text and puts the tone on the border", () => {
    const out = renderToStaticMarkup(<Pill tone="warn" icon="alert-triangle">Stale</Pill>);
    expect(out).toContain("border:1px solid");
    expect(out).toContain("border-color:#f59e0b");
    expect(out).toContain("color:var(--card-fg, #f4f4f5)");
    expect(out).toContain("Stale");
  });

  it("Button uses aria-disabled, never the disabled attribute", () => {
    const out = renderToStaticMarkup(<Button disabled variant="primary">Go</Button>);
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("EmptyState shows an icon, a title and a hint", () => {
    const out = renderToStaticMarkup(<EmptyState icon="ghost" title="No open requests" hint="Nothing to do." />);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("No open requests");
    expect(out).toContain("Nothing to do.");
  });
});

describe("meter", () => {
  const meter = (value: number, max: number) => renderToStaticMarkup(<Meter value={value} max={max} label="Credits used" valueText={`${String(value).replace("NaN", "?")} of ${max}`} />);

  it("clamps aria-valuenow to [0, max] and the fill to the track when used is above the total", () => {
    const over = meter(12, 10);
    expect(over).toContain('aria-valuenow="10"');
    expect(over).toContain('aria-valuemax="10"');
    expect(over).toContain("width:100.0%");
    expect(over).toContain('aria-valuetext="12 of 10"');
    expect(meter(-3, 10)).toContain('aria-valuenow="0"');
  });

  it("handles a total of zero without dividing: empty bar, max 0, value text n/a", () => {
    const zero = meter(2, 0);
    expect(zero).toContain('aria-valuenow="0"');
    expect(zero).toContain('aria-valuemax="0"');
    expect(zero).toContain('aria-valuetext="n/a"');
    expect(zero).toContain("width:0.0%");
    expect(zero).not.toMatch(/NaN|Infinity/);
    expect(meter(Number.NaN, 10)).not.toMatch(/NaN/);
  });

  it("a channel with used above total or a zero total renders without errors", () => {
    expect(renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: 3, total: 2 } })} now={1} />)).toContain('aria-valuenow="2"');
    expect(renderToStaticMarkup(<ChannelCard channel={channel({ credits: { used: 0, total: 0 } })} now={1} />)).toContain('aria-valuetext="n/a"');
  });
});

describe("status line", () => {
  it("keeps the changing age text out of the role=status live region", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "registered", host: "h.example", nick: "crew" }} status={{ ok: true, lastSuccess: 1_000 }} now={31_000} />);
    const live = /<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(live).toContain("Connected");
    expect(live).toContain("h.example as crew");
    expect(live).not.toContain("updated");
    expect(html).toContain("updated 30 s ago");
  });

  it("computes the age from the clock it is given, not once at render", () => {
    const at = (now: number) => renderToStaticMarkup(<StatusBanner bridge={{ state: "registered", host: "h", nick: "n" }} status={{ ok: true, lastSuccess: 1_000 }} now={now} />);
    expect(at(1_000)).toContain("updated 0 s ago");
    expect(at(66_000)).toContain("updated 1 min ago");
  });
});

describe("daily summary next to the live total", () => {
  const old: Summary = { date: "2026-11-11", generatedAt: 1, totalCredits: null, channels: [], stale: false };

  it("labels a summary from an earlier day and shows today's live total beside it", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={old} liveTotal={2.31} today="2026-11-12" />);
    expect(out).toContain("Last summary: 2026-11-11");
    expect(out).toMatch(/<span>Total credits now<\/span><span[^>]*>2.31<\/span>/);
    expect(out).toMatch(/<span>Total credits in that summary<\/span><span[^>]*>n\/a<\/span>/);
  });

  it("shows a summary from today as before", () => {
    const out = renderToStaticMarkup(<SummaryCard summary={{ ...old, totalCredits: 4.5 }} liveTotal={9} today="2026-11-11" />);
    expect(out).toMatch(/<h3[^>]*>2026-11-11<\/h3>/);
    expect(out).not.toContain("Last summary");
    expect(out).not.toContain("Total credits now");
  });

  it("the dashboard passes the live total and the server's UTC date", () => {
    const out = renderToStaticMarkup(<Dashboard state={state({ serverTime: Date.parse("2026-11-12T10:00:00Z"), totalCredits: 2.31 })} summary={old} status={null} />);
    expect(out).toContain("Last summary: 2026-11-11");
    expect(out).toMatch(/Total credits now<\/span><span[^>]*>2.31/);
  });
});

describe("layout details", () => {
  it("puts the Channels heading inside its own panel, like Needs op", () => {
    const out = renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />);
    const panelOpen = out.indexOf('<section aria-labelledby="channels-heading"');
    const heading = out.indexOf('<h2 id="channels-heading"');
    expect(panelOpen).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(panelOpen);
    // The heading is the first thing in the panel, as it is in the Needs op panel.
    expect(out.slice(panelOpen, heading)).not.toMatch(/<h[1-6]/);
    expect(out).toContain('<section aria-labelledby="inbox-heading"');
  });

  it("picks the tile columns from the container width: 6 when wide, 3 + 3 under 900 px, 2 under 500 px", () => {
    const out = renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />);
    const overview = out.slice(out.indexOf('aria-label="Overview"'), out.indexOf("</section>", out.indexOf('aria-label="Overview"')));
    // The section is the size container; the six tiles are direct children of one grid whose columns come from the CSS.
    expect(overview).toContain("container-type:inline-size");
    expect(overview).toContain("data-seance-tiles");
    expect(overview.match(/<div style="[^"]*"><span style="/g)).toHaveLength(6);
    expect(overview).not.toContain("grid-template-columns"); // inline columns would beat the container query
    expect(TILES_WIDE_PX).toBe(900);
    expect(TILES_NARROW_PX).toBe(500);
    expect(TILES_CSS).toContain("[data-seance-tiles]{grid-template-columns:repeat(6,minmax(0,1fr))}");
    expect(TILES_CSS).toContain("@container (max-width:899px){[data-seance-tiles]{grid-template-columns:repeat(3,minmax(0,1fr))}}");
    expect(TILES_CSS).toContain("@container (max-width:499px){[data-seance-tiles]{grid-template-columns:repeat(2,minmax(0,1fr))}}");
    // The narrower rule comes last so it wins below 500 px.
    expect(TILES_CSS.indexOf("max-width:499px")).toBeGreaterThan(TILES_CSS.indexOf("max-width:899px"));
    // The page renders the rule once, in its scoped <style>.
    expect(out.split(TILES_CSS).length - 1).toBe(1);
  });

  it("shows the same grid while loading", () => {
    const out = renderToStaticMarkup(<Dashboard state={null} summary={undefined} status={null} />);
    const overview = out.slice(out.indexOf('aria-label="Overview"'), out.indexOf("</section>", out.indexOf('aria-label="Overview"')));
    expect(overview).toContain("container-type:inline-size");
    expect(overview).toContain("data-seance-tiles");
  });

  it("opens the recent log by default", () => {
    expect(renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} />)).toContain('<details open="">');
  });

  it("uses the primary style for a grant and the danger style for exorcise and revoke", () => {
    const dialog = (request: ConfirmRequest) =>
      renderToStaticMarkup(<Dashboard state={state()} summary={null} status={null} actions={{ ...IDLE_ACTIONS, confirm: { phase: "confirming", request } }} />);
    // Only the dialog's confirm button, not the page's own Exorcise buttons.
    const confirmButton = (html: string) => /<button[^>]*aria-label="(?:Apply|Exorcise)[^"]*"[^>]*>/.exec(html.slice(html.indexOf('role="dialog"')))?.[0] ?? "";
    const grant = confirmButton(dialog({ kind: "grant", channel: "#fix-bug", agent: "coder", mode: "+o", inboxId: "i1" }));
    expect(grant).toContain("background:var(--accent");
    expect(grant).not.toContain("background:var(--danger");
    expect(confirmButton(dialog({ kind: "mode", channel: "#fix-bug", agent: "coder", mode: "+v" }))).toContain("background:var(--accent");
    expect(confirmButton(dialog({ kind: "mode", channel: "#fix-bug", agent: "coder", mode: "-o" }))).toContain("background:var(--danger");
    expect(confirmButton(dialog({ kind: "exorcise", channel: "#fix-bug", agent: "coder" }))).toContain("background:var(--danger");
    expect(confirmCopy({ kind: "grant", channel: "#a", agent: "x", mode: "+o" }).destructive).toBe(false);
    expect(confirmCopy({ kind: "mode", channel: "#a", agent: "x", mode: "-v" }).destructive).toBe(true);
  });
});

describe("spacing and type come from the tokens", () => {
  it("no component sets a gap, padding, margin or font size from a raw rem number", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "src");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toMatch(/\b(gap|padding|margin\w*|fontSize|borderRadius)\s*:\s*"[0-9.]+rem"/);
    }
  });
});
