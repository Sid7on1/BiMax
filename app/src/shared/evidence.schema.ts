// The shared causal evidence vocabulary (owner sections 28/29) — re-exported from the engine's own
// schema rather than mirrored into a generated copy. The engine LEDGER (src/evidence/ledger.ts) is
// deliberately NOT shared: the vocabulary is common, the store is not. Desktop keeps its own
// bounded, user-deletable evidence store.
export * from '../../../src/evidence/schema';
