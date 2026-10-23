/**
 * Self-critic loop. When enabled, after the agent finishes a turn it reviews its own
 * work against the original request and, if it finds defects, gets one more pass to
 * fix them before the result is presented. Off by default (it costs extra tokens).
 */
let enabled = false;

export function setSelfCriticEnabled(value: boolean): void {
  enabled = value;
}

export function isSelfCriticEnabled(): boolean {
  return enabled;
}
