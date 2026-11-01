/** Pending renderer requests own their deadlines until reply, failure or owner retirement. */
export class EngineRequests<T> {
  private pending = new Map<number, (value: T) => void>();

  constructor(private failure: (reason: string) => T) {}

  request(id: number, timeoutMs: number, timeoutReason: string, send: () => void): Promise<T> {
    return new Promise(resolve => {
      const finish = (value: T): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        resolve(value);
      };
      // Arm before sending: an immediate bridge answer must clear this same deadline.
      const timer = setTimeout(() => finish(this.failure(timeoutReason)), timeoutMs);
      this.pending.set(id, finish);
      try { send(); }
      catch (error) { finish(this.failure(error instanceof Error ? error.message : String(error))); }
    });
  }

  resolve(id: number, value: T): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(value);
    return true;
  }

  cancelAll(reason: string): void {
    for (const finish of [...this.pending.values()]) finish(this.failure(reason));
  }
}
