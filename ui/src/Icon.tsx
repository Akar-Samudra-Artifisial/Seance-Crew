// Inline SVG icons. Paths hand-copied from lucide (https://lucide.dev, ISC licence) so the page needs no icon package.
// Circles and rectangles are written as paths. Every icon is decorative: the words next to it carry the meaning.

const circle = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const SHIELD = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";

export const ICONS = {
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
  bot: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9, 7, 4), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  coins: [circle(8, 8, 6), "M18.09 10.37A6 6 0 1 1 10.34 18", "M7 6h1v4", "m16.71 13.88.7.71-2.82 2.82"],
  shield: [SHIELD],
  "shield-check": [SHIELD, "m9 12 2 2 4-4"],
  "git-commit": [circle(12, 12, 3), "M3 12h6", "M15 12h6"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  wand: ["M15 4V2", "M15 16v-2", "M8 9h2", "M20 9h2", "M17.8 11.8 19 13", "M15 9h.01", "M17.8 6.2 19 5", "m3 21 9-9", "M12.2 6.2 11 5"],
  "check-circle": [circle(12, 12, 10), "m9 12 2 2 4-4"],
  "circle-dashed": [
    "M10.1 2.182a10 10 0 0 1 3.8 0",
    "M13.9 21.818a10 10 0 0 1-3.8 0",
    "M17.609 3.721a10 10 0 0 1 2.69 2.7",
    "M2.182 13.9a10 10 0 0 1 0-3.8",
    "M20.279 17.609a10 10 0 0 1-2.7 2.69",
    "M21.818 10.1a10 10 0 0 1 0 3.8",
    "M3.721 6.391a10 10 0 0 1 2.7-2.69",
    "M6.391 20.279a10 10 0 0 1-2.69-2.7",
  ],
  "alert-triangle": ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  plus: ["M5 12h14", "M12 5v14"],
  minus: ["M5 12h14"],
  clock: [circle(12, 12, 10), "M12 6v6l4 2"],
  ghost: ["M9 10h.01", "M15 10h.01", "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  /** Stroke colour; defaults to the surrounding text colour. */
  readonly color?: string;
}

export function Icon({ name, size = 16, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
