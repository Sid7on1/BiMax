import { AsyncLocalStorage } from 'async_hooks';

// Offline replays may overlap live work and each other. Their identity belongs to the async
// execution, never to a process-global switch that can mute or contaminate another conversation.
const replay = new AsyncLocalStorage<boolean>();
export function inReplayScope<T>(action: () => T): T { return replay.run(true, action); }
export function isReplayActive(): boolean { return replay.getStore() === true; }
