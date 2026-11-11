import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bannerStyle, buttonStyle, color, HOST_THEME, styles } from "../src/styles.js";

// The values read from the live host CSS. The test spells them out so a change to HOST_THEME cannot hide a failure.
const HOST = {
  bg: "#12141a",
  bgHover: "#262a35",
  card: "#181b22",
  cardFg: "#f4f4f5",
  text: "#e4e4e7",
  muted: "#909098",
  accent: "#00d492",
  accentFg: "#000000",
  danger: "#ef4444",
  border: "#27272a",
} as const;

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThan(4.5); // the well-known smallest grey that passes on white
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

// Every text/background pair the page uses, with the host values.
const PAIRS: ReadonlyArray<{ readonly name: string; readonly fg: string; readonly bg: string }> = [
  { name: "body text on the page background", fg: HOST.cardFg, bg: HOST.bg },
  { name: "host text on the page background", fg: HOST.text, bg: HOST.bg },
  { name: "body text on a card", fg: HOST.cardFg, bg: HOST.card },
  { name: "body text on a button, banner or badge (--bg-hover)", fg: HOST.cardFg, bg: HOST.bgHover },
  { name: "secondary text (--muted) on a card", fg: HOST.muted, bg: HOST.card },
  { name: "secondary text (--muted) on the page background", fg: HOST.muted, bg: HOST.bg },
  { name: "log text on the log box", fg: HOST.cardFg, bg: HOST.bg },
  { name: "log time (--muted) on the log box", fg: HOST.muted, bg: HOST.bg },
  { name: "primary button text on the accent", fg: HOST.accentFg, bg: HOST.accent },
  { name: "danger button text on the danger red", fg: HOST.accentFg, bg: HOST.danger },
  { name: "dialog text on the dialog card", fg: HOST.cardFg, bg: HOST.card },
  { name: "input text on a card", fg: HOST.cardFg, bg: HOST.card },
];

describe("text contrast with the host theme values", () => {
  it.each(PAIRS)("$name is at least 4.5:1", ({ fg, bg }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses the host values as the fallbacks, so a missing variable keeps the same pairs", () => {
    expect(HOST_THEME.bg).toBe(HOST.bg);
    expect(HOST_THEME["bg-hover"]).toBe(HOST.bgHover);
    expect(HOST_THEME.card).toBe(HOST.card);
    expect(HOST_THEME["card-fg"]).toBe(HOST.cardFg);
    expect(HOST_THEME.muted).toBe(HOST.muted);
    expect(HOST_THEME.accent).toBe(HOST.accent);
    expect(HOST_THEME["accent-fg"]).toBe(HOST.accentFg);
    expect(HOST_THEME.danger).toBe(HOST.danger);
  });

  it("the styles pick those pairs: variables, surfaces and text colours", () => {
    expect(color.mutedText).toBe(`var(--muted, ${HOST.muted})`);
    expect(color.surface).toBe(`var(--bg-hover, ${HOST.bgHover})`);
    expect(color.cardFg).toBe(`var(--card-fg, ${HOST.cardFg})`);
    expect(styles.hint.color).toBe(color.mutedText);
    expect(styles.logTime.color).toBe(color.mutedText);
    expect(styles.untrusted.color).toBe(color.cardFg);
    expect(buttonStyle("plain").background).toBe(color.surface);
    expect(buttonStyle("plain").color).toBe(color.cardFg);
    expect(buttonStyle("primary").background).toBe(color.accent);
    expect(buttonStyle("primary").color).toBe(color.accentFg);
    expect(buttonStyle("danger").background).toBe(color.danger);
    expect(buttonStyle("danger").color).toBe(color.accentFg);
    for (const level of ["ok", "wait", "problem"] as const) {
      expect(bannerStyle(level).background).toBe(color.surface);
      expect(bannerStyle(level).color).toBe(color.cardFg);
    }
    expect(styles.logBox.background).toBe(color.page);
    expect(styles.badge.background).toBe(color.surface);
    expect(styles.badge.color).toBe(color.cardFg);
    expect(styles.dialog.background).toBe(color.card);
  });

  it("never reads --muted-fg (it is black on this host)", () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    for (const name of readdirSync(srcDir)) {
      expect(readFileSync(path.join(srcDir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), name).not.toContain("muted-fg");
    }
  });
});
