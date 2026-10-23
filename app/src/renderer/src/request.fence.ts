/** Latest response per resource, invalidated together when a project changes or a panel leaves. */
export class RequestFence {
  private epoch = 0;
  private requests = new Map<string, number>();
  begin(key: string): () => boolean {
    const epoch = this.epoch;
    const sequence = (this.requests.get(key) ?? 0) + 1;
    this.requests.set(key, sequence);
    return () => this.epoch === epoch && this.requests.get(key) === sequence;
  }
  invalidate(): void { this.epoch++; this.requests.clear(); }
}
