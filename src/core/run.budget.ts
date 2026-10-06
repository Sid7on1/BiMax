import { AsyncLocalStorage } from 'async_hooks';
import { GovernorVetoError } from './errors';

// Shared by every worker in one user run. CAS reservations bound parallel fan-out before the wire.
// Slots: consumed/reserved tokens, consumed/reserved micro-USD, token ceiling, micro-USD ceiling.
const current = new AsyncLocalStorage<SharedArrayBuffer>();
let inherited: SharedArrayBuffer | undefined;
export function inheritRunBudget(buffer?: SharedArrayBuffer): void { inherited = buffer; }
export function activeRunBudget(): SharedArrayBuffer | undefined { return current.getStore() ?? inherited; }
function positive(value: string | undefined, fallback: number, ceiling: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= ceiling ? n : fallback;
}
export function createRunBudget(env: NodeJS.ProcessEnv = process.env): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT);
  const counters = new BigInt64Array(buffer);
  counters[2] = BigInt(Math.ceil(positive(env.BIMAX_RUN_MAX_TOKENS, 2_000_000, Number.MAX_SAFE_INTEGER)));
  counters[3] = BigInt(Math.ceil(positive(env.BIMAX_RUN_MAX_USD, 5, Number.MAX_SAFE_INTEGER / 1_000_000) * 1_000_000));
  return buffer;
}
export function inRunBudget<T>(buffer: SharedArrayBuffer, action: () => T): T { return current.run(buffer, action); }
function amount(n: number): bigint {
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new GovernorVetoError('Invalid run-budget amount.');
  return BigInt(Math.ceil(n));
}
function reserveSlot(counters: BigInt64Array, slot: number, value: bigint): void {
  for (;;) {
    const old = Atomics.load(counters, slot);
    if (old + value > Atomics.load(counters, slot + 2)) throw new GovernorVetoError(`Run ${slot === 0 ? 'token' : 'spend'} ceiling reached. Start a new run or raise BIMAX_RUN_MAX_${slot === 0 ? 'TOKENS' : 'USD'}.`);
    if (Atomics.compareExchange(counters, slot, old, old + value) === old) return;
  }
}
export function reserveRun(tokens: number, usd: number): { settle(tokens?: number, usd?: number): void } {
  const buffer = activeRunBudget();
  if (!buffer) return { settle() {} };
  const counters = new BigInt64Array(buffer);
  const reservedTokens = amount(tokens), reservedUsd = amount(usd * 1_000_000);
  reserveSlot(counters, 0, reservedTokens);
  try { reserveSlot(counters, 1, reservedUsd); }
  catch (error) { Atomics.sub(counters, 0, reservedTokens); throw error; }
  let settled = false;
  return { settle(actualTokens = tokens, actualUsd = usd) {
    if (settled) return;
    const actualT = amount(actualTokens), actualU = amount(actualUsd * 1_000_000);
    settled = true;
    Atomics.add(counters, 0, actualT - reservedTokens);
    Atomics.add(counters, 1, actualU - reservedUsd);
  } };
}
