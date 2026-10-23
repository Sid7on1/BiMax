/** Keep unresolved engine notices across renderer reloads. Reset at each new engine's ready
 * boundary; that engine immediately replays its own current failures from the protocol host. */
export class CapabilityReplay {
  private active = new Map<string, any>();
  accept(message: any): void {
    if (message?.t === 'ready') this.clear();
    const status = message?.t === 'event' && message.name === 'message'
      ? message.args?.[0]?.payload?.capabilityStatus : null;
    if (!status || typeof status.id !== 'string') return;
    // Per-call tool notices describe one turn (see isTurnScopedCapability); replaying them into a
    // reloaded renderer is what kept a single failed call on screen indefinitely.
    if (status.id.startsWith('tool:') || status.id === 'tool-activation') return;
    if (status.state === 'ready') this.active.delete(status.id);
    else if (['unavailable', 'degraded'].includes(status.state)
      && (this.active.has(status.id) || this.active.size < 128)) this.active.set(status.id, message);
  }
  clear(): void { this.active.clear(); }
  snapshot(): any[] { return [...this.active.values()]; }
}
