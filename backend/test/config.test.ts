import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigDeps, type FetchLike } from "../src/config.js";
import { appPaths } from "../src/paths.js";

const APP_SECRET = "app-secret-aaaa1111";
const TOKEN = "tok-bbbb2222";
const IRC_SECRET = "irc-secret-cccc3333";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const make = (overrides: {
  config?: unknown;
  tokenStatus?: number;
  configStatus?: number;
  tokenBody?: unknown;
  throwOn?: "token" | "config";
  env?: Record<string, string | undefined>;
  readFile?: () => Promise<string>;
} = {}) => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const isToken = url.includes("/token");
    if (overrides.throwOn === (isToken ? "token" : "config")) {
      throw new Error(`connect ECONNREFUSED for ${url} with ${APP_SECRET}`);
    }
    const status = isToken ? (overrides.tokenStatus ?? 200) : (overrides.configStatus ?? 200);
    const body = isToken ? (overrides.tokenBody ?? { token: TOKEN }) : (overrides.config ?? { host: "irc.example.org", nick: "crew", secret: IRC_SECRET });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const deps: ConfigDeps = {
    paths: appPaths("/app"),
    env: overrides.env ?? { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476/" },
    fetch,
    readFile: overrides.readFile ?? (async () => `${APP_SECRET}\n`),
  };
  return { deps, calls };
};

const failure = async (deps: ConfigDeps): Promise<ConfigError> => {
  try {
    await loadConfig(deps);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to fail");
};

describe("loadConfig", () => {
  it("reads the app secret, gets a token, then reads the config", async () => {
    const { deps, calls } = make();
    const result = await loadConfig(deps);
    expect(result).toMatchObject({ kind: "ok", config: { host: "irc.example.org", nick: "crew", secret: IRC_SECRET }, token: TOKEN });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:5476/api/apps/seance-crew/token", headers: { "X-App-Secret": APP_SECRET } });
    expect(calls[1]).toMatchObject({ method: "GET", url: `http://127.0.0.1:5476/api/apps/seance-crew/config?token=${TOKEN}` });
  });

  it("sends no Bearer, session token or cookie headers", async () => {
    const { deps, calls } = make();
    await loadConfig(deps);
    for (const call of calls) {
      const names = Object.keys(call.headers).map((h) => h.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("x-session-token");
      expect(names).not.toContain("cookie");
    }
    expect(Object.keys(calls[1]?.headers ?? {})).toHaveLength(0);
  });

  it("uses KIROCREW_APP_NAME when present", async () => {
    const { deps, calls } = make({ env: { KIROCREW_GATEWAY_ORIGIN: "http://127.0.0.1:5476", KIROCREW_APP_NAME: "seance-crew-dev" } });
    await loadConfig(deps);
    expect(calls[0]?.url).toContain("/api/apps/seance-crew-dev/token");
  });

  it("applies the defaults for host and nick", async () => {
    const { deps } = make({ config: { secret: IRC_SECRET } });
    const result = await loadConfig(deps);
    expect(result).toMatchObject({ kind: "ok", config: { host: "35-172-120-185.sslip.io", nick: "crew" } });
  });

  it("accepts a config nested under a config key", async () => {
    const { deps } = make({ config: { config: { host: "irc.example.org", nick: "bot", secret: IRC_SECRET } } });
    expect(await loadConfig(deps)).toMatchObject({ kind: "ok", config: { nick: "bot" } });
  });

  it.each([{}, { secret: "" }, { secret: "   " }, { secret: null }])("is unconfigured when the secret is missing or empty: %j", async (config) => {
    const { deps } = make({ config });
    expect(await loadConfig(deps)).toMatchObject({ kind: "unconfigured", host: "35-172-120-185.sslip.io", nick: "crew" });
  });

  it.each([
    ["scheme", "https://irc.example.org"],
    ["port", "irc.example.org:6697"],
    ["path", "irc.example.org/ws"],
    ["space", "irc example.org"],
    ["underscore", "irc_example.org"],
    ["leading dash", "-irc.example.org"],
    ["newline", "irc.example.org\nPASS x"],
  ])("rejects a host with a %s", async (_name, host) => {
    const { deps } = make({ config: { host, nick: "crew", secret: IRC_SECRET } });
    const err = await failure(deps);
    expect(err.step).toBe("validate");
  });

  it.each(["bad nick", "a\r\nb", "1abc", "x".repeat(40)])("rejects the nick %j", async (nick) => {
    const { deps } = make({ config: { host: "irc.example.org", nick, secret: IRC_SECRET } });
    expect((await failure(deps)).step).toBe("validate");
  });

  it("rejects non-string values", async () => {
    const { deps } = make({ config: { host: 5, secret: IRC_SECRET } });
    expect((await failure(deps)).step).toBe("validate");
  });
});

describe("loadConfig failures name the failed step and never leak secrets", () => {
  it("fails at read-app-secret when the file cannot be read or is empty", async () => {
    expect((await failure(make({ readFile: async () => { throw new Error(`ENOENT ${APP_SECRET}`); } }).deps)).step).toBe("read-app-secret");
    expect((await failure(make({ readFile: async () => "  \n" }).deps)).step).toBe("read-app-secret");
  });

  it("fails at token when KIROCREW_GATEWAY_ORIGIN is missing", async () => {
    const err = await failure(make({ env: {} }).deps);
    expect(err.step).toBe("token");
    expect(err.message).toContain("KIROCREW_GATEWAY_ORIGIN");
  });

  it("fails at token on an HTTP error, a missing token and a network error", async () => {
    expect((await failure(make({ tokenStatus: 403 }).deps)).step).toBe("token");
    expect((await failure(make({ tokenBody: {} }).deps)).step).toBe("token");
    expect((await failure(make({ tokenBody: { token: "" } }).deps)).step).toBe("token");
    const net = await failure(make({ throwOn: "token" }).deps);
    expect(net.step).toBe("token");
  });

  it("fails at config on an HTTP error, a non-object answer and a network error", async () => {
    expect((await failure(make({ configStatus: 500 }).deps)).step).toBe("config");
    expect((await failure(make({ config: "nope" }).deps)).step).toBe("config");
    expect((await failure(make({ throwOn: "config" }).deps)).step).toBe("config");
  });

  it("never puts the app secret, token or IRC secret in an error message", async () => {
    const errors = [
      await failure(make({ throwOn: "token" }).deps),
      await failure(make({ throwOn: "config" }).deps),
      await failure(make({ tokenStatus: 500 }).deps),
      await failure(make({ config: { host: "bad host", secret: IRC_SECRET } }).deps),
      await failure(make({ readFile: async () => { throw new Error(APP_SECRET); } }).deps),
    ];
    for (const err of errors) {
      for (const secret of [APP_SECRET, TOKEN, IRC_SECRET]) {
        expect(err.message).not.toContain(secret);
        expect(String(err.stack)).not.toContain(secret);
      }
    }
  });
});
