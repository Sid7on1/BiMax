/**
 * The agent gates Settings can switch, and the live flag each one drives.
 *
 * Each gate is a module-level flag (diffApproval.ts, blastGate.ts, …) that only its slash command set.
 * The command ALSO saved the choice to the config file, and the app's Settings window wrote that same
 * file key — so Settings → Agent safety → "Diff approval", "Blast-radius gate", "Sandboxed shell" and
 * Agent behavior → "Self-critic", "Adversarial verify", "Auto-verify edits", "Git auto-commit" all
 * showed a switch that saved and did nothing: nothing read the key back, not live and not at the next
 * boot (fix list item 12, measured 2026-09-30). Every flag defaults to off, as every config default
 * does, so a gate the user never touched is unchanged.
 *
 * `applyGateFlags` is the one bridge: startHeadless applies the saved config before the first message,
 * and the settings wire applies each patch the moment it is saved. Setters are required lazily so this
 * module stays cheap to import from the wire, which is unit-tested without booting anything.
 */

export const GATE_KEYS = [
  'diffApproval', 'blastGate', 'sandboxBash', 'autoVerify', 'selfCritic', 'adversarialVerify', 'gitAutoCommit',
] as const;

export type GateKey = typeof GATE_KEYS[number];

const SETTERS: Record<GateKey, () => (on: boolean) => void> = {
  diffApproval: () => (require('./diffApproval') as typeof import('./diffApproval')).setDiffApprovalEnabled,
  blastGate: () => (require('./blastGate') as typeof import('./blastGate')).setBlastGateEnabled,
  sandboxBash: () => (require('../sandbox/exec.sandbox') as typeof import('../sandbox/exec.sandbox')).setSandboxEnabled,
  autoVerify: () => (require('../sandbox/verify.loop') as typeof import('../sandbox/verify.loop')).setVerifyEnabled,
  selfCritic: () => (require('./selfCritic') as typeof import('./selfCritic')).setSelfCriticEnabled,
  adversarialVerify: () => (require('./adversarialVerifier') as typeof import('./adversarialVerifier')).setAdversarialVerifyEnabled,
  gitAutoCommit: () => (require('../tools/git.autocommit') as typeof import('../tools/git.autocommit')).setGitAutoCommitEnabled,
};

/**
 * Apply every gate key present in `cfg` as a boolean. Anything else — absent, null, a string — is left
 * alone rather than read as false, so a one-key patch from one Settings row touches one gate.
 * Returns the keys it applied.
 */
export function applyGateFlags(cfg: Record<string, unknown> | null | undefined): GateKey[] {
  const applied: GateKey[] = [];
  if (!cfg) return applied;
  for (const key of GATE_KEYS) {
    const value = cfg[key];
    if (typeof value !== 'boolean') continue;
    SETTERS[key]()(value);
    applied.push(key);
  }
  return applied;
}
