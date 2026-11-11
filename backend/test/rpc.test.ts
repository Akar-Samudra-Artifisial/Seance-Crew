import { describe, expect, it } from "vitest";
import { classify, parseBody, RpcCode, rpcError, rpcResult } from "../src/mcp/rpc.js";

describe("parseBody", () => {
  it("reports invalid JSON as a parse error", () => {
    for (const text of ["", "{", "not json", "{'a':1}", "[1,"]) expect(parseBody(text)).toEqual({ kind: "parse-error" });
  });

  it.each([["number", "5"], ["string", '"x"'], ["null", "null"], ["boolean", "true"]])("treats a JSON %s as an invalid request", (_n, text) => {
    expect(parseBody(text)).toEqual({ kind: "single", message: { kind: "invalid", id: null } });
  });

  it("reads a request", () => {
    expect(parseBody('{"jsonrpc":"2.0","id":7,"method":"ping"}')).toEqual({
      kind: "single",
      message: { kind: "request", id: 7, method: "ping", params: undefined },
    });
  });

  it("accepts string ids and keeps params", () => {
    expect(parseBody('{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"x"}}')).toEqual({
      kind: "single",
      message: { kind: "request", id: "a", method: "tools/call", params: { name: "x" } },
    });
  });

  it("detects a notification by the missing id", () => {
    expect(parseBody('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({
      kind: "single",
      message: { kind: "notification", method: "notifications/initialized", params: undefined },
    });
  });

  it("does not treat id:null as a notification", () => {
    expect(classify({ jsonrpc: "2.0", id: null, method: "ping" })).toEqual({ kind: "invalid", id: null });
  });

  it.each([
    ["missing jsonrpc", { id: 1, method: "ping" }],
    ["wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["missing method", { jsonrpc: "2.0", id: 1 }],
    ["non-string method", { jsonrpc: "2.0", id: 1, method: 5 }],
    ["empty method", { jsonrpc: "2.0", id: 1, method: "" }],
  ])("marks %s as invalid and echoes a usable id", (_n, value) => {
    expect(classify(value)).toEqual({ kind: "invalid", id: 1 });
  });

  it("does not echo an unusable id", () => {
    expect(classify({ jsonrpc: "2.0", id: { a: 1 }, method: 5 })).toEqual({ kind: "invalid", id: null });
    expect(classify({ jsonrpc: "2.0", id: [], method: "ping" })).toEqual({ kind: "invalid", id: null });
  });

  it("splits a batch with mixed notifications, requests and invalid elements", () => {
    const parsed = parseBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        5,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    );
    expect(parsed.kind).toBe("batch");
    if (parsed.kind !== "batch") return;
    expect(parsed.messages.map((m) => m.kind)).toEqual(["request", "notification", "invalid", "request"]);
  });

  it("treats an empty batch as one invalid request", () => {
    expect(parseBody("[]")).toEqual({ kind: "single", message: { kind: "invalid", id: null } });
  });
});

describe("replies", () => {
  it("builds results and errors", () => {
    expect(rpcResult(1, { ok: true })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(rpcError(null, RpcCode.ParseError, "Parse error")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("uses the standard codes", () => {
    expect(RpcCode).toMatchObject({ ParseError: -32700, InvalidRequest: -32600, MethodNotFound: -32601, InvalidParams: -32602 });
  });
});
