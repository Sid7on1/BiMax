import { applyGateFlags, GATE_KEYS } from '../engine/gate.flags';
import { createConfigWire, CONFIG_WIRE_KEYS } from '../protocol/config.wire';
import { isDiffApprovalEnabled, setDiffApprovalEnabled } from '../engine/diffApproval';
import { isBlastGateEnabled, setBlastGateEnabled } from '../engine/blastGate';
import { isSelfCriticEnabled, setSelfCriticEnabled } from '../engine/selfCritic';
import { isAdversarialVerifyEnabled, setAdversarialVerifyEnabled } from '../engine/adversarialVerifier';
import { isVerifyEnabled, setVerifyEnabled } from '../sandbox/verify.loop';
import { isGitAutoCommitEnabled, setGitAutoCommitEnabled } from '../tools/git.autocommit';
import { setSandboxEnabled } from '../sandbox/exec.sandbox';

/**
 * Fix list item 12 (2026-09-30). Seven switches in Settings — Diff approval, Blast-radius gate,
 * Sandboxed shell, Self-critic, Adversarial verify, Auto-verify edits, Git auto-commit — saved the config
 * file and changed nothing: each gate is a module flag that only its slash command set, and nothing
 * read the saved key back, not when it was saved and not at the next boot. These pin both halves.
 */

const READERS: Record<string, () => boolean> = {
  diffApproval: isDiffApprovalEnabled,
  blastGate: isBlastGateEnabled,
  selfCritic: isSelfCriticEnabled,
  adversarialVerify: isAdversarialVerifyEnabled,
  autoVerify: isVerifyEnabled,
  gitAutoCommit: isGitAutoCommitEnabled,
};

function allOff(): void {
  setDiffApprovalEnabled(false); setBlastGateEnabled(false); setSelfCriticEnabled(false);
  setAdversarialVerifyEnabled(false); setVerifyEnabled(false); setGitAutoCommitEnabled(false); setSandboxEnabled(false);
}

beforeEach(allOff);
afterAll(allOff);

test('a saved config turns each gate on, and off again', () => {
  const on = Object.fromEntries(GATE_KEYS.map((key) => [key, true]));
  expect(applyGateFlags(on).sort()).toEqual([...GATE_KEYS].sort());
  for (const [key, read] of Object.entries(READERS)) expect([key, read()]).toEqual([key, true]);

  applyGateFlags(Object.fromEntries(GATE_KEYS.map((key) => [key, false])));
  for (const [key, read] of Object.entries(READERS)) expect([key, read()]).toEqual([key, false]);
});

test('only booleans apply: an absent or malformed key leaves its gate alone', () => {
  setDiffApprovalEnabled(true);
  expect(applyGateFlags({ diffApproval: undefined, blastGate: 'yes', selfCritic: null })).toEqual([]);
  expect(isDiffApprovalEnabled()).toBe(true);
  expect(isBlastGateEnabled()).toBe(false);
  expect(applyGateFlags(null)).toEqual([]);
});

test('every gate Settings can switch is writable over the wire', () => {
  for (const key of GATE_KEYS) expect(CONFIG_WIRE_KEYS).toContain(key);
});

test('a Settings write reaches the live gate, not only the file', async () => {
  const file: Record<string, unknown> = {};
  const wire = createConfigWire({
    getConfig: () => file,
    saveConfig: async (updates) => { Object.assign(file, updates); },
    applyLive: (patch) => { applyGateFlags(patch); },
  });
  await wire.write({ diffApproval: true });
  expect(file.diffApproval).toBe(true);      // persisted, as before
  expect(isDiffApprovalEnabled()).toBe(true); // …AND in force, which it never was
  await wire.write({ selfCritic: true });
  expect(isSelfCriticEnabled()).toBe(true);
  expect(isDiffApprovalEnabled()).toBe(true); // a one-key patch touches one gate
});

test('a wire whose live half throws still persists', async () => {
  const file: Record<string, unknown> = {};
  const wire = createConfigWire({
    getConfig: () => file,
    saveConfig: async (updates) => { Object.assign(file, updates); },
    applyLive: () => { throw new Error('gone'); },
  });
  await expect(wire.write({ blastGate: true })).resolves.toBeDefined();
  expect(file.blastGate).toBe(true);
});

test('the engine applies the saved gates at boot and registers the two hook-driven ones', () => {
  // startHeadless cannot be booted in a unit test, so this reads it. Each line below was missing: the
  // gates were never read back, and the verify and auto-commit hooks left with the Ink terminal.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const entry = fs.readFileSync(path.join(__dirname, '..', 'protocol', 'headless.entry.ts'), 'utf8');
  const boot = entry.slice(entry.indexOf('export async function startHeadless'), entry.indexOf('startPortHost('));
  expect(boot).toContain("require('../engine/gate.flags').applyGateFlags(config)");
  expect(boot).toContain('registerPostHook(verify.VERIFY_TOOLS, verify.verifyHook)');
  expect(boot).toContain('registerPostHook(autoCommit.GIT_AUTOCOMMIT_TOOLS, autoCommit.gitAutoCommitHook)');
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'protocol', 'headless.handlers.ts'), 'utf8');
  expect(handlers).toMatch(/applyLive: \(patch\) => \{ require\('\.\.\/engine\/gate\.flags'\)\.applyGateFlags\(patch\); \}/);
});
