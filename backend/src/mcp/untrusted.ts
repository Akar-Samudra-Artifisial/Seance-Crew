// Marks text that came from the IRC server as data. The wrapper only appears in the human-readable `content`;
// `structuredContent` carries the raw strings next to `untrusted: true`.

const ZWSP = "\u200b";

/** Break any `<untrusted` or `</untrusted` sequence so that text cannot close or fake a wrapper. */
export function escapeUntrusted(text: string): string {
  return text.replace(/<(\/?)(untrusted)/gi, (_match, slash: string, name: string) => `<${ZWSP}${slash}${name}`);
}

/** Attribute values are quoted, so quotes, angle brackets, ampersands and control characters are replaced. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * `<untrusted source="channel:#fix-bug" from="coder">…</untrusted>`.
 * `kind` is the source prefix: "channel" for channel text, "whois" for fields of a WHOIS reply.
 */
export function wrapUntrusted(name: string, from: string, text: string, kind: "channel" | "whois" | "summary" = "channel"): string {
  return `<untrusted source="${kind}:${escapeAttribute(name)}" from="${escapeAttribute(from)}">${escapeUntrusted(text)}</untrusted>`;
}
