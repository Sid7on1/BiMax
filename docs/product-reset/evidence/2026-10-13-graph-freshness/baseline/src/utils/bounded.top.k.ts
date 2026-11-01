/**
 * Exact streaming top-k, using a worst-first binary heap. `compare` has Array.sort semantics:
 * negative means better. Equal values keep input order, including at the capacity boundary.
 * Only k candidates are retained; scoring the input still belongs to the caller.
 */
export class BoundedTopK<T> {
  private readonly heap: Array<{ value: T; order: number }> = [];
  private readonly capacity: number;
  private nextOrder = 0;

  constructor(capacity: number, private readonly compare: (a: T, b: T) => number) {
    // Match slice(0, depth) for the nonnegative retrieval depths, including NaN and Infinity.
    this.capacity = Number.isNaN(capacity) ? 0 : Math.max(0, Math.floor(capacity));
  }

  get size(): number { return this.heap.length; }

  add(value: T): void {
    const order = this.nextOrder++;
    if (this.capacity === 0) return;
    if (this.heap.length < this.capacity) {
      this.heap.push({ value, order });
      let child = this.heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (this.compareEntries(this.heap[child], this.heap[parent]) <= 0) break;
        [this.heap[parent], this.heap[child]] = [this.heap[child], this.heap[parent]];
        child = parent;
      }
      return;
    }
    const worst = this.heap[0];
    if ((this.compare(value, worst.value) || order - worst.order) >= 0) return;
    this.heap[0] = { value, order };
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const child = right < this.heap.length && this.compareEntries(this.heap[right], this.heap[left]) > 0
        ? right : left;
      if (this.compareEntries(this.heap[parent], this.heap[child]) >= 0) break;
      [this.heap[parent], this.heap[child]] = [this.heap[child], this.heap[parent]];
      parent = child;
    }
  }

  /** A sorted snapshot; later additions and repeated snapshots are safe. */
  sorted(): T[] {
    return [...this.heap].sort((a, b) => this.compareEntries(a, b)).map(entry => entry.value);
  }

  private compareEntries(a: { value: T; order: number }, b: { value: T; order: number }): number {
    return this.compare(a.value, b.value) || a.order - b.order;
  }
}
