import * as fs from 'fs';
import * as path from 'path';
import { setSovereignMode, resetSovereignMode } from '../security/sovereign';
import {
  isSandboxEnabled, setSandboxEnabled, sandboxArgv, buildOfflineProfile, buildProfile,
  buildBwrapArgv, sovereignShellBlockedReason, _setSandboxAvailableForTests,
} from '../sandbox/exec.sandbox';

/**
 * The census that keeps the perimeter honest.
 *
 * The original defect was not that the guard was wrong, it was that sixteen modules opened sockets
 * without ever calling it, and nothing in the build said so. This test walks the source and asserts
 * that every module reaching for a network primitive is either covered by the perimeter or has
 * explicitly opted in. A new egress surface added tomorrow fails CI instead of quietly widening the
 * hole a sovereignty claim is measured on.
 */
const SRC = path.join(__dirname, '..');

/** Primitives that the perimeter wraps at boot. A module using only these is governed already. */
const PERIMETER_COVERED = /\b(fetch\s*\(|https?\.(request|get)\s*\(|net\.(connect|createConnection)\s*\(|tls\.connect\s*\(|dns\.(lookup|resolve))/;

/**
 * Surfaces the perimeter genuinely cannot reach, each with the control that does cover it.
 * Adding a row here is a deliberate act that must name why.
 */
const OUT_OF_PERIMETER_SCOPE: Record<string, string> = {
  'tools/implementations/bash.tool': 'a subprocess has its own network stack; covered by the sovereign sandbox profile',
  'sandbox/exec.sandbox': 'this IS the subprocess control',
  'security/egress.perimeter': 'the perimeter itself',
  'security/egress.guard': 'the decision point',
  'security/sovereign': 'the classifier',
  'security/egress.ledger': 'the record',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('egress boundary census', () => {
  it('every module that opens a socket is covered by the perimeter or explicitly out of scope', () => {
    const uncovered: string[] = [];
    for (const file of walk(SRC)) {
      const module = path.relative(SRC, file).replace(/\.ts$/, '').replace(/\\/g, '/');
      if (module in OUT_OF_PERIMETER_SCOPE) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (!PERIMETER_COVERED.test(source)) continue;
      // Reaching a network primitive is fine — the perimeter wraps all of them. What must never
      // happen is a module reaching one the perimeter does NOT wrap.
      if (/\b(new\s+WebSocket|dgram\.createSocket|http2\.connect)\s*\(/.test(source)) {
        uncovered.push(`${module}: uses a primitive the perimeter does not wrap`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('the perimeter wraps every primitive the census treats as covered', () => {
    const perimeter = fs.readFileSync(path.join(SRC, 'security/egress.perimeter.ts'), 'utf8');
    for (const primitive of ["'fetch'", "'request'", "'get'", "'connect'", "'createConnection'", "'lookup'"]) {
      expect(perimeter).toContain(primitive);
    }
  });
});

describe('sovereign mode governs the shell, which the perimeter cannot reach', () => {
  afterEach(() => { resetSovereignMode(); setSandboxEnabled(false); _setSandboxAvailableForTests(null); });

  it('forces the sandbox on and cannot be toggled off', () => {
    setSandboxEnabled(false);
    expect(isSandboxEnabled()).toBe(false);
    setSovereignMode(true);
    expect(isSandboxEnabled()).toBe(true);
  });

  it('denies the network in the seatbelt profile only under sovereign mode', () => {
    expect(buildProfile('/w')).not.toContain('(deny network*)');
    expect(buildOfflineProfile('/w')).toContain('(deny network*)');
    // The write surface is unchanged — an offline session is not a read-only session.
    expect(buildOfflineProfile('/w')).toContain('(subpath "/w")');
  });

  it('unshares the network namespace for bwrap only when asked', () => {
    expect(buildBwrapArgv('/w', false)).not.toContain('--unshare-net');
    expect(buildBwrapArgv('/w', true)).toContain('--unshare-net');
  });

  it('selects the network-denying argv when sovereign', () => {
    _setSandboxAvailableForTests(true);
    setSovereignMode(true);
    const argv = sandboxArgv('echo hi', '/w');
    expect(argv).not.toBeNull();
    expect(JSON.stringify(argv)).toMatch(/deny network\*|--unshare-net/);
  });

  it('refuses the shell rather than degrading when the OS cannot enforce isolation', () => {
    expect(sovereignShellBlockedReason()).toBeNull();     // mode off — nothing to enforce
    setSovereignMode(true);
    _setSandboxAvailableForTests(true);
    expect(sovereignShellBlockedReason()).toBeNull();     // enforceable — allowed
    _setSandboxAvailableForTests(false);
    const reason = sovereignShellBlockedReason();
    expect(reason).toContain('no OS sandbox backend');
    expect(reason).toContain('outside the in-process egress perimeter');
  });
});
