import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/irc/store.js";
import { BUSY_MESSAGE, INTERNAL_ERROR_MESSAGE, MAX_CONCURRENT_CALLS } from "../src/mcp/invoke.js";
import { createToolRegistry } from "../src/mcp/tools.js";
import { errorResult, textResult, type McpContext, type ToolDef, type ToolResult } from "../src/mcp/types.js";
import { createLogger } from "../src/log.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { MCP_APP_SECRET, MCP_SECRET, MCP_TOKEN, bootMcp, cleanupMcp, echoKicks, echoModes, eventually, textOf } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const stubContext = (secret = "tok-secret-xyz") => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const ctx: McpContext = {
    store: new Store(clock),
    bridge: { state: "registered", send: () => undefined },
    clock,
    logger: createLogger([secret], (l) => logs.push(l), () => clock.now(), "debug"),
  };
  return { ctx, logs };
};

const tool = (name: string, call: ToolDef["call"]): ToolDef => ({ name, description: "stub", inputSchema: { type: "object" }, call });

describe("error mapping", () => {
  it("answers a generic message for a throwing handler, with no stack and no error text, and logs it redacted", async () => {
    const { ctx, logs } = stubContext();
    const registry = createToolRegistry(ctx, [
      tool("boom", async () => {
        throw new Error("exploded with tok-secret-xyz at /Users/someone/project/file.ts:12");
      }),
    ]);
    const result = await registry.call("boom", {});
    expect(result).toEqual(errorResult(INTERNAL_ERROR_MESSAGE));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("exploded");
    expect(serialized).not.toContain("tok-secret-xyz");
    expect(serialized).not.toMatch(/\bat \S+:\d+/);
    const logText = logs.join("\n");
    expect(logText).toContain("tool call failed");
    expect(logText).toContain("exploded");
    expect(logText).not.toContain("tok-secret-xyz");
    expect(logText).toContain("***");
  });

  it("also maps a synchronous throw and a non-Error throw", async () => {
    const { ctx } = stubContext();
    const registry = createToolRegistry(ctx, [
      tool("sync", () => {
        throw new TypeError("nope");
      }),
      tool("string", () => Promise.reject("just a string")),
    ]);
    expect(await registry.call("sync", {})).toEqual(errorResult(INTERNAL_ERROR_MESSAGE));
    expect(await registry.call("string", {})).toEqual(errorResult(INTERNAL_ERROR_MESSAGE));
  });

  it("returns undefined for an unknown tool name, including prototype keys", () => {
    const { ctx } = stubContext();
    const registry = createToolRegistry(ctx, []);
    for (const name of ["nope", "__proto__", "constructor", "toString"]) expect(registry.call(name, {})).toBeUndefined();
  });
});

describe("busy limit", () => {
  const blocking = () => {
    const releases: Array<(r: ToolResult) => void> = [];
    const def = tool("slow", () => new Promise<ToolResult>((resolve) => releases.push(resolve)));
    return { def, releaseAll: () => releases.splice(0).forEach((r) => r(textResult("done"))), started: () => releases.length };
  };

  it("lets 8 calls run and answers the ninth with busy", async () => {
    const { ctx } = stubContext();
    const slow = blocking();
    const registry = createToolRegistry(ctx, [slow.def]);
    const running = Array.from({ length: MAX_CONCURRENT_CALLS }, () => registry.call("slow", {}));
    expect(slow.started()).toBe(MAX_CONCURRENT_CALLS);
    const ninth = await registry.call("slow", {});
    expect(ninth).toEqual(errorResult(BUSY_MESSAGE));
    expect(slow.started()).toBe(MAX_CONCURRENT_CALLS);
    slow.releaseAll();
    expect((await Promise.all(running)).every((r) => r?.isError !== true)).toBe(true);
    // Capacity is back.
    const again = registry.call("slow", {});
    slow.releaseAll();
    expect((await again)?.isError).toBeUndefined();
  });

  it("frees the slot when a call throws", async () => {
    const { ctx } = stubContext();
    const registry = createToolRegistry(ctx, [tool("bad", async () => { throw new Error("x"); })]);
    for (let i = 0; i < MAX_CONCURRENT_CALLS * 3; i++) expect(await registry.call("bad", {})).toEqual(errorResult(INTERNAL_ERROR_MESSAGE));
  });

  it("is enforced over HTTP: eight waiting whois calls, the ninth call gets busy", async () => {
    const ircd = new FakeIrcd();
    ircd.silentWhois = true;
    const h = await bootMcp({ ircd });
    const waiting = h.app.store.listenerCount("whois-done");
    const calls = Array.from({ length: MAX_CONCURRENT_CALLS }, (_, i) => h.call("whois", { nick: `user${i}` }));
    await eventually(() => h.app.store.listenerCount("whois-done") === waiting + MAX_CONCURRENT_CALLS);
    const ninth = await h.call("list_channels");
    expect(ninth.isError).toBe(true);
    expect(textOf(ninth)).toBe(BUSY_MESSAGE);
    h.clock.advance(5_000);
    const results = await Promise.all(calls);
    expect(results.every((r) => r.isError === true && textOf(r).includes("timed out"))).toBe(true);
    expect((await h.call("list_channels")).isError).toBeUndefined();
  });
});

describe("secret hygiene", () => {
  it("never puts the Séance secret, the app secret or the token in a log line or a tool result across a full session", async () => {
    const ircd = new FakeIrcd();
    ircd.channels = [{ name: "#fix", count: 2, topic: "t", names: ["@crew", "+coder"] }];
    ircd.whois = { coder: { info: ["model: claude"] } };
    echoModes(ircd);
    echoKicks(ircd);
    ircd.hooks.push((m, conn, d) => {
      if (m.command === "INVITE") d.reply(conn, `:ChanServ!c@s NOTICE ${m.params[1] ?? ""} :${m.params[0] ?? ""} is ready`);
      if (m.command === "KICK") d.reply(conn, `:ChanServ!c@s NOTICE ${m.params[0] ?? ""} :session closed, worktree reset to abc1234`);
    });
    const h = await bootMcp({ ircd });
    // The send queue refills one token per second of fake time; give it room before each call.
    const step = async (name: string, args: unknown = {}): Promise<void> => {
      h.advance(2_000);
      await h.call(name, args);
    };
    await step("list_channels");
    await step("read", { channel: "#fix" });
    await step("say", { channel: "#fix", text: "hi" });
    await step("summon", { channel: "#fix" });
    await step("whois", { nick: "coder" });
    await step("grant_op", { channel: "#fix", agent: "coder", mode: "+v", confirm: true });
    await step("exorcise", { channel: "#fix", agent: "coder", confirm: true });
    await step("credits");
    await step("read", { channel: "#nope" });
    await step("grant_op", { channel: "#fix", agent: "coder", mode: "+o" });
    await h.rpc({ jsonrpc: "2.0", id: 9, method: "nope" });
    // The scan itself runs in cleanupMcp (afterEach) over every harness. Here we prove the scan has something to read.
    const logText = h.logs.join("\n");
    expect(logText).toContain("PASS ***");
    expect(logText).not.toContain(MCP_SECRET);
    expect(logText).not.toContain(MCP_APP_SECRET);
    expect(logText).not.toContain(MCP_TOKEN);
  });

  it("makes cleanupMcp fail when a secret does leak (the guard itself works)", async () => {
    const h = await bootMcp();
    h.logs.push(`something with ${MCP_SECRET} in it`);
    await expect(cleanupMcp()).rejects.toThrow(/secret hygiene: Séance secret/);
  });
});

describe("docs (Req 8.3)", () => {
  const read = (...parts: string[]): string => readFileSync(path.join(REPO, ...parts), "utf8");

  it("states the accepted /mcp risk and the confirm requirement in the security steering file and the README", () => {
    for (const text of [read(".kiro", "steering", "security.md"), read("README.md")]) {
      expect(text).toContain("any local process of the same user can call /mcp");
      expect(text).toContain("confirm:true");
    }
  });

  it("documents in kirocrew.md that the gateway sends no credential on MCP calls", () => {
    expect(read(".kiro", "steering", "kirocrew.md")).toContain("The gateway sends no header and no secret on MCP calls");
  });

  it("has a Security section in the README", () => {
    expect(read("README.md")).toMatch(/^## Security$/m);
  });
});
