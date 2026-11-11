// backend/src/server.ts
import { readFile } from "node:fs/promises";

// backend/src/config.ts
import { isIP } from "node:net";

// backend/vendor/irc-protocol/src/parse.ts
var MAX_PARAMS = 15;
function isParseError(result) {
  return result.kind === "parse-error";
}
function fail(reason) {
  return { kind: "parse-error", reason };
}
function isValidCommand(command) {
  return /^[A-Za-z]+$/.test(command) || /^[0-9]{3}$/.test(command);
}
function parse(line) {
  let rest = line;
  if (rest.endsWith("\r\n")) {
    rest = rest.slice(0, -2);
  } else if (rest.endsWith("\n")) {
    rest = rest.slice(0, -1);
  }
  if (rest.length === 0) {
    return fail("empty line");
  }
  let prefix;
  if (rest.startsWith(":")) {
    const spaceIndex = rest.indexOf(" ");
    if (spaceIndex === -1) {
      return fail("prefix without command");
    }
    const token = rest.slice(1, spaceIndex);
    if (token.length === 0) {
      return fail("empty prefix");
    }
    prefix = token;
    rest = rest.slice(spaceIndex + 1).replace(/^ +/, "");
  }
  if (rest.length === 0) {
    return fail("missing command");
  }
  const commandEnd = rest.indexOf(" ");
  const rawCommand = commandEnd === -1 ? rest : rest.slice(0, commandEnd);
  if (!isValidCommand(rawCommand)) {
    return fail(`invalid command "${rawCommand}"`);
  }
  const command = rawCommand.toUpperCase();
  const params = [];
  let paramsRest = commandEnd === -1 ? "" : rest.slice(commandEnd + 1);
  while (paramsRest.length > 0) {
    paramsRest = paramsRest.replace(/^ +/, "");
    if (paramsRest.length === 0) {
      break;
    }
    if (paramsRest.startsWith(":")) {
      params.push(paramsRest.slice(1));
      paramsRest = "";
      break;
    }
    const nextSpace = paramsRest.indexOf(" ");
    if (nextSpace === -1) {
      params.push(paramsRest);
      paramsRest = "";
    } else {
      params.push(paramsRest.slice(0, nextSpace));
      paramsRest = paramsRest.slice(nextSpace + 1);
    }
  }
  if (params.length > MAX_PARAMS) {
    return fail(`too many parameters (${params.length} > ${MAX_PARAMS})`);
  }
  return prefix === void 0 ? { command, params } : { prefix, command, params };
}

// backend/vendor/irc-protocol/src/serialize.ts
var MAX_LINE_BYTES = 512;
var MAX_PARAMS2 = 15;
var encoder = new TextEncoder();
function hasForbiddenChar(value) {
  return /[\r\n\0]/.test(value);
}
function serialize(msg) {
  const { prefix, command, params } = msg;
  if (prefix !== void 0 && (prefix.length === 0 || /[ \r\n\0]/.test(prefix))) {
    throw new Error(
      `cannot serialize message: prefix ${JSON.stringify(prefix)} must be non-empty and contain no space, CR, LF or NUL`
    );
  }
  if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(command)) {
    throw new Error(
      `cannot serialize message: command ${JSON.stringify(command)} must be letters or a 3-digit numeric`
    );
  }
  if (params.length > MAX_PARAMS2) {
    throw new Error(
      `cannot serialize message: ${params.length} params exceeds the maximum of ${MAX_PARAMS2}`
    );
  }
  const lastIndex = params.length - 1;
  const parts = [];
  if (prefix !== void 0) {
    parts.push(`:${prefix}`);
  }
  parts.push(command.toUpperCase());
  params.forEach((param, index) => {
    if (hasForbiddenChar(param)) {
      throw new Error(
        `cannot serialize message: param ${index} contains CR, LF or NUL`
      );
    }
    if (index === lastIndex) {
      const needsColon = param.length === 0 || param.startsWith(":") || param.includes(" ");
      parts.push(needsColon ? `:${param}` : param);
      return;
    }
    if (param.length === 0 || param.startsWith(":") || param.includes(" ")) {
      throw new Error(
        `cannot serialize message: non-last param ${index} must be non-empty, must not start with ":" and must not contain a space`
      );
    }
    parts.push(param);
  });
  const line = `${parts.join(" ")}\r
`;
  const bytes = encoder.encode(line).length;
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(
      `cannot serialize message: ${bytes} UTF-8 bytes including CRLF exceeds the ${MAX_LINE_BYTES}-byte limit`
    );
  }
  return line;
}

// backend/vendor/irc-protocol/src/framer.ts
var MAX_LINE_BYTES2 = 512;
var MAX_BODY_BYTES = MAX_LINE_BYTES2 - 2;
var CR = 13;
var LF = 10;
var encoder2 = new TextEncoder();
var decoder = new TextDecoder("utf-8");
var LineFramer = class {
  buffer = new Uint8Array(MAX_LINE_BYTES2);
  length = 0;
  discarding = false;
  /**
   * Feed one chunk and return the events it completes, in order. An incomplete
   * trailing line stays buffered for later chunks.
   */
  push(chunk) {
    const bytes = typeof chunk === "string" ? encoder2.encode(chunk) : chunk;
    const events = [];
    for (const byte of bytes) {
      if (byte === LF) {
        if (this.discarding) {
          this.discarding = false;
        } else {
          this.finishLine(events);
        }
        this.length = 0;
        continue;
      }
      if (this.discarding) {
        continue;
      }
      if (this.length >= MAX_LINE_BYTES2) {
        this.discarding = true;
        this.length = 0;
        events.push({ kind: "overlong" });
        continue;
      }
      this.buffer[this.length] = byte;
      this.length += 1;
    }
    return events;
  }
  finishLine(events) {
    let end = this.length;
    if (end > 0 && this.buffer[end - 1] === CR) {
      end -= 1;
    }
    if (end === 0) {
      return;
    }
    if (end > MAX_BODY_BYTES) {
      events.push({ kind: "overlong" });
      return;
    }
    events.push({ kind: "line", line: decoder.decode(this.buffer.subarray(0, end)) });
  }
};

// backend/vendor/irc-protocol/src/casemap.ts
var MAX_NICK_LENGTH = 30;
var MAX_CHANNEL_LENGTH = 50;
function irc_lower(s) {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "[":
        out += "{";
        break;
      case "]":
        out += "}";
        break;
      case "\\":
        out += "|";
        break;
      case "~":
        out += "^";
        break;
      default:
        out += ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
    }
  }
  return out;
}
var NICK_PATTERN = /^[A-Za-z][A-Za-z0-9\-[\]\\`^{}_]*$/;
function isValidNick(nick) {
  return nick.length >= 1 && nick.length <= MAX_NICK_LENGTH && NICK_PATTERN.test(nick);
}
function isValidChannel(name) {
  return name.length >= 2 && name.length <= MAX_CHANNEL_LENGTH && name.startsWith("#") && !/[\s,\x07\x00]/.test(name);
}

// backend/vendor/irc-protocol/src/services.ts
var SERVICE_NICKS = ["ChanServ", "NickServ"];
var SERVICE_KEYS = new Set(SERVICE_NICKS.map((n) => irc_lower(n)));
function isServiceNick(nick) {
  return SERVICE_KEYS.has(irc_lower(nick));
}

// backend/src/config.ts
var DEFAULT_HOST = "35-172-120-185.sslip.io";
var DEFAULT_NICK = "crew";
var DEFAULT_APP_NAME = "seance-crew";
var ConfigError = class extends Error {
  step;
  constructor(step, message) {
    super(`config error at step "${step}": ${message}`);
    this.name = "ConfigError";
    this.step = step;
  }
};
var HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
var PRIVATE_SUFFIXES = [".local", ".internal"];
function isValidHost(host) {
  if (!HOSTNAME.test(host) || isIP(host) !== 0) return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return false;
  if (PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const labels = lower.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] ?? "";
  return /[a-z]/.test(tld) && !/^0x[0-9a-f]*$/.test(tld);
}
var MAX_SECRET_BYTES = 400;
function isValidSecret(secret) {
  return !/[\r\n\0]/.test(secret) && Buffer.byteLength(secret, "utf8") <= MAX_SECRET_BYTES;
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
async function request(deps, step, url, init) {
  let response;
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 1e4) });
  } catch (err) {
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
async function loadConfig(deps) {
  let appSecret;
  try {
    appSecret = (await deps.readFile(deps.paths.secretFile)).trim();
  } catch {
    throw new ConfigError("read-app-secret", "the app secret file could not be read");
  }
  if (appSecret === "") throw new ConfigError("read-app-secret", "the app secret file is empty");
  const origin = deps.env["KIROCREW_GATEWAY_ORIGIN"];
  if (origin === void 0 || origin.trim() === "") {
    throw new ConfigError("token", "KIROCREW_GATEWAY_ORIGIN is not set");
  }
  const base = origin.trim().replace(/\/+$/, "");
  const appName = encodeURIComponent(deps.env["KIROCREW_APP_NAME"]?.trim() || DEFAULT_APP_NAME);
  const tokenBody = await request(deps, "token", `${base}/api/apps/${appName}/token`, {
    method: "POST",
    headers: { "X-App-Secret": appSecret }
  });
  const token = isRecord(tokenBody) ? tokenBody["token"] : void 0;
  if (typeof token !== "string" || token === "") throw new ConfigError("token", "the gateway answer has no token");
  const body = await request(deps, "config", `${base}/api/apps/${appName}/config?token=${encodeURIComponent(token)}`, {
    method: "GET",
    headers: {}
  });
  if (!isRecord(body)) throw new ConfigError("config", "the gateway answer is not an object");
  const hasOwn = "host" in body || "nick" in body || "secret" in body;
  const values = !hasOwn && isRecord(body["config"]) ? body["config"] : body;
  const rawHost = values["host"];
  const rawNick = values["nick"];
  const rawSecret = values["secret"];
  for (const [name, value] of [["host", rawHost], ["nick", rawNick], ["secret", rawSecret]]) {
    if (value !== void 0 && value !== null && typeof value !== "string") {
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

// backend/src/config-watch.ts
var CONFIG_POLL_MS = 3e4;
function createConfigWatcher(deps) {
  const { load, bridge, clock, logger: logger2 } = deps;
  const interval = deps.intervalMs ?? CONFIG_POLL_MS;
  let timer;
  let stopped = false;
  let polling;
  let lastProblem = "";
  let announcedUnconfigured = false;
  const run = async () => {
    try {
      const result = await load();
      logger2.addSecret(result.appSecret);
      logger2.addSecret(result.token);
      lastProblem = "";
      if (stopped) return;
      if (result.kind === "ok") {
        announcedUnconfigured = false;
        bridge.applyConfig(result.config);
      } else {
        if (bridge.currentConfig !== null) {
          logger2.warn("the S\xE9ance secret was removed from the config; disconnecting");
          bridge.setUnconfigured();
        }
        if (!announcedUnconfigured) {
          announcedUnconfigured = true;
          logger2.warn("no S\xE9ance secret is configured; open the app settings and set host, nick and secret");
        }
      }
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : "configuration could not be loaded";
      if (err instanceof ConfigError && err.step === "validate" && !stopped) bridge.setConfigInvalid();
      if (message !== lastProblem) {
        lastProblem = message;
        logger2.error(message);
      }
    }
  };
  const poll = () => {
    polling ??= run().finally(() => {
      polling = void 0;
    });
    return polling;
  };
  const schedule = () => {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = void 0;
      void poll().finally(schedule);
    }, interval);
  };
  return {
    start: async () => {
      await poll();
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer !== void 0) clock.clearTimeout(timer);
      timer = void 0;
    },
    poll
  };
}

// backend/src/http.ts
import http from "node:http";
var HEALTH_BODY = '{"ok":true}';
function pathnameOf(url) {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(text);
}
function handleHealth(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(HEALTH_BODY),
    "Cache-Control": "no-store"
  });
  res.end(req.method === "HEAD" ? void 0 : HEALTH_BODY);
}
function createHttpServer(options) {
  const routes = options.routes ?? [];
  return http.createServer((req, res) => {
    const pathname = pathnameOf(req.url);
    if (pathname === "/health") {
      handleHealth(req, res);
      return;
    }
    const route = routes.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
    if (route === void 0) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    Promise.resolve(route.handle(req, res)).catch((err) => {
      options.logger.error("route failed", { path: route.prefix, error: err });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
}
function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// backend/src/irc/notices.ts
var DENIED_REASONS = [
  "no-mode",
  "needs-op",
  "outside-worktree",
  "unclassified",
  "unresolved-path",
  "deny-list",
  "protected-path",
  "private-session"
];
var SHA = "[0-9a-f]{7,40}";
var WORKTREE = new RegExp(`^worktree ready: (\\S+) @ (${SHA})$`);
var READY = /^(\S+) is ready$/;
var CLOSED = new RegExp(`^session (closed|cancelled), worktree reset to (${SHA})$`);
var REVERTED = /^(\d+) files?(?:\(s\))? reverted · (\d+\.\d{2}) credits used$/;
var COMMIT = new RegExp(`^(\\S+) committed (${SHA}) \\((\\d+) files?(?:\\(s\\))?\\)$`);
var DENIED = new RegExp(`^ops: (\\S+) denied (.+?): (${DENIED_REASONS.join("|")})(?: \\((.+)\\))?$`);
var nickOf = (prefix) => {
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
};
function parseNotice(input, ownNick) {
  const { prefix, target, text } = input;
  if (prefix === void 0 || prefix === "") return null;
  if (isValidChannel(target)) {
    if (!isServiceNick(nickOf(prefix))) return null;
    let m2 = WORKTREE.exec(text);
    if (m2 !== null) return { kind: "worktree", dir: m2[1], sha: m2[2] };
    m2 = CLOSED.exec(text);
    if (m2 !== null) return { kind: "closed", sha: m2[2], cancelled: m2[1] === "cancelled" };
    m2 = REVERTED.exec(text);
    if (m2 !== null) return { kind: "reverted", files: Number(m2[1]), credits: Number(m2[2]) };
    m2 = COMMIT.exec(text);
    if (m2 !== null) return { kind: "commit", agent: m2[1], sha: m2[2], files: Number(m2[3]) };
    m2 = READY.exec(text);
    if (m2 !== null) return { kind: "ready", agent: m2[1] };
    return null;
  }
  if (prefix.includes("!") || isServiceNick(prefix)) return null;
  if (irc_lower(target) !== irc_lower(ownNick)) return null;
  const m = DENIED.exec(text);
  if (m === null) return null;
  const reason = m[3];
  return m[4] === void 0 ? { kind: "denied", agent: m[1], action: m[2], reason } : { kind: "denied", agent: m[1], action: m[2], reason, detail: m[4] };
}

// backend/src/irc/dispatch.ts
var MAX_CHANNELS = 500;
var MAX_MEMBERS = 500;
var MAX_PENDING = 500;
var KNOWN_IGNORED = /* @__PURE__ */ new Set([
  "001",
  "002",
  "003",
  "004",
  "005",
  "251",
  "252",
  "253",
  "254",
  "255",
  "265",
  "266",
  "372",
  "375",
  "376",
  "312",
  "317",
  "319",
  "PING",
  "PONG",
  "464",
  "ERROR",
  "INVITE",
  "CAP"
]);
var NAME_PREFIX = { "@": "o", "+": "v", "%": "h", "~": "q", "&": "a" };
var MODE_WITH_PARAM_ALWAYS = /* @__PURE__ */ new Set(["o", "v", "h", "q", "a", "b", "e", "I"]);
var MODE_WITH_PARAM_ON_SET = /* @__PURE__ */ new Set(["k", "l"]);
var CREDITS_LINE = /^credits: (\S+) (\d+(?:\.\d+)?) \/ total (\d+(?:\.\d+)?)$/;
var nickOfPrefix = (prefix) => {
  if (prefix === void 0) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
};
function parseNames(text) {
  const out = [];
  for (const token of text.split(" ")) {
    if (token === "") continue;
    let modes = "";
    let i = 0;
    while (i < token.length && NAME_PREFIX[token[i] ?? ""] !== void 0) {
      modes += NAME_PREFIX[token[i] ?? ""];
      i += 1;
    }
    const nick = token.slice(i);
    if (isValidNick(nick)) out.push({ nick, modes });
  }
  return out;
}
function createDispatcher(store, hooks = {}, logger2) {
  let listPending = [];
  let namesPending = /* @__PURE__ */ new Map();
  let whoisPending = /* @__PURE__ */ new Map();
  const warned = /* @__PURE__ */ new Set();
  const capWarn = (what, limit) => {
    if (warned.has(what)) return;
    warned.add(what);
    logger2?.warn(`${what} limit reached; extra entries are dropped`, { limit });
  };
  const admit = (name) => {
    if (store.channel(name) !== void 0) return true;
    if (store.allChannels().length < MAX_CHANNELS) return true;
    capWarn("channel", MAX_CHANNELS);
    return false;
  };
  const whoisFor = (nick, create) => {
    if (!isValidNick(nick)) return void 0;
    const key = irc_lower(nick);
    const existing = whoisPending.get(key);
    if (existing !== void 0) return existing;
    if (whoisPending.size >= MAX_PENDING) {
      capWarn("pending WHOIS", MAX_PENDING);
      return void 0;
    }
    const created = create();
    whoisPending.set(key, created);
    return created;
  };
  const addMember = (channel, nick, modes) => {
    if (!isValidNick(nick)) return;
    if (!channel.members.has(irc_lower(nick)) && channel.members.size >= MAX_MEMBERS) {
      capWarn("channel member", MAX_MEMBERS);
      return;
    }
    store.setMember(channel, nick, modes);
  };
  const own = () => store.ownNick;
  const isOwn = (nick) => irc_lower(nick) === irc_lower(own());
  const resolveDenial = (agent) => {
    const shared = store.channelsOf(agent);
    const withOp = shared.filter((c) => store.ownModes(c.name).includes("o"));
    const pool = withOp.length > 0 ? withOp : shared;
    if (pool.length === 1) return { channel: pool[0].name, candidates: [] };
    if (pool.length > 1) {
      const newest = Math.max(...pool.map((c) => c.lastSession));
      const top = pool.filter((c) => c.lastSession === newest);
      if (newest > 0 && top.length === 1) return { channel: top[0].name, candidates: [] };
      return { channel: null, candidates: pool.map((c) => c.name) };
    }
    return { channel: null, candidates: [] };
  };
  const onDenied = (agent, action, reason, detail) => {
    const { channel, candidates } = resolveDenial(agent);
    if (reason === "needs-op") {
      store.addNeedsOp(agent, action, channel, candidates);
      return;
    }
    const text = `ops: ${agent} denied ${action}: ${reason}${detail === void 0 ? "" : ` (${detail})`}`;
    if (channel !== null) store.addLine(channel, "server", "system", text);
    else store.diagnostics.unresolvedDenials += 1;
  };
  const onNotice = (message) => {
    const target = message.params[0] ?? "";
    const text = message.params[1] ?? "";
    const from = nickOfPrefix(message.prefix);
    const toChannel = isValidChannel(target);
    if (toChannel && !admit(target)) return;
    const parsed = parseNotice({ prefix: message.prefix, target, text }, own());
    if (toChannel) store.addLine(target, from === "" ? "server" : from, "notice", text);
    if (parsed === null) return;
    const now = store.now();
    switch (parsed.kind) {
      case "worktree": {
        const channel = store.ensureChannel(target);
        channel.worktree = { dir: parsed.dir, sha: parsed.sha };
        channel.lastSession = now;
        store.emit({ type: "worktree", channel: channel.name, dir: parsed.dir, sha: parsed.sha });
        break;
      }
      case "ready": {
        const channel = store.ensureChannel(target);
        channel.readyAgents.add(irc_lower(parsed.agent));
        channel.lastSession = now;
        store.emit({ type: "ready", channel: channel.name, agent: parsed.agent });
        hooks.requestWhois?.(parsed.agent);
        break;
      }
      case "closed": {
        const channel = store.ensureChannel(target);
        channel.readyAgents.clear();
        store.emit({ type: "session-closed", channel: channel.name, sha: parsed.sha, cancelled: parsed.cancelled });
        break;
      }
      case "reverted": {
        const channel = store.ensureChannel(target);
        store.setCreditsFromNotice(channel, parsed.credits);
        store.emit({ type: "reverted", channel: channel.name, files: parsed.files, credits: parsed.credits });
        break;
      }
      case "commit": {
        const channel = store.ensureChannel(target);
        store.addCommit(channel, { agent: parsed.agent, sha: parsed.sha, files: parsed.files, ts: now });
        break;
      }
      case "denied":
        onDenied(parsed.agent, parsed.action, parsed.reason, parsed.detail);
        break;
    }
  };
  const onMode = (message) => {
    const target = message.params[0] ?? "";
    const modeString = message.params[1] ?? "";
    if (!isValidChannel(target) || !admit(target)) return;
    const channel = store.ensureChannel(target);
    const args = message.params.slice(2);
    let sign = "+";
    let argIndex = 0;
    for (const letter of modeString) {
      if (letter === "+" || letter === "-") {
        sign = letter;
        continue;
      }
      const takesParam = MODE_WITH_PARAM_ALWAYS.has(letter) || sign === "+" && MODE_WITH_PARAM_ON_SET.has(letter);
      const arg = takesParam ? args[argIndex++] : void 0;
      if ((letter === "o" || letter === "v" || letter === "h") && arg !== void 0) {
        const member = channel.members.get(irc_lower(arg));
        if (member !== void 0) {
          member.modes = sign === "+" ? member.modes.includes(letter) ? member.modes : member.modes + letter : member.modes.replaceAll(letter, "");
          store.bump();
        } else if (sign === "+") {
          addMember(channel, arg, letter);
        }
      }
    }
    store.addLine(target, nickOfPrefix(message.prefix) || "server", "mode", `${modeString} ${args.join(" ")}`.trim());
  };
  const finishWhois = (nick) => {
    const pending = whoisPending.get(irc_lower(nick));
    whoisPending.delete(irc_lower(nick));
    if (pending === void 0 || pending.notFound || pending.model === void 0) {
      store.clearAgent(nick);
      store.emit({ type: "whois-done", nick, found: pending !== void 0 && !pending.notFound });
      return;
    }
    store.setAgent({ nick: pending.nick, model: pending.model, tools: pending.tools, totalCredits: pending.total });
    for (const c of pending.credits) store.setCreditsFromWhois(c.channel, c.used, c.total);
    store.emit({ type: "whois-done", nick, found: true });
  };
  const handle = (message) => {
    const p = message.params;
    switch (message.command) {
      case "322":
        if (!isValidChannel(p[1] ?? "")) break;
        if (listPending.length >= MAX_CHANNELS) {
          capWarn("channel", MAX_CHANNELS);
          break;
        }
        listPending.push({ name: p[1] ?? "", count: Number(p[2] ?? 0) || 0, topic: p[3] ?? "" });
        break;
      case "323":
        store.applyList(listPending.filter((e) => isValidChannel(e.name)));
        listPending = [];
        store.sweep();
        store.emit({ type: "list-done" });
        break;
      case "353": {
        const name = p[2] ?? "";
        const key = irc_lower(name);
        if (!namesPending.has(key) && namesPending.size >= MAX_PENDING) {
          capWarn("pending NAMES", MAX_PENDING);
          break;
        }
        const list = namesPending.get(key) ?? [];
        for (const entry of parseNames(p[3] ?? "")) {
          if (list.length >= MAX_MEMBERS) {
            capWarn("channel member", MAX_MEMBERS);
            break;
          }
          list.push(entry);
        }
        namesPending.set(key, list);
        break;
      }
      case "366": {
        const name = p[1] ?? "";
        const names = namesPending.get(irc_lower(name)) ?? [];
        namesPending.delete(irc_lower(name));
        if (!isValidChannel(name) || !admit(name)) break;
        const channel = store.ensureChannel(name);
        channel.members.clear();
        for (const n of names) channel.members.set(irc_lower(n.nick), { nick: n.nick, modes: n.modes });
        channel.namesLoaded = true;
        channel.count = channel.members.size;
        if (channel.members.has(irc_lower(own()))) store.markPresent(channel);
        store.emit({ type: "names-done", channel: channel.name });
        break;
      }
      case "311": {
        const nick = p[1] ?? "";
        if (!isValidNick(nick)) break;
        whoisPending.delete(irc_lower(nick));
        whoisFor(nick, () => ({ nick, model: void 0, tools: [], credits: [], total: null, notFound: false }));
        break;
      }
      case "320": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => ({ nick, model: void 0, tools: [], credits: [], total: null, notFound: false }));
        if (pending === void 0) break;
        const text = p[2] ?? "";
        if (text.startsWith("model:")) pending.model = text.slice("model:".length).trim();
        else if (text.startsWith("tools:")) pending.tools = text.slice("tools:".length).split(",").map((t) => t.trim()).filter((t) => t !== "");
        else {
          const m = CREDITS_LINE.exec(text);
          if (m !== null) {
            pending.credits.push({ channel: m[1], used: Number(m[2]), total: Number(m[3]) });
            pending.total = Number(m[3]);
          }
        }
        break;
      }
      case "401": {
        const nick = p[1] ?? "";
        const pending = whoisFor(nick, () => ({ nick, model: void 0, tools: [], credits: [], total: null, notFound: true }));
        if (pending !== void 0) pending.notFound = true;
        break;
      }
      case "318":
        if (isValidNick(p[1] ?? "")) finishWhois(p[1] ?? "");
        break;
      case "332":
        if (isValidChannel(p[1] ?? "") && admit(p[1] ?? "")) store.ensureChannel(p[1] ?? "").topic = p[2] ?? "";
        store.bump();
        break;
      case "TOPIC":
        if (isValidChannel(p[0] ?? "") && admit(p[0] ?? "")) {
          store.ensureChannel(p[0] ?? "").topic = p[1] ?? "";
          store.bump();
        }
        break;
      case "PRIVMSG": {
        const target = p[0] ?? "";
        if (isValidChannel(target) && admit(target)) store.addLine(target, nickOfPrefix(message.prefix) || "server", "privmsg", p[1] ?? "");
        break;
      }
      case "NOTICE":
        onNotice(message);
        break;
      case "JOIN": {
        const nick = nickOfPrefix(message.prefix);
        const name = p[0] ?? "";
        if (!isValidChannel(name) || !isValidNick(nick) || !admit(name)) break;
        const channel = store.ensureChannel(name);
        store.markPresent(channel);
        addMember(channel, nick, "");
        if (channel.namesLoaded) channel.count = channel.members.size;
        store.addLine(name, nick, "join", `${nick} joined`);
        if (!isOwn(nick) && !store.isAgent(nick)) hooks.requestWhois?.(nick);
        break;
      }
      case "PART": {
        const nick = nickOfPrefix(message.prefix);
        const name = p[0] ?? "";
        const channel = store.channel(name);
        if (channel === void 0) break;
        store.addLine(name, nick, "part", p[1] === void 0 ? `${nick} left` : `${nick} left: ${p[1]}`);
        if (isOwn(nick)) store.markLeft(channel);
        else {
          store.removeMember(channel, nick);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        break;
      }
      case "KICK": {
        const name = p[0] ?? "";
        const victim = p[1] ?? "";
        const channel = store.channel(name);
        if (channel === void 0) break;
        const by = nickOfPrefix(message.prefix);
        store.addLine(name, by, "kick", `${victim} was kicked${p[2] === void 0 ? "" : `: ${p[2]}`}`);
        if (isOwn(victim)) store.markLeft(channel);
        else {
          store.removeMember(channel, victim);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        break;
      }
      case "QUIT": {
        const nick = nickOfPrefix(message.prefix);
        for (const channel of store.channelsOf(nick)) {
          store.addLine(channel.name, nick, "part", p[0] === void 0 ? `${nick} quit` : `${nick} quit: ${p[0]}`);
          store.removeMember(channel, nick);
          if (channel.namesLoaded) channel.count = channel.members.size;
        }
        store.clearAgent(nick);
        break;
      }
      case "NICK": {
        const old = nickOfPrefix(message.prefix);
        const next = p[0] ?? "";
        if (old === "" || !isValidNick(next)) break;
        if (isOwn(old)) store.ownNick = next;
        store.renameNick(old, next);
        break;
      }
      case "MODE":
        onMode(message);
        break;
      default:
        if (!KNOWN_IGNORED.has(message.command)) store.diagnostics.unknownCommands += 1;
        break;
    }
  };
  return {
    handle,
    reset: () => {
      warned.clear();
      listPending = [];
      namesPending = /* @__PURE__ */ new Map();
      whoisPending = /* @__PURE__ */ new Map();
    }
  };
}

// backend/src/irc/line.ts
var LineError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "LineError";
    this.code = code;
  }
};
var MAX_LINE_BYTES3 = 512;
var encoder3 = new TextEncoder();
function byteLength(text) {
  return encoder3.encode(text).length;
}
function buildLine(command, params, options = {}) {
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
    const last = params[params.length - 1] ?? "";
    if (last.startsWith(":") || last.includes(" ") || last === "") return line;
    const forced = `${line.slice(0, -2 - last.length)}:${last}\r
`;
    if (byteLength(forced) > MAX_LINE_BYTES3) {
      throw new LineError("too-long", `line exceeds the ${MAX_LINE_BYTES3}-byte limit including CRLF`);
    }
    return forced;
  } catch (err) {
    if (err instanceof LineError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("exceeds the 512-byte limit")) {
      throw new LineError("too-long", `line exceeds the ${MAX_LINE_BYTES3}-byte limit including CRLF`);
    }
    throw new LineError("bad-param", "a parameter is not valid for an IRC line");
  }
}

// backend/src/irc/queue.ts
var SendQueue = class {
  sendLine;
  clock;
  burst;
  refillMs;
  maxDepth;
  /** Two FIFOs: normal lines always go out before low ones. */
  normalLines = [];
  lowLines = [];
  tokens;
  last;
  timer;
  constructor(options) {
    this.sendLine = options.send;
    this.clock = options.clock;
    this.burst = options.burst ?? 8;
    this.refillMs = options.refillMs ?? 1e3;
    this.maxDepth = options.maxDepth ?? 100;
    this.tokens = this.burst;
    this.last = this.clock.now();
  }
  get depth() {
    return this.normalLines.length + this.lowLines.length;
  }
  push(line, priority = "normal") {
    if (priority === "urgent") {
      this.sendLine(line);
      return;
    }
    if (priority === "low" && this.depth > this.maxDepth) {
      throw new LineError("queue-full", `send queue is full (more than ${this.maxDepth} lines waiting)`);
    }
    (priority === "low" ? this.lowLines : this.normalLines).push(line);
    this.drain();
  }
  /** Drop everything that is waiting (used when the socket closes). */
  clear() {
    this.normalLines.length = 0;
    this.lowLines.length = 0;
    if (this.timer !== void 0) {
      this.clock.clearTimeout(this.timer);
      this.timer = void 0;
    }
  }
  refill() {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / this.refillMs);
    this.last = now;
  }
  drain() {
    if (this.timer !== void 0) {
      this.clock.clearTimeout(this.timer);
      this.timer = void 0;
    }
    this.refill();
    while (this.depth > 0 && this.tokens >= 1 - 1e-9) {
      this.tokens -= 1;
      const line = this.normalLines.length > 0 ? this.normalLines.shift() : this.lowLines.shift();
      if (line !== void 0) this.sendLine(line);
    }
    if (this.depth > 0) {
      const wait = Math.max(1, Math.ceil((1 - this.tokens) * this.refillMs));
      this.timer = this.clock.setTimeout(() => {
        this.timer = void 0;
        this.drain();
      }, wait);
    }
  }
};

// backend/src/irc/socket.ts
var READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
var createWebSocket = (url) => {
  const Ctor = globalThis.WebSocket;
  if (Ctor === void 0) throw new Error("global WebSocket is not available (Node >= 22 is required)");
  return new Ctor(url);
};

// backend/src/irc/ring.ts
var Ring = class {
  capacity;
  buffer = [];
  nextSeq = 1;
  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("ring capacity must be a positive integer");
    this.capacity = capacity;
  }
  get size() {
    return this.buffer.length;
  }
  /** The sequence number of the newest item, or 0 when nothing was ever pushed. */
  get lastSeq() {
    return this.nextSeq - 1;
  }
  /** Append an item built with the next sequence number; the oldest item is dropped when full. */
  push(make) {
    const item = make(this.nextSeq);
    this.nextSeq += 1;
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    return item;
  }
  /** Items with a sequence number greater than `afterSeq`, in increasing order, plus whether some were lost. */
  since(afterSeq) {
    const items = this.buffer.filter((i) => i.seq > afterSeq);
    const last = this.lastSeq;
    const oldest = this.buffer[0]?.seq ?? this.nextSeq;
    const lost = afterSeq > last || afterSeq < last && oldest > afterSeq + 1;
    return { items, lost };
  }
  /** The newest `count` items, oldest first. */
  newest(count) {
    return count >= this.buffer.length ? [...this.buffer] : this.buffer.slice(this.buffer.length - count);
  }
};

// backend/src/irc/store.ts
var RING_CAPACITY = 500;
var COMMIT_LIMIT = 50;
var INBOX_LIMIT = 200;
var DEDUP_MS = 6e4;
var DROP_AFTER_LEAVE_MS = 10 * 6e4;
var Store = class {
  clock;
  channelMap = /* @__PURE__ */ new Map();
  agentMap = /* @__PURE__ */ new Map();
  inboxItems = [];
  handlers = /* @__PURE__ */ new Map();
  anyHandlers = /* @__PURE__ */ new Set();
  inboxCounter = 0;
  rev = 0;
  /** Counters for diagnostics only. */
  diagnostics = { unknownCommands: 0, binaryFrames: 0, droppedLines: 0, overlongLines: 0, unresolvedDenials: 0 };
  ownNick = "";
  state = "unconfigured";
  constructor(clock) {
    this.clock = clock;
  }
  now() {
    return this.clock.now();
  }
  // ---- revision and events -------------------------------------------------
  /** Increases on every change, so pollers can ask for changes only. */
  get revision() {
    return this.rev;
  }
  bump() {
    this.rev += 1;
  }
  on(type, handler) {
    let set = this.handlers.get(type);
    if (set === void 0) {
      set = /* @__PURE__ */ new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
  onAny(handler) {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }
  emit(event) {
    this.bump();
    for (const handler of [...this.handlers.get(event.type) ?? []]) handler(event);
    for (const handler of [...this.anyHandlers]) handler(event);
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "state", state });
  }
  // ---- channels --------------------------------------------------------------
  key(name) {
    return irc_lower(name);
  }
  channel(name) {
    return this.channelMap.get(this.key(name));
  }
  ensureChannel(name) {
    const key = this.key(name);
    let channel = this.channelMap.get(key);
    if (channel === void 0) {
      channel = {
        name,
        topic: "",
        count: 0,
        members: /* @__PURE__ */ new Map(),
        ring: new Ring(RING_CAPACITY),
        commits: [],
        credits: { used: null, total: null, source: null },
        worktree: null,
        readyAgents: /* @__PURE__ */ new Set(),
        lastSession: 0,
        leftAt: null,
        namesLoaded: false
      };
      this.channelMap.set(key, channel);
      this.bump();
    }
    return channel;
  }
  /** Channels the bridge currently knows about (not left or removed). */
  listChannels() {
    return [...this.channelMap.values()].filter((c) => c.leftAt === null);
  }
  /** Channels including ones that were left recently and are waiting to be dropped. */
  allChannels() {
    return [...this.channelMap.values()];
  }
  /** Drop the buffers of channels left or removed at least 10 minutes ago. Returns the dropped names. */
  sweep() {
    const now = this.clock.now();
    const dropped = [];
    for (const [key, channel] of this.channelMap) {
      if (channel.leftAt !== null && now - channel.leftAt >= DROP_AFTER_LEAVE_MS) {
        this.channelMap.delete(key);
        dropped.push(channel.name);
      }
    }
    if (dropped.length > 0) this.bump();
    return dropped;
  }
  markLeft(channel) {
    if (channel.leftAt === null) channel.leftAt = this.clock.now();
    channel.members.clear();
    channel.readyAgents.clear();
    channel.namesLoaded = false;
    this.bump();
  }
  markPresent(channel) {
    if (channel.leftAt !== null) {
      channel.leftAt = null;
      this.bump();
    }
  }
  /** Apply a finished LIST: record entries, and mark channels that are no longer listed as removed. */
  applyList(entries) {
    const listed = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const channel = this.ensureChannel(entry.name);
      channel.topic = entry.topic;
      channel.count = entry.count;
      this.markPresent(channel);
      listed.add(this.key(entry.name));
    }
    for (const [key, channel] of this.channelMap) {
      if (!listed.has(key) && channel.leftAt === null) this.markLeft(channel);
    }
    this.bump();
  }
  addLine(channelName, from, kind, text) {
    const channel = this.ensureChannel(channelName);
    const ts = this.clock.now();
    const line = channel.ring.push((seq) => ({ seq, ts, from, kind, text }));
    this.emit({ type: "line", channel: channel.name, line });
    return line;
  }
  // ---- members -----------------------------------------------------------------
  setMember(channel, nick, modes) {
    channel.members.set(irc_lower(nick), { nick, modes });
    this.bump();
  }
  removeMember(channel, nick) {
    const existed = channel.members.delete(irc_lower(nick));
    channel.readyAgents.delete(irc_lower(nick));
    if (existed) this.bump();
    return existed;
  }
  ownModes(channelName) {
    return this.channel(channelName)?.members.get(irc_lower(this.ownNick))?.modes ?? "";
  }
  /** Channels (present ones) where `nick` is a member. */
  channelsOf(nick) {
    const key = irc_lower(nick);
    return this.listChannels().filter((c) => c.members.has(key));
  }
  // ---- agents ----------------------------------------------------------------------
  isAgent(nick) {
    return this.agentMap.has(irc_lower(nick));
  }
  agent(nick) {
    return this.agentMap.get(irc_lower(nick));
  }
  agents() {
    return [...this.agentMap.values()];
  }
  setAgent(info) {
    this.agentMap.set(irc_lower(info.nick), info);
    this.emit({ type: "agent", nick: info.nick, model: info.model, tools: info.tools });
  }
  clearAgent(nick) {
    if (this.agentMap.delete(irc_lower(nick))) this.bump();
  }
  renameNick(oldNick, newNick) {
    const oldKey = irc_lower(oldNick);
    for (const channel of this.channelMap.values()) {
      const member = channel.members.get(oldKey);
      if (member !== void 0) {
        channel.members.delete(oldKey);
        channel.members.set(irc_lower(newNick), { nick: newNick, modes: member.modes });
      }
      if (channel.readyAgents.delete(oldKey)) channel.readyAgents.add(irc_lower(newNick));
    }
    this.agentMap.delete(oldKey);
    this.bump();
  }
  // ---- credits -----------------------------------------------------------------------
  setCreditsFromWhois(channelName, used, total) {
    const channel = this.ensureChannel(channelName);
    channel.credits.used = used;
    channel.credits.total = total;
    channel.credits.source = "whois";
    this.emit({ type: "credits", channel: channel.name, used, total });
  }
  setCreditsFromNotice(channel, used) {
    if (channel.credits.source === "whois") return;
    channel.credits.used = used;
    channel.credits.source = "notice";
    this.emit({ type: "credits", channel: channel.name, used, total: channel.credits.total ?? used });
  }
  /** Total credits: the sum of known agent totals, else the sum of per-channel figures, else null. */
  totalCredits() {
    const agentTotals = this.agents().flatMap((a) => a.totalCredits === null ? [] : [a.totalCredits]);
    if (agentTotals.length > 0) return round2(agentTotals.reduce((a, b) => a + b, 0));
    const used = this.listChannels().flatMap((c) => c.credits.used === null ? [] : [c.credits.used]);
    return used.length > 0 ? round2(used.reduce((a, b) => a + b, 0)) : null;
  }
  // ---- commits ---------------------------------------------------------------------------
  addCommit(channel, entry) {
    channel.commits.push(entry);
    if (channel.commits.length > COMMIT_LIMIT) channel.commits.shift();
    this.emit({ type: "commit", channel: channel.name, agent: entry.agent, sha: entry.sha, files: entry.files });
  }
  // ---- inbox -------------------------------------------------------------------------------
  inbox() {
    return this.inboxItems;
  }
  openInbox() {
    return this.inboxItems.filter((i) => i.status === "open");
  }
  /** Create a needs-op item unless the same (agent, action) was seen within 60 seconds. Returns null when de-duplicated. */
  addNeedsOp(agent, action, channel, candidates) {
    const now = this.clock.now();
    const key = `${irc_lower(agent)}\0${action}`;
    const duplicate = this.inboxItems.some((i) => `${irc_lower(i.agent)}\0${i.action}` === key && now - i.ts < DEDUP_MS);
    if (duplicate) return null;
    const item = {
      id: `i${++this.inboxCounter}`,
      channel,
      candidates,
      agent,
      action,
      reason: "needs-op",
      ts: now,
      status: "open"
    };
    this.inboxItems.push(item);
    while (this.inboxItems.length > INBOX_LIMIT) {
      const closed = this.inboxItems.findIndex((i) => i.status !== "open");
      this.inboxItems.splice(closed === -1 ? 0 : closed, 1);
    }
    this.emit({ type: "needs-op", item });
    return item;
  }
  dismiss(id) {
    return this.setStatus(id, "dismissed");
  }
  resolve(id) {
    return this.setStatus(id, "granted");
  }
  /** Mark open items for an agent (in a channel, or with an unknown channel) as granted. */
  resolveFor(channelName, agent) {
    let count = 0;
    for (const item of this.inboxItems) {
      if (item.status !== "open" || irc_lower(item.agent) !== irc_lower(agent)) continue;
      const matches = item.channel === null ? item.candidates.some((c) => irc_lower(c) === irc_lower(channelName)) : irc_lower(item.channel) === irc_lower(channelName);
      if (matches) {
        item.status = "granted";
        count += 1;
      }
    }
    if (count > 0) this.bump();
    return count;
  }
  setStatus(id, status) {
    const item = this.inboxItems.find((i) => i.id === id);
    if (item === void 0 || item.status !== "open") return false;
    item.status = status;
    this.bump();
    return true;
  }
  /** Forget everything that depends on the connection (used before a state rebuild). Counters and the inbox stay. */
  resetMembership() {
    for (const channel of this.channelMap.values()) {
      channel.members.clear();
      channel.readyAgents.clear();
      channel.namesLoaded = false;
    }
    this.agentMap.clear();
    this.bump();
  }
};
var round2 = (n) => Math.round(n * 100) / 100;

// backend/src/irc/client.ts
var REGISTRATION_TIMEOUT_MS = 15e3;
var IDLE_PING_AFTER_MS = 12e4;
var IDLE_GRACE_MS = 3e4;
var BACKOFF_BASE_MS = 1e3;
var BACKOFF_CAP_MS = 6e4;
var BACKOFF_JITTER = 0.25;
var CLOSE_WATCHDOG_MS = 5e3;
var QUIT_MESSAGE = "seance-crew shutting down";
function backoffDelay(attempt, random) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + Math.min(1, Math.max(0, random())) * BACKOFF_JITTER));
}
var AUTH_ERROR_TEXT = /authenticat|password|\bpass\b|access denied|not authorized/i;
var IrcBridge = class {
  store;
  clock;
  logger;
  createSocket;
  random;
  options;
  dispatcher;
  config = null;
  socket;
  framer = new LineFramer();
  queue;
  registerTimer;
  idleTimer;
  graceTimer;
  reconnectTimer;
  closeTimer;
  attempt = 0;
  stopped = false;
  restartAfterClose = false;
  hooksSet;
  constructor(options) {
    this.options = options;
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
    this.createSocket = options.createSocket ?? createWebSocket;
    this.random = options.random ?? Math.random;
    this.hooksSet = options.dispatchHooks ?? {};
    this.dispatcher = createDispatcher(this.store, { requestWhois: (nick) => this.hooksSet.requestWhois?.(nick) }, this.logger);
  }
  get state() {
    return this.store.state;
  }
  get currentConfig() {
    return this.config;
  }
  /** Install or replace the dispatch hooks (the WHOIS scheduler lives outside the client). */
  setDispatchHooks(hooks) {
    this.hooksSet = hooks;
  }
  /** True while a socket exists that is not CLOSED. */
  get hasSocket() {
    return this.socket !== void 0 && this.socket.readyState !== READY_STATE.CLOSED;
  }
  // ---- lifecycle ---------------------------------------------------------------------
  /** Start (or restart after a config change) with a complete config. Opens at most one socket. */
  start(config) {
    if (this.stopped || this.store.state === "duplicate-instance") return;
    this.logger.addSecret(config.secret);
    this.config = config;
    this.store.ownNick = config.nick;
    this.attempt = 0;
    this.clearReconnect();
    if (this.hasSocket) return;
    this.connect();
  }
  /**
   * Apply a (possibly changed) config. Reconnects when host, nick or secret changed, and leaves auth-failed or
   * unconfigured by connecting. A config that is identical to the running one is a no-op.
   */
  applyConfig(config) {
    if (this.stopped || this.store.state === "duplicate-instance") return;
    const current = this.config;
    const same = current !== null && current.host === config.host && current.nick === config.nick && current.secret === config.secret;
    if (same) return;
    this.logger.addSecret(config.secret);
    this.config = config;
    this.store.ownNick = config.nick;
    this.attempt = 0;
    this.clearReconnect();
    if (this.hasSocket) {
      this.restartAfterClose = true;
      this.closeSocket(1e3, "config changed");
      return;
    }
    this.connect();
  }
  /** Another instance holds the lock: never open a connection. */
  setDuplicateInstance() {
    this.store.setState("duplicate-instance");
  }
  /** The gateway delivered a config that failed validation (host, nick or secret): close the socket and wait. */
  setConfigInvalid() {
    this.config = null;
    this.restartAfterClose = false;
    this.clearReconnect();
    this.store.setState("config-invalid");
    this.closeSocket(1e3, "config invalid");
  }
  /** Config removed or incomplete: close the socket and wait. */
  setUnconfigured() {
    this.config = null;
    this.restartAfterClose = false;
    this.clearReconnect();
    this.closeSocket(1e3, "unconfigured");
    this.store.setState("unconfigured");
  }
  /** Shutdown: send QUIT, close, and never reconnect. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearTimers();
    const socket = this.socket;
    if (socket !== void 0 && socket.readyState === READY_STATE.OPEN) {
      try {
        const line = buildLine("QUIT", [QUIT_MESSAGE]);
        this.log("->", line);
        socket.send(line);
      } catch (err) {
        this.logger.warn("QUIT could not be sent", { error: err });
      }
      socket.close(1e3, "shutdown");
    }
    this.queue?.clear();
  }
  // ---- sending ---------------------------------------------------------------------------
  /** Queue one validated line. Throws LineError. Rejected (not buffered) unless the bridge is registered. */
  send(command, params, options = {}) {
    if (this.store.state !== "registered" || this.queue === void 0) {
      throw new LineError("not-registered", `the bridge is ${this.store.state}, not registered`);
    }
    this.queue.push(buildLine(command, params), options.priority ?? "normal");
  }
  // ---- connection --------------------------------------------------------------------------
  connect() {
    const config = this.config;
    if (config === null || this.stopped || this.hasSocket) return;
    this.store.setState("connecting");
    this.framer = new LineFramer();
    let socket;
    try {
      socket = this.createSocket(`wss://${config.host}/ws`);
    } catch (err) {
      this.logger.error("the socket could not be created", { error: err });
      this.onClosed(void 0);
      return;
    }
    this.socket = socket;
    this.queue = new SendQueue({
      clock: this.clock,
      send: (line) => {
        if (socket.readyState !== READY_STATE.OPEN) return;
        this.log("->", line);
        socket.send(line);
      }
    });
    this.registerTimer = this.clock.setTimeout(() => {
      this.registerTimer = void 0;
      if (this.socket === socket && this.store.state !== "registered") {
        this.logger.warn("registration timed out", { afterMs: REGISTRATION_TIMEOUT_MS });
        this.beginClose(socket, 4e3, "registration timeout");
      }
    }, REGISTRATION_TIMEOUT_MS);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      try {
        const queue = this.queue;
        queue?.push(buildLine("PASS", [`${config.nick}:${config.secret}`]), "normal");
        queue?.push(buildLine("NICK", [config.nick]), "normal");
        queue?.push(buildLine("USER", [config.nick, "0", "*", "seance-crew"], { forceTrailing: true }), "normal");
      } catch (err) {
        this.logger.error("handshake could not be built", { error: err });
        this.beginClose(socket, 4001, "bad handshake");
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onFrame(event.data);
    };
    socket.onerror = (event) => {
      this.logger.warn("socket error", { event: describeError(event) });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.onClosed(event.code);
    };
  }
  onFrame(data) {
    if (typeof data !== "string") {
      this.store.diagnostics.binaryFrames += 1;
      return;
    }
    for (const framed of this.framer.push(data)) {
      if (framed.kind === "overlong") {
        this.store.diagnostics.overlongLines += 1;
        continue;
      }
      const message = parse(framed.line);
      if (isParseError(message)) {
        this.store.diagnostics.droppedLines += 1;
        continue;
      }
      try {
        this.onLine(message, framed.line);
      } catch (err) {
        this.store.diagnostics.droppedLines += 1;
        this.logger.warn("a line from the server could not be handled and was dropped", {
          command: message.command,
          error: err instanceof LineError ? `LineError:${err.code}` : err instanceof Error ? err.name : "unknown"
        });
      }
    }
  }
  onLine(message, raw) {
    this.log("<-", raw);
    this.armIdle();
    switch (message.command) {
      case "PING": {
        this.queue?.push(buildLine("PONG", [message.params[0] ?? ""]), "urgent");
        return;
      }
      case "001": {
        this.onRegistered(message);
        return;
      }
      case "464": {
        if (this.store.state === "registered") {
          this.logger.warn("ignoring 464 after registration");
          return;
        }
        this.onAuthFailed("the server rejected the credentials (464)");
        return;
      }
      case "432":
      case "433": {
        if (this.store.state === "registered") {
          this.dispatcher.handle(message);
          return;
        }
        this.onNickRejected(message.command);
        return;
      }
      case "ERROR": {
        if (this.store.state !== "registered" && AUTH_ERROR_TEXT.test(message.params.join(" "))) {
          this.onAuthFailed("the server closed the link with an authentication error");
        }
        return;
      }
      default:
        this.dispatcher.handle(message);
    }
  }
  onRegistered(message) {
    if (this.registerTimer !== void 0) {
      this.clock.clearTimeout(this.registerTimer);
      this.registerTimer = void 0;
    }
    const confirmed = message.params[0];
    if (confirmed !== void 0 && confirmed !== "" && confirmed !== "*") this.store.ownNick = confirmed;
    this.attempt = 0;
    this.store.setState("registered");
    this.armIdle();
    this.options.onRegistered?.(this);
  }
  onAuthFailed(reason) {
    if (this.store.state === "auth-failed") return;
    this.logger.error("authentication failed; not reconnecting until the config changes", { reason });
    this.clearReconnect();
    this.store.setState("auth-failed");
    this.closeSocket(1e3, "auth failed");
  }
  /** 432/433 during registration: the nick is the account name, so this is a config problem, not a transient one. */
  onNickRejected(numeric) {
    if (this.store.state === "nick-rejected") return;
    this.logger.error("the server rejected the nick; not reconnecting until the config changes", { numeric });
    this.clearReconnect();
    this.store.setState("nick-rejected");
    this.closeSocket(1e3, "nick rejected");
  }
  onClosed(code) {
    this.clearTimers();
    this.queue?.clear();
    this.queue = void 0;
    this.socket = void 0;
    this.dispatcher.reset();
    this.options.onDisconnected?.();
    if (this.stopped) return;
    if (this.restartAfterClose) {
      this.restartAfterClose = false;
      if (this.config !== null) {
        this.connect();
        return;
      }
    }
    const state = this.store.state;
    if (state === "auth-failed" || state === "nick-rejected" || state === "config-invalid" || state === "duplicate-instance" || state === "unconfigured") return;
    this.logger.info("connection closed", { code });
    this.store.setState("reconnecting");
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.clearReconnect();
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = void 0;
      this.connect();
    }, delay);
  }
  /** Re-arm the idle detection: PING after 120 s of silence, close after 30 more seconds. */
  armIdle() {
    if (this.idleTimer !== void 0) this.clock.clearTimeout(this.idleTimer);
    if (this.graceTimer !== void 0) this.clock.clearTimeout(this.graceTimer);
    this.graceTimer = void 0;
    if (this.store.state !== "registered") return;
    const socket = this.socket;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = void 0;
      if (this.socket !== socket || socket === void 0) return;
      try {
        this.queue?.push(buildLine("PING", [this.config?.nick ?? "crew"]), "urgent");
      } catch (err) {
        this.logger.warn("idle PING failed", { error: err });
      }
      this.graceTimer = this.clock.setTimeout(() => {
        this.graceTimer = void 0;
        if (this.socket === socket) {
          this.logger.warn("no data from the server; reconnecting", { afterMs: IDLE_PING_AFTER_MS + IDLE_GRACE_MS });
          this.beginClose(socket, 4002, "idle timeout");
        }
      }, IDLE_GRACE_MS);
    }, IDLE_PING_AFTER_MS);
  }
  closeSocket(code, reason) {
    const socket = this.socket;
    if (socket !== void 0) this.beginClose(socket, code, reason);
  }
  /**
   * Close the socket and start the watchdog: if onclose has not fired after CLOSE_WATCHDOG_MS, detach the handlers
   * and continue as if it had, so a socket that never reports its close cannot wedge the bridge.
   */
  beginClose(socket, code, reason) {
    if (this.socket !== socket) return;
    if (socket.readyState !== READY_STATE.CLOSED && socket.readyState !== READY_STATE.CLOSING) {
      try {
        socket.close(code, reason);
      } catch (err) {
        this.logger.warn("socket close failed", { error: err });
      }
    }
    if (this.closeTimer !== void 0) return;
    this.closeTimer = this.clock.setTimeout(() => {
      this.closeTimer = void 0;
      if (this.socket !== socket) return;
      this.logger.warn("the socket did not report its close in time; treating it as closed", { afterMs: CLOSE_WATCHDOG_MS });
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      this.onClosed(void 0);
    }, CLOSE_WATCHDOG_MS);
  }
  clearReconnect() {
    if (this.reconnectTimer !== void 0) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
  }
  clearTimers() {
    for (const t of [this.registerTimer, this.idleTimer, this.graceTimer, this.closeTimer]) {
      if (t !== void 0) this.clock.clearTimeout(t);
    }
    this.closeTimer = void 0;
    this.registerTimer = void 0;
    this.idleTimer = void 0;
    this.graceTimer = void 0;
  }
  log(direction, line) {
    this.logger.debug(`${direction} ${line.replace(/\r?\n$/, "")}`);
  }
};
var describeError = (event) => {
  if (typeof event === "object" && event !== null && "message" in event) return String(event.message);
  return "socket error";
};

// backend/src/irc/rebuild.ts
var REBUILD_WHOIS_IN_FLIGHT = 5;
var LIVE_WHOIS_IN_FLIGHT = 1;
var MAX_NAMES_CHANNELS = 50;
var LIST_TIMEOUT_MS = 15e3;
var NAMES_TIMEOUT_MS = 3e4;
var WHOIS_TIMEOUT_MS = 1e4;
var WHOIS_QUEUE_LIMIT = 200;
function createRebuilder(deps) {
  const { store, clock, logger: logger2, send } = deps;
  let phase = "idle";
  let generation = 0;
  let limit = LIVE_WHOIS_IN_FLIGHT;
  let scanning = false;
  let phaseTimer;
  let pendingNames = /* @__PURE__ */ new Set();
  const queued = [];
  const queuedKeys = /* @__PURE__ */ new Set();
  const inFlight = /* @__PURE__ */ new Map();
  const clearPhaseTimer = () => {
    if (phaseTimer !== void 0) clock.clearTimeout(phaseTimer);
    phaseTimer = void 0;
  };
  const trySend = (command, params) => {
    try {
      send(command, params, "low");
      return true;
    } catch (err) {
      logger2.warn("rebuild could not send", { command, error: err });
      return false;
    }
  };
  const finishWhois = (key) => {
    const timer = inFlight.get(key);
    if (timer === void 0) return;
    clock.clearTimeout(timer);
    inFlight.delete(key);
    pump();
  };
  const pump = () => {
    while (inFlight.size < limit && queued.length > 0) {
      const nick = queued.shift();
      if (nick === void 0) break;
      const key = irc_lower(nick);
      queuedKeys.delete(key);
      if (!trySend("WHOIS", [nick])) continue;
      inFlight.set(key, clock.setTimeout(() => finishWhois(key), WHOIS_TIMEOUT_MS));
    }
    if (phase === "whois" && inFlight.size === 0 && queued.length === 0) {
      phase = "done";
      limit = LIVE_WHOIS_IN_FLIGHT;
      logger2.info("state rebuild finished", { channels: store.listChannels().length, agents: store.agents().length });
    }
  };
  let droppedWhois = 0;
  const flushDropped = () => {
    if (droppedWhois === 0) return;
    logger2.warn("WHOIS queue is full; nicks were dropped", { dropped: droppedWhois, limit: WHOIS_QUEUE_LIMIT });
    droppedWhois = 0;
  };
  const requestWhois = (nick) => {
    if (!isValidNick(nick)) return;
    const key = irc_lower(nick);
    if (key === irc_lower(store.ownNick) || inFlight.has(key) || queuedKeys.has(key)) return;
    if (queued.length >= WHOIS_QUEUE_LIMIT) {
      droppedWhois += 1;
      if (!scanning) flushDropped();
      return;
    }
    queued.push(nick);
    queuedKeys.add(key);
    pump();
  };
  const startWhois = (generationAtStart) => {
    if (generationAtStart !== generation) return;
    clearPhaseTimer();
    phase = "whois";
    limit = REBUILD_WHOIS_IN_FLIGHT;
    const seen = /* @__PURE__ */ new Set();
    scanning = true;
    for (const channel of store.listChannels()) {
      for (const member of channel.members.values()) {
        const key = irc_lower(member.nick);
        if (key === irc_lower(store.ownNick) || seen.has(key)) continue;
        seen.add(key);
        requestWhois(member.nick);
      }
    }
    scanning = false;
    flushDropped();
    pump();
  };
  const startNames = (generationAtStart) => {
    if (generationAtStart !== generation) return;
    clearPhaseTimer();
    phase = "names";
    const channels = store.listChannels().slice(0, MAX_NAMES_CHANNELS);
    pendingNames = /* @__PURE__ */ new Set();
    for (const channel of channels) {
      if (trySend("NAMES", [channel.name])) pendingNames.add(irc_lower(channel.name));
    }
    if (pendingNames.size === 0) {
      startWhois(generationAtStart);
      return;
    }
    phaseTimer = clock.setTimeout(() => {
      logger2.warn("NAMES replies timed out; continuing with WHOIS", { missing: pendingNames.size });
      startWhois(generationAtStart);
    }, NAMES_TIMEOUT_MS);
  };
  store.on("list-done", () => {
    if (phase === "list") startNames(generation);
  });
  store.on("names-done", (event) => {
    if (phase !== "names") return;
    pendingNames.delete(irc_lower(event.channel));
    if (pendingNames.size === 0) startWhois(generation);
  });
  store.on("whois-done", (event) => {
    finishWhois(irc_lower(event.nick));
  });
  const cancel = () => {
    generation += 1;
    clearPhaseTimer();
    for (const timer of inFlight.values()) clock.clearTimeout(timer);
    inFlight.clear();
    queued.length = 0;
    queuedKeys.clear();
    pendingNames = /* @__PURE__ */ new Set();
    droppedWhois = 0;
    phase = "idle";
    limit = LIVE_WHOIS_IN_FLIGHT;
  };
  return {
    start: () => {
      cancel();
      store.resetMembership();
      phase = "list";
      const g = generation;
      if (!trySend("LIST", [])) {
        phase = "idle";
        return;
      }
      phaseTimer = clock.setTimeout(() => {
        logger2.warn("LIST reply timed out; continuing with the channels already known");
        startNames(g);
      }, LIST_TIMEOUT_MS);
    },
    cancel,
    requestWhois,
    phase: () => phase
  };
}
function createIrcBridge(options) {
  const rebuilder = createRebuilder({
    store: options.store,
    clock: options.clock,
    logger: options.logger,
    send: (command, params, priority) => bridge.send(command, params, { priority })
  });
  const bridge = new IrcBridge({
    ...options,
    onRegistered: () => rebuilder.start(),
    onDisconnected: () => rebuilder.cancel(),
    dispatchHooks: { requestWhois: (nick) => rebuilder.requestWhois(nick) }
  });
  return { bridge, rebuilder };
}

// backend/src/lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
var BOOT_TOLERANCE_MS = 5e3;
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
var defaultBootTime = () => Date.now() - os.uptime() * 1e3;
var parseInfo = (text) => {
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const v = value;
    if (typeof v["pid"] !== "number" || !Number.isInteger(v["pid"]) || v["pid"] <= 0) return null;
    if (typeof v["startedAt"] !== "number" || !Number.isFinite(v["startedAt"])) return null;
    const port = typeof v["port"] === "number" ? v["port"] : null;
    const nonce = typeof v["nonce"] === "string" ? v["nonce"] : "";
    return { pid: v["pid"], startedAt: v["startedAt"], port, nonce };
  } catch {
    return null;
  }
};
var readLockFile = (file) => {
  try {
    const raw = readFileSync(file, "utf8");
    return { exists: true, raw, info: parseInfo(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return { exists: false, raw: null, info: null };
    return { exists: true, raw: null, info: null };
  }
};
var writeTemp = (file, text, id) => {
  const tmp = `${file}.${id}.tmp`;
  const fd = openSync(tmp, "wx", 384);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
};
var removeQuietly = (file) => {
  try {
    unlinkSync(file);
  } catch {
  }
};
function acquireLock(paths, deps = {}) {
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const bootTime = deps.bootTime ?? defaultBootTime;
  const randomId = deps.randomId ?? randomUUID;
  const processStart = deps.processStart ?? (() => now() - process.uptime() * 1e3);
  const file = paths.lockFile;
  mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
  const fileTime = () => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const isStale = (info) => {
    if (info === null) return true;
    if (info.pid === pid && info.startedAt < processStart() - BOOT_TOLERANCE_MS) return true;
    if (!isAlive(info.pid)) return true;
    const boot = bootTime() - BOOT_TOLERANCE_MS;
    return info.startedAt < boot || fileTime() < boot;
  };
  const mine = { pid, startedAt: now(), port: null, nonce: randomId() };
  const makeLock = () => {
    let current = mine;
    const ours = () => readLockFile(file).info?.nonce === mine.nonce;
    return {
      get info() {
        return current;
      },
      setPort(port) {
        if (!ours()) return;
        current = { ...current, port };
        const tmp2 = writeTemp(file, JSON.stringify(current), randomId());
        try {
          renameSync(tmp2, file);
        } catch (err) {
          removeQuietly(tmp2);
          throw err;
        }
      },
      release() {
        if (!ours()) return;
        try {
          unlinkSync(file);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    };
  };
  const createFresh = () => {
    const tmp2 = writeTemp(file, JSON.stringify(mine), randomId());
    try {
      linkSync(tmp2, file);
      return true;
    } catch (err) {
      const code = err.code;
      if (code === "EEXIST") return false;
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") {
        try {
          const fd = openSync(file, "wx", 384);
          try {
            writeSync(fd, JSON.stringify(mine));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          return true;
        } catch (inner) {
          if (inner.code === "EEXIST") return false;
          throw inner;
        }
      }
      throw err;
    } finally {
      removeQuietly(tmp2);
    }
  };
  if (createFresh()) return { kind: "acquired", lock: makeLock() };
  const existing = readLockFile(file);
  if (existing.exists && !isStale(existing.info)) return { kind: "duplicate", holder: existing.info };
  deps.beforeReplace?.();
  if (!existing.exists) {
    return createFresh() ? { kind: "acquired", lock: makeLock() } : { kind: "duplicate", holder: readLockFile(file).info };
  }
  if (readLockFile(file).raw !== existing.raw) return { kind: "duplicate", holder: readLockFile(file).info };
  const tmp = writeTemp(file, JSON.stringify(mine), randomId());
  try {
    renameSync(tmp, file);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  const after = readLockFile(file);
  if (after.info?.nonce === mine.nonce) return { kind: "acquired", lock: makeLock() };
  return { kind: "duplicate", holder: after.info };
}
var SIGNAL_CODES = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
function registerLockRelease(lock, proc = process) {
  proc.on("exit", () => {
    lock.release();
  });
  for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
    proc.on(signal, () => {
      lock.release();
      if (proc.listenerCount(signal) <= 1) proc.exit(128 + code);
    });
  }
}

// backend/src/paths.ts
import { chmodSync, existsSync, mkdirSync as mkdirSync2 } from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
var AppRootError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AppRootError";
  }
};
function resolveAppRoot(importMetaUrl, exists = existsSync) {
  const start = path2.dirname(fileURLToPath(importMetaUrl));
  let dir = start;
  for (; ; ) {
    if (exists(path2.join(dir, "app.json"))) return dir;
    const parent = path2.dirname(dir);
    if (parent === dir) {
      throw new AppRootError(`app.json not found while walking up from ${start}`);
    }
    dir = parent;
  }
}
function appPaths(root) {
  const data = path2.join(root, "data");
  return {
    root,
    data,
    secretFile: path2.join(root, ".app_secret"),
    lockFile: path2.join(data, "bridge.lock"),
    creditsFile: path2.join(data, "credits.json"),
    summaryFile: path2.join(data, "summary.json")
  };
}
function ensureDataDir(paths) {
  mkdirSync2(paths.data, { recursive: true, mode: 448 });
  chmodSync(paths.data, 448);
}

// backend/src/app.ts
var SWEEP_INTERVAL_MS = 6e4;
async function startApp(deps) {
  const { paths, logger: logger2, clock } = deps;
  ensureDataDir(paths);
  const store = new Store(clock);
  const { bridge, rebuilder } = createIrcBridge({
    store,
    clock,
    logger: logger2,
    ...deps.createSocket === void 0 ? {} : { createSocket: deps.createSocket },
    ...deps.random === void 0 ? {} : { random: deps.random }
  });
  const lockResult = acquireLock(paths, deps.lockDeps);
  const lock = lockResult.kind === "acquired" ? lockResult.lock : null;
  if (lockResult.kind === "duplicate") {
    logger2.warn("another instance holds data/bridge.lock; not connecting to the server", { holderPid: lockResult.holder?.pid });
    bridge.setDuplicateInstance();
  }
  store.on("state", (event) => logger2.info("bridge state", { state: event.state }));
  const server = createHttpServer({ logger: logger2, ...deps.routes === void 0 ? {} : { routes: deps.routes } });
  let port;
  try {
    port = await listen(server, deps.port);
  } catch (err) {
    lock?.release();
    throw err;
  }
  lock?.setPort(port);
  let sweepTimer;
  const scheduleSweep = () => {
    sweepTimer = clock.setTimeout(() => {
      store.sweep();
      scheduleSweep();
    }, SWEEP_INTERVAL_MS);
  };
  scheduleSweep();
  logger2.info("seance-crew backend listening", { port });
  let watcher = null;
  if (lock !== null) {
    watcher = createConfigWatcher({
      load: () => loadConfig({ paths, env: deps.env, fetch: deps.fetch, readFile: deps.readFile }),
      bridge,
      clock,
      logger: logger2
    });
    await watcher.start();
  }
  return {
    server,
    port,
    store,
    bridge,
    rebuilder,
    lock,
    watcher,
    stop: async () => {
      if (sweepTimer !== void 0) clock.clearTimeout(sweepTimer);
      sweepTimer = void 0;
      watcher?.stop();
      bridge.stop();
      await closeServer(server);
      lock?.release();
    }
  };
}

// backend/src/clock.ts
var systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle);
  }
};

// backend/src/log.ts
var LOG_LEVELS = ["debug", "info", "warn", "error"];
var DEFAULT_LOG_LEVEL = "info";
function parseLogLevel(value) {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized) ?? DEFAULT_LOG_LEVEL;
}
var MASK = "***";
var PASS_CREDENTIALS = /\bPASS [^\s:]+:\S*/g;
var PASS_LINE = /^PASS [^\r\n]*/gm;
var escapeForSort = (a, b) => b.length - a.length;
function createLogger(initialSecrets, sink = (line) => {
  process.stdout.write(`${line}
`);
}, clock = Date.now, minLevel = DEFAULT_LOG_LEVEL) {
  const minRank = LOG_LEVELS.indexOf(minLevel);
  const secrets = new Set(initialSecrets.filter((s) => s.length > 0));
  const redact = (text) => {
    let out = text;
    for (const secret of [...secrets].sort(escapeForSort)) {
      out = out.split(secret).join(MASK);
    }
    out = out.replace(PASS_CREDENTIALS, `PASS ${MASK}`);
    out = out.replace(PASS_LINE, `PASS ${MASK}`);
    return out;
  };
  const redactValue = (value, depth = 0) => {
    if (typeof value === "string") return redact(value);
    if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactValue(v, depth + 1);
    return out;
  };
  const write = (level, message, fields) => {
    if (LOG_LEVELS.indexOf(level) < minRank) return;
    const record = { ts: clock(), level, msg: redact(message) };
    if (fields !== void 0) {
      for (const [k, v] of Object.entries(fields)) record[k] = redactValue(v);
    }
    sink(redact(JSON.stringify(record)));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    redact,
    addSecret: (secret) => {
      if (secret.length > 0) secrets.add(secret);
    }
  };
}

// backend/src/port.ts
var PortError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PortError";
  }
};
function parsePort(env) {
  const raw = env["PORT"];
  if (raw === void 0 || raw.trim() === "") {
    throw new PortError("PORT is not set: the Kiro Crew gateway must provide the loopback port to bind");
  }
  if (!/^\d{1,5}$/.test(raw.trim())) {
    throw new PortError(`PORT must be a number between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) {
    throw new PortError(`PORT must be between 1 and 65535, got ${port}`);
  }
  return port;
}

// backend/src/server.ts
var logger = createLogger([], void 0, void 0, parseLogLevel(process.env["SEANCE_CREW_LOG_LEVEL"]));
var app;
var stopping = false;
var pendingSignal;
var fatal = (what, err) => {
  try {
    logger.error(what, { error: err });
  } catch {
  }
  try {
    app?.lock?.release();
  } catch {
  }
  process.exit(1);
};
var shutdown = (signal) => {
  if (stopping) return;
  if (app === void 0) {
    pendingSignal = signal;
    return;
  }
  stopping = true;
  logger.info("shutting down", { signal });
  app.stop().then(
    () => 0,
    (err) => {
      logger.error("shutdown failed", { error: err });
      app?.lock?.release();
      return 1;
    }
  ).then((code) => {
    setTimeout(() => process.exit(code), 200);
  });
};
process.on("uncaughtException", (err) => fatal("uncaught exception", err));
process.on("unhandledRejection", (reason) => fatal("unhandled rejection", reason));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown(signal));
async function main() {
  let port;
  let root;
  try {
    port = parsePort(process.env);
    root = resolveAppRoot(import.meta.url);
  } catch (err) {
    if (err instanceof PortError || err instanceof AppRootError) {
      process.stderr.write(`seance-crew: ${err.message}
`);
      process.exit(1);
    }
    throw err;
  }
  app = await startApp({
    paths: appPaths(root),
    env: process.env,
    port,
    clock: systemClock,
    logger,
    fetch: (url, init) => fetch(url, init),
    readFile: (file) => readFile(file, "utf8")
  });
  if (app.lock !== null) registerLockRelease(app.lock);
  if (pendingSignal !== void 0) shutdown(pendingSignal);
}
main().catch((err) => {
  fatal("fatal error while starting", err);
});
