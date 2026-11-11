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
// registration, state rebuild (at least one channel), SIGTERM (exit 0, lock file gone) and no secret in the
// process output. /health is deliberately minimal, so the bridge state is read from the
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
