import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Ring } from "../src/irc/ring.js";

interface Item {
  readonly seq: number;
  readonly text: string;
}
const make = (text: string) => (seq: number): Item => ({ seq, text });

describe("Ring", () => {
  it("assigns increasing sequence numbers from 1", () => {
    const ring = new Ring<Item>(5);
    expect(ring.push(make("a")).seq).toBe(1);
    expect(ring.push(make("b")).seq).toBe(2);
    expect(ring.lastSeq).toBe(2);
  });

  it("drops the oldest item when full and keeps sequence numbers monotonic", () => {
    const ring = new Ring<Item>(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push(make(t));
    expect(ring.size).toBe(3);
    expect(ring.newest(10).map((i) => [i.seq, i.text])).toEqual([[3, "c"], [4, "d"], [5, "e"]]);
  });

  it("returns only newer items, in order", () => {
    const ring = new Ring<Item>(10);
    for (const t of ["a", "b", "c", "d"]) ring.push(make(t));
    const r = ring.since(2);
    expect(r.items.map((i) => i.text)).toEqual(["c", "d"]);
    expect(r.lost).toBe(false);
    expect(ring.since(4)).toEqual({ items: [], lost: false });
  });

  it("reports lost lines after eviction", () => {
    const ring = new Ring<Item>(3);
    for (let i = 0; i < 10; i++) ring.push(make(`m${i}`));
    expect(ring.since(8).lost).toBe(false); // seq 9 and 10 are still there
    expect(ring.since(5).lost).toBe(true); // 6 was evicted
    expect(ring.since(0).lost).toBe(true);
    expect(ring.since(5).items.map((i) => i.seq)).toEqual([8, 9, 10]);
  });

  it("reports lost for a cursor from before a restart (ahead of the newest item)", () => {
    const ring = new Ring<Item>(3);
    ring.push(make("a"));
    expect(ring.since(120)).toEqual({ items: [], lost: true });
  });

  it("is not lost for an empty ring asked from 0", () => {
    expect(new Ring<Item>(3).since(0)).toEqual({ items: [], lost: false });
  });

  it("rejects an invalid capacity", () => {
    expect(() => new Ring<Item>(0)).toThrow(RangeError);
  });
});

describe("Property 4: ring buffer ordering and loss", () => {
  it("since() is ordered and lost reports exactly the evicted lines", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), (cap, pushes, after) => {
        const ring = new Ring<Item>(cap);
        for (let i = 0; i < pushes; i++) ring.push(make(`m${i}`));
        const { items, lost } = ring.since(after);
        for (let i = 1; i < items.length; i++) expect(items[i]!.seq).toBeGreaterThan(items[i - 1]!.seq);
        expect(items.every((i) => i.seq > after)).toBe(true);
        const wanted = Math.max(0, pushes - after);
        const evicted = wanted - items.length;
        if (after > pushes) expect(lost).toBe(true);
        else expect(lost).toBe(evicted > 0);
      }),
      { numRuns: 300 },
    );
  });
});
