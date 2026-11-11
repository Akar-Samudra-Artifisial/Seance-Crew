// IRC formatting codes: bold, italic, underline, strikethrough, monospace, reverse, reset, and colours.
// Removed before a line is stored, so a colour code never leaves its digits behind in the text.
// \x03 colour with optional fg[,bg] (1 to 2 digits each); \x04 hex colour with optional RRGGBB[,RRGGBB].
const FORMATTING = /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?)?|[\x02\x1d\x1f\x1e\x11\x16\x0f]/g;

export function stripFormatting(text: string): string {
  return text.replace(FORMATTING, "");
}
