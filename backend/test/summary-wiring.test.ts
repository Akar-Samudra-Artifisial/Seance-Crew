// steward-agent task 6: the summary service feeds GET /api/summary and the MCP `credits` tool, and stops with the app.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTER_WAIT_MS } from "../src/summary.js";
import { bootApi } from "./apiHelpers.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { cleanupMcp } from "./mcpHelpers.js";

afterEach(cleanupMcp);

const structured = (r: { structuredContent?: Readonly<Record<string, unknown>> }) => r.structuredContent as Record<string, unknown>;

/** A server that never answers the handshake, so the bridge stays unregistered and the first summary waits. */
const unregistered = (): FakeIrcd => {
  const ircd = new FakeIrcd();
  ircd.stallRegistration = true;
  return ircd;
};

describe("summary wiring", () => {
  it("both surfaces return null before the first run", async () => {
    const h = await bootApi({ background: true, ircd: unregistered() });
    expect(h.app.summaryService?.latest()).toBeNull();
    const api = await h.api({ path: "/api/summary" });
    expect(api.status).toBe(200);
    expect(api.json).toEqual({ summary: null });
    const tool = await h.call("credits", {});
    expect(structured(tool)["summary"]).toBeNull();
  });

  it("both surfaces return the same summary after the run", async () => {
    const h = await bootApi({ background: true, ircd: unregistered() });
    h.app.store.setCreditsFromWhois("#dev", 1.25, 10);
    h.advance(REGISTER_WAIT_MS); // no registration within 10 minutes: the first run uses last known figures
    const expected = h.app.summaryService?.latest();
    expect(expected).toMatchObject({ stale: true, channels: [{ name: "#dev", used: 1.25, total: 10 }] });
    const api = await h.api({ path: "/api/summary" });
    expect((api.json as { summary: unknown }).summary).toEqual(expected);
    const tool = await h.call("credits", {});
    expect(structured(tool)["summary"]).toEqual(expected);
  });

  it("a registered bridge runs the first summary right away and writes data/summary.json", async () => {
    const h = await bootApi({ background: true });
    await h.call("credits", {}); // lets the fake network and the pending run settle
    h.ircd.run();
    const file = JSON.parse(readFileSync(path.join(h.root, "data", "summary.json"), "utf8")) as { latest: unknown; history: unknown[] };
    expect(file.latest).not.toBeNull();
    expect(h.app.summaryService?.latest()).toEqual(file.latest);
    expect(((await h.api({ path: "/api/summary" })).json as { summary: unknown }).summary).toEqual(file.latest);
  });

  it("is off without the background option: no files, no summary", async () => {
    const h = await bootApi();
    expect(h.app.summaryService).toBeNull();
    expect((await h.api({ path: "/api/summary" })).json).toEqual({ summary: null });
    h.advance(REGISTER_WAIT_MS);
    expect(existsSync(path.join(h.root, "data", "summary.json"))).toBe(false);
  });

  it("shutdown stops the summary timer and writes the credits snapshot", async () => {
    const h = await bootApi({ background: true, ircd: unregistered() });
    const timersWithService = h.clock.pending;
    h.app.store.setCreditsFromWhois("#dev", 2, 5);
    await h.stop();
    expect(timersWithService).toBeGreaterThan(0);
    expect(h.clock.pending).toBe(0); // the summary fallback timer and the snapshot timer are both gone
    // The service's fallback timer is gone: a long wait runs nothing.
    h.clock.advance(2 * REGISTER_WAIT_MS);
    expect(existsSync(path.join(h.root, "data", "summary.json"))).toBe(false);
    const snap = JSON.parse(readFileSync(path.join(h.root, "data", "credits.json"), "utf8")) as { channels: unknown[] };
    expect(snap.channels).toEqual([{ name: "#dev", used: 2, total: 5, updatedAt: expect.any(Number) }]);
  });
});
