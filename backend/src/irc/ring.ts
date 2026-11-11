// Fixed-capacity ring buffer with monotonic sequence numbers.

export interface Sequenced {
  readonly seq: number;
}

export interface SinceResult<T> {
  readonly items: readonly T[];
  /** True when lines after the requested sequence number are no longer available (evicted or from before a restart). */
  readonly lost: boolean;
}

export class Ring<T extends Sequenced> {
  private readonly capacity: number;
  private readonly buffer: T[] = [];
  private nextSeq = 1;

  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("ring capacity must be a positive integer");
    this.capacity = capacity;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** The sequence number of the newest item, or 0 when nothing was ever pushed. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Append an item built with the next sequence number; the oldest item is dropped when full. */
  push(make: (seq: number) => T): T {
    const item = make(this.nextSeq);
    this.nextSeq += 1;
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    return item;
  }

  /** Items with a sequence number greater than `afterSeq`, in increasing order, plus whether some were lost. */
  since(afterSeq: number): SinceResult<T> {
    const items = this.buffer.filter((i) => i.seq > afterSeq);
    const last = this.lastSeq;
    const oldest = this.buffer[0]?.seq ?? this.nextSeq;
    // A cursor ahead of the newest item can only come from before a restart.
    const lost = afterSeq > last || (afterSeq < last && oldest > afterSeq + 1);
    return { items, lost };
  }

  /** The newest `count` items, oldest first. */
  newest(count: number): readonly T[] {
    return count >= this.buffer.length ? [...this.buffer] : this.buffer.slice(this.buffer.length - count);
  }
}
