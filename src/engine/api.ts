/**
 * The engine's public API: everything the Bimax app may take from the engine's source (record 64, M5).
 *
 * The app and the engine are one monolith with a boundary inside it. The app starts the engine from its built bundle
 * (never by importing it), talks to it in the protocol's messages, and takes source from `src/` through exactly two
 * doors: this file and `src/protocol/protocol.ts`. `app/src/__tests__/module.boundaries.test.ts` enforces it, so a
 * shortcut into an engine internal fails CI instead of quietly coupling the two.
 *
 * This file is bundled into the app's main process and its window by Rollup, which cannot bundle the engine
 * (`bimax-rollup-cannot-bundle-engine`). So it re-exports only modules that import nothing themselves, and it declares
 * the worker contract here rather than pulling it from the modules that implement it. The same test checks that.
 */

// ─── the worker contract (the monolith's channel, M1 + M3) ─────────────────────────────────────────────────────────

/**
 * What the app hands an engine worker thread as `workerData`. The port's type is structural on purpose: this file is
 * also compiled for the window, which has no Node types.
 */
export interface EngineWorkerData {
  /** The engine's working folder; a worker cannot chdir (src/engine/worker.folder.ts). */
  bimaxEngineRoot: string;
  /** The app's end of the protocol channel is kept by the app; this is the engine's end. */
  bimaxEnginePort: { postMessage(value: unknown): void };
}

/** The acknowledgement the app posts for engine output it has handled. Not a protocol message: the engine consumes it. */
export const PORT_ACK = '__ack';
export interface PortAck { t: typeof PORT_ACK; bytes: number }

/** Unacknowledged engine output allowed in flight, in bytes (UTF-16 code units, as the engine's queue counts them). */
export const DEFAULT_PORT_WINDOW_BYTES = 1024 * 1024;

// ─── shared definitions the app also needs ─────────────────────────────────────────────────────────────────────────

/** The evidence record format the engine writes and the app's evidence store reads. */
export * from '../evidence/schema';

/** Secret detection (rules ported from gitleaks): the engine scrubs what it saves, the app what it shows and exports. */
export { RULES, entropy, findSecrets, looksLikeSecret } from '../security/secret.scan';
export type { SecretRule, Found } from '../security/secret.scan';
