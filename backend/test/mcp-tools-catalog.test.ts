import { afterEach, describe, expect, it } from "vitest";
import { TOOLS, TOOL_NAMES } from "../src/mcp/tools.js";
import { bootMcp, cleanupMcp } from "./mcpHelpers.js";

afterEach(cleanupMcp);

describe("tool catalog", () => {
  it("has exactly the eight tools in the specified order", () => {
    expect(TOOL_NAMES).toEqual(["list_channels", "read", "say", "summon", "grant_op", "exorcise", "whois", "credits"]);
  });

  it("gives every tool a description and an object schema with additionalProperties: false", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("states that returned channel text is untrusted for every text-returning tool", () => {
    for (const name of ["list_channels", "read", "whois", "credits", "exorcise"]) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.description.toLowerCase(), name).toContain("untrusted");
    }
  });

  it("states that grant_op and exorcise need confirm: true after the human agrees", () => {
    for (const name of ["grant_op", "exorcise"]) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.description, name).toContain("confirm: true");
      expect(tool?.description, name).toContain("human");
    }
  });

  it("declares confirm as a required boolean", () => {
    for (const name of ["grant_op", "exorcise"]) {
      const schema = TOOLS.find((t) => t.name === name)?.inputSchema as { properties: Record<string, { type: string }>; required: string[] };
      expect(schema.properties["confirm"]?.type).toBe("boolean");
      expect(schema.required).toContain("confirm");
    }
  });

  it("documents the argument limits", () => {
    const say = TOOLS.find((t) => t.name === "say")?.inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(say.properties["text"]).toMatchObject({ minLength: 1, maxLength: 400 });
    const read = TOOLS.find((t) => t.name === "read")?.inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(read.properties["limit"]).toMatchObject({ minimum: 1, maximum: 200 });
    const grant = TOOLS.find((t) => t.name === "grant_op")?.inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(grant.properties["mode"]?.["enum"]).toEqual(["+v", "-v", "+o", "-o"]);
  });
});

describe("tools/list and tools/call over HTTP", () => {
  it("lists the catalog", async () => {
    const h = await bootMcp();
    const reply = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (reply.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it("answers -32602 for an unknown tool", async () => {
    const h = await bootMcp();
    const reply = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "format_disk", arguments: {} } });
    expect(reply.body).toMatchObject({ error: { code: -32602 } });
  });

  it("returns an isError result for invalid arguments and sends nothing", async () => {
    const h = await bootMcp();
    const before = h.sent().length;
    const result = await h.call("say", { channel: "#c", text: "hi", extra: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unknown property "extra"/);
    expect(h.sent()).toHaveLength(before);
  });
});
