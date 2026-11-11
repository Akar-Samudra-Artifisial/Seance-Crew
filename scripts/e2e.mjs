#!/usr/bin/env node
// Opt-in end-to-end check against a real Séance server.
// Plain ESM JavaScript: Node 22.12 does not strip TypeScript types by default.
// Runs only when SEANCE_E2E=1; otherwise prints "skipped" and exits 0.
//
// Flow, in a fresh #crew<n> channel:
//   connect -> JOIN -> INVITE coder (summon) -> wait "coder is ready" -> MODE +v coder
//   -> one prompt (PRIVMSG) -> wait for a reply from coder -> KICK coder (exorcise)
//   -> wait "session closed" -> QUIT
// The script joins the channel first so that it owns it; the INVITE itself is the summon from the spec.
//
// Credentials come from the environment only, never from files:
//   SEANCE_E2E_HOST, SEANCE_E2E_NICK, SEANCE_E2E_SECRET   (optional: SEANCE_E2E_AGENT, default "coder")
//   SEANCE_E2E_ANCHOR_NICK, SEANCE_E2E_ANCHOR_SECRET      (phase 2 only; a SECOND account, see below)
// No secret is ever printed.
//
// Phase 2 runs the real bundle backend/dist/server.js in a temporary app directory as SEANCE_E2E_NICK, against a
// stub gateway. Séance allows one session per account and drops empty channels, so a separate anchor connection
// logs in as SEANCE_E2E_ANCHOR_NICK / SEANCE_E2E_ANCHOR_SECRET, JOINs a fresh #crew<n> and stays there until the
// bundle has exited (the rebuild then finds at least one channel). Phase 2 is skipped with a message when the
// anchor variables are missing, and fails when the anchor nick equals SEANCE_E2E_NICK. It checks: /health,
// registration, state rebuild (at least one channel), the live /mcp endpoint (initialize, the 8 tools, list_channels
// and read on the anchor channel, exorcise refused without confirm and no KICK sent, foreign Host -> 421, foreign
// Origin -> 403; no agent is summoned, so no Kiro credits are used), SIGTERM (exit 0, lock file gone) and no secret
// in the process output. /health is deliberately minimal, so the bridge state is read from the
// bundle's own log lines ("bridge state", "state rebuild finished"). SEANCE_E2E_ONLY=ws|bundle runs one phase.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SEANCE_E2E !== "1") {
  process.stdout.write("e2e: skipped (set SEANCE_E2E=1 to run against a real server)\n");
  process.exit(0);
}

const host = process.env.SEANCE_E2E_HOST ?? "";
const nick = process.env.SEANCE_E2E_NICK ?? "";
const secret = process.env.SEANCE_E2E_SECRET ?? "";
const agent = process.env.SEANCE_E2E_AGENT ?? "coder";

const missing = [
  ["SEANCE_E2E_HOST", host],
  ["SEANCE_E2E_NICK", nick],
  ["SEANCE_E2E_SECRET", secret],
]
  .filter(([, value]) => value === "")
  .map(([name]) => name);
if (missing.length > 0) {
  process.stderr.write(`e2e: missing environment variables: ${missing.join(", ")}\n`);
  process.exit(2);
}
if (!/^[A-Za-z0-9.-]+$/.test(host)) {
  process.stderr.write("e2e: SEANCE_E2E_HOST must be a bare hostname\n");
  process.exit(2);
}

const STEP_TIMEOUT_MS = { register: 15_000, join: 15_000, ready: 90_000, reply: 180_000, closed: 30_000 };
const channel = `#crew${Math.floor(Math.random() * 1_000_000)}`;

// The anchor account used by the bundle phase has its own nick and secret; both secrets are always masked.
const anchorNick = process.env.SEANCE_E2E_ANCHOR_NICK ?? "";
const anchorSecret = process.env.SEANCE_E2E_ANCHOR_SECRET ?? "";
const redact = (text) => [secret, anchorSecret].filter((s) => s !== "").reduce((out, s) => out.split(s).join("***"), String(text));
const log = (message) => process.stdout.write(`e2e: ${redact(message)}\n`);

/** Parse one IRC line into { prefix, command, params }. Enough for this script. */
const parseLine = (line) => {
  let rest = line;
  let prefix = "";
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  const trailingAt = rest.indexOf(" :");
  const head = trailingAt === -1 ? rest : rest.slice(0, trailingAt);
  const params = head.split(" ").filter((p) => p !== "");
  const command = (params.shift() ?? "").toUpperCase();
  if (trailingAt !== -1) params.push(rest.slice(trailingAt + 2));
  return { prefix, command, params };
};
const nickOf = (prefix) => prefix.split("!")[0] ?? "";

let socket;
let buffer = "";
const waiters = [];
const failures = [];

const send = (line) => {
  if (/[\r\n\0]/.test(line)) throw new Error("refusing to send a line with CR, LF or NUL");
  if (socket?.readyState === 1) socket.send(`${line}\r\n`);
};

const onLine = (raw) => {
  const message = parseLine(raw);
  if (message.command === "PING") {
    send(`PONG ${message.params[0] ?? ""}`);
    return;
  }
  for (const waiter of [...waiters]) {
    if (waiter.test(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }
};

const waitFor = (name, test, timeoutMs) =>
  new Promise((resolve, reject) => {
    const waiter = {
      test,
      resolve,
      timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`timeout after ${timeoutMs} ms while waiting for: ${name}`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });

const isChannelNotice = (pattern) => (m) => m.command === "NOTICE" && m.params[0]?.toLowerCase() === channel.toLowerCase() && pattern.test(m.params[1] ?? "");

async function connect() {
  const WS = globalThis.WebSocket;
  if (WS === undefined) throw new Error("global WebSocket is not available (Node >= 22 is required)");
  const registered = waitFor("registration (001)", (m) => m.command === "001", STEP_TIMEOUT_MS.register);
  const failed = waitFor("authentication", (m) => m.command === "464" || (m.command === "ERROR" && /auth|password/i.test(m.params.join(" "))), STEP_TIMEOUT_MS.register);
  failed.then(() => failures.push("the server rejected the credentials"), () => undefined);
  socket = new WS(`wss://${host}/ws`);
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    buffer += event.data;
    let index;
    while ((index = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(buffer[index] === "\r" ? index + 2 : index + 1);
      if (line !== "") onLine(line);
    }
  };
  socket.onerror = () => failures.push("socket error");
  await new Promise((resolve, reject) => {
    socket.onopen = () => resolve(undefined);
    socket.onclose = () => reject(new Error("the connection closed before it opened"));
  });
  send(`PASS ${nick}:${secret}`);
  send(`NICK ${nick}`);
  send(`USER ${nick} 0 * :seance-crew`);
  await Promise.race([registered, new Promise((_, reject) => failed.then(() => reject(new Error("authentication failed")), () => undefined))]);
  log(`registered as ${nick} on ${host}`);
}

async function run() {
  await connect();

  send(`JOIN ${channel}`);
  await waitFor("our JOIN", (m) => m.command === "JOIN" && nickOf(m.prefix).toLowerCase() === nick.toLowerCase(), STEP_TIMEOUT_MS.join);
  log(`joined ${channel}`);

  const ready = waitFor(`"${agent} is ready"`, isChannelNotice(new RegExp(`^${agent} is ready$`)), STEP_TIMEOUT_MS.ready);
  send(`INVITE ${agent} ${channel}`);
  log(`summoned ${agent}`);
  await ready;
  log(`${agent} is ready`);

  send(`MODE ${channel} +v ${agent}`);
  await waitFor("MODE +v", (m) => m.command === "MODE" && m.params[1] === "+v", STEP_TIMEOUT_MS.join);
  log(`gave +v to ${agent}`);

  const reply = waitFor(`a reply from ${agent}`, (m) => m.command === "PRIVMSG" && nickOf(m.prefix).toLowerCase() === agent.toLowerCase() && m.params[0]?.toLowerCase() === channel.toLowerCase(), STEP_TIMEOUT_MS.reply);
  send(`PRIVMSG ${channel} :${agent}: reply with the single word ok`);
  log("sent one prompt");
  await reply;
  log(`${agent} replied`);
}

async function cleanup() {
  // Always exorcise and quit, even after a failure.
  try {
    if (socket?.readyState === 1) {
      const closed = waitFor('"session closed"', isChannelNotice(/^session (closed|cancelled)/), STEP_TIMEOUT_MS.closed);
      closed.catch(() => undefined);
      send(`KICK ${channel} ${agent} :e2e done`);
      log(`exorcised ${agent}`);
      await closed.then(() => log("session closed"), (err) => log(`warning: ${err.message}`));
      send("QUIT :e2e finished");
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.close(1000);
    }
  } catch (err) {
    log(`warning: cleanup failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

// ---- phase 2: the real bundle ---------------------------------------------------------------------------

const BUNDLE_TIMEOUT_MS = { health: 15_000, registered: 30_000, rebuild: 90_000, exit: 15_000 };
const APP_NAME = "seance-crew";
const STUB_APP_SECRET = "e2e-app-secret-not-a-real-secret";
const STUB_PROXY_SECRET = "e2e-proxy-secret-not-a-real-secret";
const STUB_TOKEN = "e2e-token-not-a-real-token";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns a truthy value or the timeout passes. */
async function until(name, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutMs} ms while waiting for: ${name}`);
    await sleep(200);
  }
}

/** Minimal gateway: POST token (checks X-App-Secret), GET config (serves data/config.json). */
function startStubGateway(configFile) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === `/api/apps/${APP_NAME}/token`) {
      if (req.headers["x-app-secret"] !== STUB_APP_SECRET) return reply(403, { error: "forbidden" });
      return reply(200, { token: STUB_TOKEN });
    }
    if (req.method === "GET" && url.pathname === `/api/apps/${APP_NAME}/config`) {
      if (url.searchParams.get("token") !== STUB_TOKEN) return reply(403, { error: "forbidden" });
      try {
        return reply(200, JSON.parse(readFileSync(configFile, "utf8")));
      } catch {
        return reply(500, { error: "config unreadable" });
      }
    }
    return reply(404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const EXPECTED_TOOLS = ["list_channels", "read", "say", "summon", "grant_op", "exorcise", "whois", "credits"];

/** POST one JSON-RPC message to the bundle's /mcp. node:http is used because fetch cannot set the Host header. */
function mcpPost(port, message, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(message);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = body === "" ? undefined : JSON.parse(body);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("the /mcp request timed out")));
    req.end(text);
  });
}

/** The live /mcp check: no agent is summoned, so no Kiro credits are used. */
async function checkMcp(port, anchorChannel, records) {
  let nextId = 1;
  const rpc = (method, params, headers) => mcpPost(port, { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }, headers);
  const need = (condition, message) => {
    if (!condition) throw new Error(`mcp: ${message}`);
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  need(init.status === 200 && init.json?.result?.serverInfo?.name === "seance-crew", "initialize did not return serverInfo");
  log("mcp: initialize ok");

  const list = await rpc("tools/list");
  const names = (list.json?.result?.tools ?? []).map((t) => t.name);
  need(JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `tools/list returned ${names.length} tools, expected exactly the 8 in order`);
  log("mcp: tools/list returns the 8 tools");

  const channels = await rpc("tools/call", { name: "list_channels", arguments: {} });
  const known = (channels.json?.result?.structuredContent?.channels ?? []).map((c) => String(c.name).toLowerCase());
  need(channels.json?.result?.isError !== true && known.includes(anchorChannel.toLowerCase()), "list_channels does not contain the anchor channel");
  log("mcp: list_channels contains the anchor channel");

  const read = await rpc("tools/call", { name: "read", arguments: { channel: anchorChannel } });
  need(read.status === 200 && read.json?.result !== undefined && read.json.result.isError !== true, "read on the anchor channel returned an error");
  log("mcp: read on the anchor channel ok");

  const kicksBefore = records.filter((r) => typeof r.msg === "string" && r.msg.startsWith("-> KICK")).length;
  const exorcise = await rpc("tools/call", { name: "exorcise", arguments: { channel: anchorChannel, agent: "coder" } });
  need(exorcise.json?.result?.isError === true && /confirm: true is required/.test(exorcise.json.result.content?.[0]?.text ?? ""), "exorcise without confirm was not refused");
  await sleep(500); // let any (wrong) line reach the debug trace
  const kicksAfter = records.filter((r) => typeof r.msg === "string" && r.msg.startsWith("-> KICK")).length;
  need(kicksAfter === kicksBefore, "a KICK line was sent without confirm");
  log("mcp: exorcise without confirm refused, no KICK sent");

  const badHost = await rpc("ping", undefined, { Host: "evil.example" });
  need(badHost.status === 421, `a foreign Host got HTTP ${badHost.status}, expected 421`);
  log("mcp: foreign Host answered 421");

  const badOrigin = await rpc("ping", undefined, { Origin: "https://evil.example" });
  need(badOrigin.status === 403, `a foreign Origin got HTTP ${badOrigin.status}, expected 403`);
  log("mcp: foreign Origin answered 403");
}

/**
 * A second raw connection with the same credentials that JOINs a fresh #crew<n> channel and stays in it, so the
 * server has at least one channel for the bundle's LIST. Returns { channel, close }.
 */
async function openAnchor() {
  const WS = globalThis.WebSocket;
  if (WS === undefined) throw new Error("global WebSocket is not available (Node >= 22 is required)");
  const anchorChannel = `#crew${Math.floor(Math.random() * 1_000_000)}`;
  const anchorWaiters = [];
  let anchorBuffer = "";
  const ws = new WS(`wss://${host}/ws`);
  const sendAnchor = (line) => {
    if (/[\r\n\0]/.test(line)) throw new Error("refusing to send a line with CR, LF or NUL");
    if (ws.readyState === 1) ws.send(`${line}\r\n`);
  };
  const waitAnchor = (name, test, timeoutMs) =>
    new Promise((resolve, reject) => {
      const waiter = {
        test,
        resolve,
        timer: setTimeout(() => {
          anchorWaiters.splice(anchorWaiters.indexOf(waiter), 1);
          reject(new Error(`timeout after ${timeoutMs} ms while waiting for: ${name}`));
        }, timeoutMs),
      };
      anchorWaiters.push(waiter);
    });
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    anchorBuffer += event.data;
    let index;
    while ((index = anchorBuffer.search(/\r?\n/)) !== -1) {
      const line = anchorBuffer.slice(0, index);
      anchorBuffer = anchorBuffer.slice(anchorBuffer[index] === "\r" ? index + 2 : index + 1);
      if (line === "") continue;
      const message = parseLine(line);
      if (message.command === "PING") {
        sendAnchor(`PONG ${message.params[0] ?? ""}`);
        continue;
      }
      for (const waiter of [...anchorWaiters]) {
        if (waiter.test(message)) {
          anchorWaiters.splice(anchorWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  };
  const close = async () => {
    try {
      if (ws.readyState === 1) {
        sendAnchor("QUIT :e2e anchor done");
        await sleep(300);
      }
      ws.close(1000);
    } catch {
      // Best effort: the connection is going away anyway.
    }
  };
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve(undefined);
      ws.onclose = () => reject(new Error("the anchor connection closed before it opened"));
    });
    const registered = waitAnchor("anchor registration (001)", (m) => m.command === "001", STEP_TIMEOUT_MS.register);
    const rejected = waitAnchor("anchor authentication", (m) => m.command === "464" || m.command === "433" || m.command === "432", STEP_TIMEOUT_MS.register);
    rejected.catch(() => undefined);
    sendAnchor(`PASS ${anchorNick}:${anchorSecret}`);
    sendAnchor(`NICK ${anchorNick}`);
    sendAnchor(`USER ${anchorNick} 0 * :seance-crew`);
    const first = await Promise.race([registered, rejected.then((m) => Promise.reject(new Error(`the anchor was rejected by the server (${m.command})`)))]);
    if (first.command !== "001") throw new Error("the anchor did not register");
    log("anchor: registered");
    const joined = waitAnchor("anchor JOIN", (m) => m.command === "JOIN" && nickOf(m.prefix).toLowerCase() === anchorNick.toLowerCase(), STEP_TIMEOUT_MS.join);
    sendAnchor(`JOIN ${anchorChannel}`);
    await joined;
    log(`anchor: joined ${anchorChannel} and staying`);
    return { channel: anchorChannel, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function runBundle() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bundle = path.join(repoRoot, "backend", "dist", "server.js");
  if (!existsSync(bundle)) throw new Error("backend/dist/server.js is missing; run pnpm build first");

  const appDir = mkdtempSync(path.join(os.tmpdir(), "seance-e2e-app-"));
  let gateway;
  let child;
  let anchor;
  const output = [];
  try {
    // The server drops empty channels, so keep one alive for the whole bundle run.
    anchor = await openAnchor();

    // Layout the bundle expects: <app>/app.json, <app>/.app_secret, <app>/backend/dist/server.js, <app>/data/config.json.
    mkdirSync(path.join(appDir, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(appDir, "data"), { recursive: true, mode: 0o700 });
    copyFileSync(bundle, path.join(appDir, "backend", "dist", "server.js"));
    writeFileSync(path.join(appDir, "app.json"), JSON.stringify({ name: APP_NAME }));
    writeFileSync(path.join(appDir, ".app_secret"), `${STUB_APP_SECRET}\n`, { mode: 0o600 });
    const configFile = path.join(appDir, "data", "config.json");
    writeFileSync(configFile, JSON.stringify({ host, nick, secret }), { mode: 0o600 });
    log("bundle: temporary app directory ready");

    gateway = await startStubGateway(configFile);
    const port = await freePort();
    // Only what the Crew gateway gives a backend (see spike/RUNTIME.md). The real secret is not in the environment.
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? appDir,
      PORT: String(port),
      NODE_ENV: "production",
      KIROCREW_APP_NAME: APP_NAME,
      KIROCREW_HOME: appDir,
      KIROCREW_GATEWAY_ORIGIN: `http://127.0.0.1:${gateway.port}`,
      KIROCREW_PROXY_SECRET: STUB_PROXY_SECRET,
      KIROCREW_SANDBOX_ACTIVE: "1",
      // The debug trace lets the MCP check prove that no KICK line was sent. PASS is redacted at every level.
      SEANCE_CREW_LOG_LEVEL: "debug",
    };
    child = spawn(process.execPath, [path.join(appDir, "backend", "dist", "server.js")], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    let exitInfo;
    exited.then((info) => (exitInfo = info));
    let pending = "";
    const records = [];
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output.push(text);
      pending += text;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        try {
          records.push(JSON.parse(line));
        } catch {
          // Not a JSON log line; kept in `output` for the secret check.
        }
      }
    });
    child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
    log(`bundle: started node server.js on port ${port}`);

    await until(
      "GET /health",
      async () => {
        if (exitInfo !== undefined) throw new Error(`the bundle exited early (code ${exitInfo.code})`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          return response.ok && (await response.text()) === '{"ok":true}';
        } catch {
          return false;
        }
      },
      BUNDLE_TIMEOUT_MS.health,
    );
    log("bundle: /health answers {\"ok\":true}");

    await until(
      "bridge state registered",
      () => {
        if (exitInfo !== undefined) throw new Error(`the bundle exited early (code ${exitInfo.code})`);
        const terminal = records.find((r) => r.msg === "bridge state" && (r.state === "auth-failed" || r.state === "nick-rejected" || r.state === "config-invalid"));
        if (terminal !== undefined) {
          throw new Error(`the bridge stopped in state ${terminal.state}; check SEANCE_E2E_HOST, SEANCE_E2E_NICK and SEANCE_E2E_SECRET (the anchor must use a different account)`);
        }
        return records.some((r) => r.msg === "bridge state" && r.state === "registered");
      },
      BUNDLE_TIMEOUT_MS.registered,
    );
    log("bundle: bridge registered");

    const finished = await until("state rebuild finished", () => records.find((r) => r.msg === "state rebuild finished"), BUNDLE_TIMEOUT_MS.rebuild);
    if (!(typeof finished.channels === "number" && finished.channels >= 1)) {
      throw new Error(`the rebuild found ${String(finished.channels)} channels, expected at least 1`);
    }
    log(`bundle: rebuild finished with ${finished.channels} channel(s)`);

    await checkMcp(port, anchor.channel, records);

    child.kill("SIGTERM");
    const result = await Promise.race([exited, sleep(BUNDLE_TIMEOUT_MS.exit).then(() => undefined)]);
    if (result === undefined) throw new Error("the bundle did not exit within 15 s of SIGTERM");
    if (result.code !== 0) throw new Error(`the bundle exited with code ${result.code} (signal ${result.signal}) after SIGTERM, expected 0`);
    log("bundle: SIGTERM -> exit code 0");

    if (existsSync(path.join(appDir, "data", "bridge.lock"))) throw new Error("data/bridge.lock still exists after SIGTERM");
    log("bundle: lock file removed");

    const text = output.join("");
    for (const [name, value] of [["the Séance secret", secret], ["the anchor secret", anchorSecret], ["the stub proxy secret", STUB_PROXY_SECRET], ["the stub token", STUB_TOKEN], ["the stub app secret", STUB_APP_SECRET]]) {
      if (value !== "" && text.includes(value)) throw new Error(`${name} appears in the bundle output`);
    }
    log("bundle: no secret in stdout or stderr");
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    gateway?.server.close();
    if (anchor !== undefined) {
      await anchor.close();
      log("anchor: quit");
    }
    rmSync(appDir, { recursive: true, force: true });
    log("bundle: temporary directory removed");
  }
}

let exitCode = 0;
const only = process.env.SEANCE_E2E_ONLY ?? "";
if (only !== "bundle") {
  try {
    await run();
    log("all steps passed");
  } catch (err) {
    exitCode = 1;
    process.stderr.write(`e2e: FAILED: ${redact(err instanceof Error ? err.message : String(err))}\n`);
    if (failures.length > 0) process.stderr.write(`e2e: ${failures.join("; ")}\n`);
  } finally {
    await cleanup();
  }
}
const anchorMissing = [
  ["SEANCE_E2E_ANCHOR_NICK", anchorNick],
  ["SEANCE_E2E_ANCHOR_SECRET", anchorSecret],
]
  .filter(([, value]) => value === "")
  .map(([name]) => name);
if (only !== "ws" && anchorNick !== "" && anchorNick.toLowerCase() === nick.toLowerCase()) {
  exitCode = 1;
  process.stderr.write("e2e: BUNDLE FAILED: SEANCE_E2E_ANCHOR_NICK must differ from SEANCE_E2E_NICK (Séance allows one session per account)\n");
} else if (only !== "ws" && anchorMissing.length > 0) {
  log(`bundle phase skipped: set ${anchorMissing.join(" and ")} (a second account for the anchor)`);
} else if (only !== "ws") {
  try {
    await runBundle();
    log("bundle phase passed");
  } catch (err) {
    exitCode = 1;
    process.stderr.write(`e2e: BUNDLE FAILED: ${redact(err instanceof Error ? err.message : String(err))}\n`);
  }
}
process.exit(exitCode);
