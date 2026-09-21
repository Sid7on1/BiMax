/**
 * Mid-run steering (backlog F7): words the user sends while a task is working reach the running turn at its next step,
 * instead of waiting in the queue until the turn ends. The session puts them here (HeadlessSession.steer); the agent
 * loop takes them at the start of every round, and once more before it lets a turn end.
 *
 * They are the user's own words, so the message does not start with an engine tag: the continuation state keeps them
 * quoted as something the user said (context/continuation.ts), not as engine chatter.
 */
const inbox: string[] = [];

export function pushSteer(text: string): void {
  const trimmed = text.trim();
  if (trimmed) inbox.push(trimmed);
}

/** Everything waiting, oldest first; the inbox is empty afterwards. */
export function drainSteer(): string[] {
  return inbox.splice(0, inbox.length);
}

export function hasSteer(): boolean { return inbox.length > 0; }

/** Stop drops what was waiting, as it drops queued messages. */
export function clearSteer(): void { inbox.length = 0; }

export function steerMessage(text: string): string {
  return `The user added this while you were working. Adjust the task you are doing to it now, without starting over:\n\n${text}`;
}
