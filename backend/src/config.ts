// Configuration loading through the Kiro Crew gateway: app secret -> token -> config.
// The Séance secret never leaves this module except as the result value; errors use fixed strings only.
import { isIP } from "node:net";
import { isValidNick } from "../vendor/irc-protocol/src/index.js";
import type { AppPaths } from "./paths.js";

export const DEFAULT_HOST = "35-172-120-185.sslip.io";
export const DEFAULT_NICK = "crew";
export const DEFAULT_APP_NAME = "seance-crew";

export interface Config {
  readonly host: string;
  readonly nick: string;
  readonly secret: string;
}

export type ConfigStep = "read-app-secret" | "token" | "config" | "validate";

export class ConfigError extends Error {
  readonly step: ConfigStep;
  constructor(step: ConfigStep, message: string) {
    super(`config error at step "${step}": ${message}`);
    this.name = "ConfigError";
    this.step = step;
  }
}

export type ConfigResult =
  | { readonly kind: "ok"; readonly config: Config; readonly token: string; readonly appSecret: string }
  | { readonly kind: "unconfigured"; readonly host: string; readonly nick: string; readonly token: string; readonly appSecret: string };

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ConfigDeps {
  readonly paths: AppPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  readonly readFile: (file: string) => Promise<string>;
  readonly timeoutMs?: number;
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const PRIVATE_SUFFIXES = [".local", ".internal"] as const;

/**
 * Only a bare public-style DNS name with at least one dot is allowed: no scheme, port, path or spaces, no IP
 * literal (v4 or v6, including short forms like 127.1), no localhost and no .local or .internal names.
 */
export function isValidHost(host: string): boolean {
  if (!HOSTNAME.test(host) || isIP(host) !== 0) return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return false;
  if (PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const labels = lower.split(".");
  if (labels.length < 2) return false;
  // A real top-level label has a letter; an all-digit or hex-number last label is an IPv4 spelling.
  const tld = labels[labels.length - 1] ?? "";
  return /[a-z]/.test(tld) && !/^0x[0-9a-f]*$/.test(tld);
}

export const MAX_SECRET_BYTES = 400;

/** The secret goes into the PASS line, so it must not break the line or be unreasonably long. */
export function isValidSecret(secret: string): boolean {
  return !/[\r\n\0]/.test(secret) && Buffer.byteLength(secret, "utf8") <= MAX_SECRET_BYTES;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function request(deps: ConfigDeps, step: "token" | "config", url: string, init: { method: string; headers: Record<string, string> }): Promise<unknown> {
  let response: FetchResponseLike;
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  } catch (err) {
    // Never copy err.message: it may contain the URL, and the URL may contain the token.
    const kind = err instanceof Error ? err.name : "unknown";
    throw new ConfigError(step, `the gateway request failed (${kind})`);
  }
  if (!response.ok) throw new ConfigError(step, `the gateway answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ConfigError(step, "the gateway answer is not valid JSON");
  }
}

export async function loadConfig(deps: ConfigDeps): Promise<ConfigResult> {
  let appSecret: string;
  try {
    appSecret = (await deps.readFile(deps.paths.secretFile)).trim();
  } catch {
    throw new ConfigError("read-app-secret", "the app secret file could not be read");
  }
  if (appSecret === "") throw new ConfigError("read-app-secret", "the app secret file is empty");

  const origin = deps.env["KIROCREW_GATEWAY_ORIGIN"];
  if (origin === undefined || origin.trim() === "") {
    throw new ConfigError("token", "KIROCREW_GATEWAY_ORIGIN is not set");
  }
  const base = origin.trim().replace(/\/+$/, "");
  const appName = encodeURIComponent(deps.env["KIROCREW_APP_NAME"]?.trim() || DEFAULT_APP_NAME);

  const tokenBody = await request(deps, "token", `${base}/api/apps/${appName}/token`, {
    method: "POST",
    headers: { "X-App-Secret": appSecret },
  });
  const token = isRecord(tokenBody) ? tokenBody["token"] : undefined;
  if (typeof token !== "string" || token === "") throw new ConfigError("token", "the gateway answer has no token");

  const body = await request(deps, "config", `${base}/api/apps/${appName}/config?token=${encodeURIComponent(token)}`, {
    method: "GET",
    headers: {},
  });
  if (!isRecord(body)) throw new ConfigError("config", "the gateway answer is not an object");
  const hasOwn = "host" in body || "nick" in body || "secret" in body;
  const values = !hasOwn && isRecord(body["config"]) ? body["config"] : body;

  const rawHost = values["host"];
  const rawNick = values["nick"];
  const rawSecret = values["secret"];
  for (const [name, value] of [["host", rawHost], ["nick", rawNick], ["secret", rawSecret]] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ConfigError("validate", `${name} must be a string`);
    }
  }
  const host = typeof rawHost === "string" && rawHost.trim() !== "" ? rawHost.trim() : DEFAULT_HOST;
  const nick = typeof rawNick === "string" && rawNick.trim() !== "" ? rawNick.trim() : DEFAULT_NICK;
  if (!isValidHost(host)) throw new ConfigError("validate", "host must be a bare hostname (no scheme, port, path or spaces)");
  if (!isValidNick(nick)) throw new ConfigError("validate", "nick is not a valid IRC nick");
  const secret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (secret !== "" && !isValidSecret(secret)) {
    throw new ConfigError("validate", "secret must not contain CR, LF or NUL and must be at most 400 bytes");
  }
  if (secret === "") return { kind: "unconfigured", host, nick, token, appSecret };
  return { kind: "ok", config: { host, nick, secret }, token, appSecret };
}
