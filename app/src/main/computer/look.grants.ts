/**
 * Which apps each Bimax Thread may look at (record 65, stage 2) — decided by the user on a grant card, held by the app.
 *
 * Never by the engine: a grant is set only here, from the user's answer to a card the app itself raised. A "no" is
 * remembered for the Thread too, so the task is told no again instead of asking the user again. A Thread that stops or
 * is closed loses every grant.
 */
export class LookGrants {
  private allowed = new Map<string, Set<string>>();
  private refused = new Map<string, Set<string>>();

  allow(threadId: string, bundleId: string): void {
    this.refused.get(threadId)?.delete(bundleId);
    (this.allowed.get(threadId) ?? this.allowed.set(threadId, new Set()).get(threadId)!).add(bundleId);
  }

  refuse(threadId: string, bundleId: string): void {
    this.allowed.get(threadId)?.delete(bundleId);
    (this.refused.get(threadId) ?? this.refused.set(threadId, new Set()).get(threadId)!).add(bundleId);
  }

  decision(threadId: string, bundleId: string): 'allowed' | 'refused' | 'unasked' {
    if (this.allowed.get(threadId)?.has(bundleId)) return 'allowed';
    if (this.refused.get(threadId)?.has(bundleId)) return 'refused';
    return 'unasked';
  }

  apps(threadId: string): string[] {
    return [...(this.allowed.get(threadId) ?? [])];
  }

  /** Everything this Thread was allowed or refused, gone. */
  end(threadId: string): string[] {
    const had = this.apps(threadId);
    this.allowed.delete(threadId);
    this.refused.delete(threadId);
    return had;
  }
}
