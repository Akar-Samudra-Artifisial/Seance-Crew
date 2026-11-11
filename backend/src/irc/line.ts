// Outbound line builder: validates, then serializes with the vendored protocol package.
import { isValidChannel, isValidNick, serialize } from "../../vendor/irc-protocol/src/index.js";

export type LineErrorCode =
  | "too-long"
  | "bad-char"
  | "bad-command"
  | "bad-param"
  | "bad-nick"
  | "bad-channel"
  | "not-registered"
  | "queue-full";

export class LineError extends Error {
  readonly code: LineErrorCode;
  constructor(code: LineErrorCode, message: string) {
    super(message);
    this.name = "LineError";
    this.code = code;
  }
}

export const MAX_LINE_BYTES = 512;
const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Build one outbound wire line (ending in exactly one CRLF).
 * Throws LineError; never truncates.
 */
export function buildLine(command: string, params: readonly string[], options: { readonly forceTrailing?: boolean } = {}): string {
  if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(command)) {
    throw new LineError("bad-command", "command must be letters or a 3-digit numeric");
  }
  params.forEach((param, index) => {
    if (/[\r\n\0]/.test(param)) {
      throw new LineError("bad-char", `parameter ${index} contains CR, LF or NUL`);
    }
  });
  try {
    const line = serialize({ command, params });
    if (options.forceTrailing !== true || params.length === 0) return line;
    // Some messages are conventionally written with a ":" before the last parameter even when it has no space.
    const last = params[params.length - 1] ?? "";
    if (last.startsWith(":") || last.includes(" ") || last === "") return line;
    const forced = `${line.slice(0, -2 - last.length)}:${last}\r\n`;
    if (byteLength(forced) > MAX_LINE_BYTES) {
      throw new LineError("too-long", `line exceeds the ${MAX_LINE_BYTES}-byte limit including CRLF`);
    }
    return forced;
  } catch (err) {
    if (err instanceof LineError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("exceeds the 512-byte limit")) {
      throw new LineError("too-long", `line exceeds the ${MAX_LINE_BYTES}-byte limit including CRLF`);
    }
    throw new LineError("bad-param", "a parameter is not valid for an IRC line");
  }
}

export function assertNick(nick: string): string {
  if (!isValidNick(nick)) throw new LineError("bad-nick", `${JSON.stringify(nick)} is not a valid nick`);
  return nick;
}

export function assertChannel(channel: string): string {
  if (!isValidChannel(channel)) throw new LineError("bad-channel", `${JSON.stringify(channel)} is not a valid channel`);
  return channel;
}
