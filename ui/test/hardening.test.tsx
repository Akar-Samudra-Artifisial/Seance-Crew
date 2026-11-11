import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelCard } from "../src/ChannelCard.js";
import { diffStates } from "../src/diff.js";
import { cleanText } from "../src/format.js";
import { LiveRegion } from "../src/LiveRegion.js";
import { LogPanel } from "../src/LogPanel.js";
import { createNoticeManager, NOTICE_MS, type Notice } from "../src/notice.js";
import { bannerFor, StatusBanner } from "../src/StatusBanner.js";
import { bannerStyle, buttonStyle, color, styles } from "../src/styles.js";
import { agedNow, AGE_TICK_MS, startTicker } from "../src/ticker.js";
import type { ChannelView, State } from "../src/types.js";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("cleanText", () => {
  it("removes bidi controls U+202A to U+202E and U+2066 to U+2069", () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(cleanText(`a${String.fromCharCode(code)}b`)).toBe("ab");
    }
  });

  it("removes C0 and C1 controls and DEL, keeps ordinary text, accents and emoji", () => {
    expect(cleanText("a\u0000b\u0007c\u001bd\u007fe\u0080f\u009fg\nh\ti")).toBe("abcdefghi");
    expect(cleanText("Séance ✔ 日本語 😀 #fix-bug")).toBe("Séance ✔ 日本語 😀 #fix-bug");
  });
});

describe("channel text is cleaned before rendering", () => {
  const evil = "safe\u202Eevil\u2066x\u2069\u0007\u0085end";
  const channel: ChannelView = {
    name: `#a${"\u202E"}b`,
    topic: `topic${evil}`,
    count: 1,
    credits: { used: null, total: null },
    agents: [{ nick: `n${"\u202D"}ick`, modes: "", model: `m${evil}`, ready: true }],
    commits: [{ agent: `ag${"\u202E"}ent`, sha: "abc1234", files: 1, ts: 1 }],
    lines: [{ seq: 1, ts: 1, from: `bo${"\u202E"}b`, kind: "privmsg", text: `hi${evil}` }],
  };
  const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/;

  it("LogPanel strips controls from sender and text", () => {
    const html = renderToStaticMarkup(<LogPanel channel={channel.name} lines={channel.lines} />);
    expect(forbidden.test(html)).toBe(false);
    expect(html).toContain("<span>bob</span>");
    expect(html).toContain("safeevilxend");
  });

  it("ChannelCard strips controls from name, topic, nicks, model and commit agent", () => {
    const html = renderToStaticMarkup(<ChannelCard channel={channel} />);
    expect(forbidden.test(html)).toBe(false);
    expect(html).toContain("Topic: topicsafeevilxend");
    expect(html).toContain("<strong>nick</strong>");
    expect(html).toContain("by agent");
  });
});

describe("StatusBanner with an unknown state", () => {
  it("falls back to a generic banner instead of crashing", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "brand-new-state" as never, host: "h", nick: "n" }} status={null} />);
    expect(html).toContain("Unknown state");
    expect(html).toContain("brand-new-state");
  });

  it("does not treat inherited object keys as known states", () => {
    expect(bannerFor("constructor").label).toBe("Unknown state");
    expect(bannerFor("__proto__").label).toBe("Unknown state");
    expect(bannerFor("registered").label).toBe("Connected");
  });

  it("cleans the unknown state text", () => {
    const html = renderToStaticMarkup(<StatusBanner bridge={{ state: "x\u202Ey" as never, host: "h", nick: "n" }} status={null} />);
    expect(html).not.toContain("\u202E");
  });
});

describe("notices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears a notice after 5 s", () => {
    const seen: Notice[] = [];
    const manager = createNoticeManager((n) => seen.push(n));
    manager.show("Applied +o.");
    expect(seen.at(-1)).toEqual({ id: 1, text: "Applied +o." });
    vi.advanceTimersByTime(NOTICE_MS - 1);
    expect(seen.at(-1)?.text).toBe("Applied +o.");
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)?.text).toBe("");
  });

  it("gives an identical consecutive notice a new id, so it is announced again, and restarts the clock", () => {
    const seen: Notice[] = [];
    const manager = createNoticeManager((n) => seen.push(n));
    manager.show("Dismissed.");
    vi.advanceTimersByTime(3_000);
    manager.show("Dismissed.");
    expect(seen.at(-1)).toEqual({ id: 2, text: "Dismissed." });
    vi.advanceTimersByTime(3_000); // 6 s after the first, 3 s after the second
    expect(seen.at(-1)?.text).toBe("Dismissed.");
    vi.advanceTimersByTime(2_000);
    expect(seen.at(-1)?.text).toBe("");
  });

  it("stop() cancels the pending clear", () => {
    const seen: Notice[] = [];
    const manager = createNoticeManager((n) => seen.push(n));
    manager.show("x");
    manager.stop();
    vi.advanceTimersByTime(NOTICE_MS * 2);
    expect(seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("LiveRegion renders each message in its own paragraph inside one polite region", () => {
    const html = renderToStaticMarkup(<LiveRegion announcement={{ id: 1, text: "A" }} notice={{ id: 2, text: "B" }} />);
    expect(html).toMatch(/^<div aria-live="polite" aria-atomic="false"[^>]*><p>A<\/p><p>B<\/p><\/div>$/);
  });
});

describe("age ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every 30 s and stops when cleaned up", () => {
    const onTick = vi.fn();
    const stop = startTicker(AGE_TICK_MS, onTick);
    vi.advanceTimersByTime(AGE_TICK_MS - 1);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AGE_TICK_MS * 2);
    expect(onTick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(AGE_TICK_MS * 5);
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the server time forward with the local time since the state arrived", () => {
    const anchor = { server: 1_000_000, local: 50 };
    expect(agedNow(anchor, 50)).toBe(1_000_000);
    expect(agedNow(anchor, 30_050)).toBe(1_030_000);
    expect(agedNow(anchor, 10)).toBe(1_000_000); // a clock step back never makes an item younger than 0
  });
});

describe("diffStates after a backend restart", () => {
  const base = (bootId: string, sha: string): State => ({
    bootId,
    revision: 1,
    serverTime: 1,
    bridge: { state: "registered", host: "h", nick: "n" },
    channels: [{ name: "#a", topic: "", count: 1, credits: { used: null, total: null }, agents: [], commits: [{ agent: "c", sha, files: 1, ts: 1 }], lines: [] }],
    inbox: [],
    totalCredits: null,
    truncated: false,
  });

  it("announces nothing when the bootId changed", () => {
    expect(diffStates(base("boot-1", "aaa"), base("boot-2", "bbb"))).toEqual({ newCommits: [], newInbox: [] });
    expect(diffStates(base("boot-1", "aaa"), base("boot-1", "bbb")).newCommits).toHaveLength(1);
  });
});

describe("styles", () => {
  it("read the host theme variables, each with a fallback", () => {
    for (const name of ["bg", "bg-hover", "card", "card-fg", "border", "muted", "accent", "accent-fg", "danger"]) {
      const used = Object.values(color).some((value) => value.startsWith(`var(--${name}, `));
      expect(used, name).toBe(true);
    }
    for (const value of [color.page, color.surface, color.card, color.cardFg, color.mutedText, color.border, color.accent, color.accentFg, color.danger]) {
      expect(value).toMatch(/^var\(--[a-z-]+, (#[0-9a-f]{6}|inherit|transparent)\)$/);
    }
  });

  it("give cards content spacing, a scrolling monospace log, and distinct primary and danger buttons", () => {
    expect(styles.logBox.fontFamily).toContain("monospace");
    expect(styles.logBox.overflowY).toBe("auto");
    expect(styles.logBox.maxHeight).toBeTruthy();
    expect(buttonStyle("primary").background).toBe(color.accent);
    expect(buttonStyle("danger").background).toBe(color.danger);
    expect(buttonStyle("plain").background).toBe(color.surface);
    expect(buttonStyle("plain", true).opacity).toBeLessThan(1);
  });

  it("colour banners differ by level and always have a border", () => {
    const tones = (["ok", "wait", "problem"] as const).map((level) => bannerStyle(level).borderLeft);
    expect(new Set(tones).size).toBe(3);
  });

  it("no source file uses class names, a CSS file or a CSS-in-JS library", () => {
    for (const name of readdirSync(srcDir)) {
      const text = readFileSync(path.join(srcDir, name), "utf8");
      expect(text, name).not.toMatch(/className\s*=/);
      expect(text, name).not.toMatch(/from\s+"(styled-components|@emotion|goober|stitches)/);
    }
    expect(readdirSync(srcDir).filter((n) => n.endsWith(".css"))).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(srcDir, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
