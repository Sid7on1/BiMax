/**
 * Phase 2, slice 3 — app-owned Trust diagnostics.
 *
 * `08_ACCEPTANCE_GATES.md`, Desktop computer-use gate: "packaged app, not a dev shell, owns the
 * permission and focus experience".
 * Desktop coding gate: "code task works with zero CU permissions".
 * `12_ALL_VISION_SECTIONS_RESEARCH_PLAYBOOK.md` V32: "Trust Center shows the exact responsible
 * signed component… Core Code operates with all optional permissions denied."
 *
 * The two properties this file exists to defend:
 *   1. coding availability is NEVER a function of a macOS permission;
 *   2. an unknown is never reported as fine.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  buildTrustReport, toComponentReport, toDisposition, MINIMUM_MACOS,
  type BuildFacts, type PermissionReadings, type TrustReport,
} from '../main/trust';
import type { ComponentName, Resolution } from '../main/runtime.paths';

const repo = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(repo, relative), 'utf8');
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Slice one top-level function out of a source file: from its signature to the closing brace in
 * column 0. Nested braces are all indented, so this needs no parser — and every caller asserts
 * something positive about the slice, so a bad cut fails loudly instead of silently emptying the
 * scope and letting the bans below pass over nothing.
 */
const topLevelFunction = (source: string, signature: string): string => {
  const from = source.indexOf(signature);
  if (from < 0) throw new Error(`no such function: ${signature}`);
  const to = source.indexOf('\n}\n', from);
  if (to < 0) throw new Error(`unterminated function: ${signature}`);
  return source.slice(from, to + 2);
};

const PACKAGED_BUILD: BuildFacts = {
  packaged: true,
  appVersion: '1.1.0',
  electron: '43.3.0',
  chrome: '150.0.7871.212',
  node: '24.18.1',
  platform: 'darwin',
  osRelease: '25.5.0',
  minimumMacOS: MINIMUM_MACOS,
};

const ALL_GRANTED: PermissionReadings = { accessibility: 'granted', screenRecording: 'granted' };
const ALL_DENIED: PermissionReadings = { accessibility: 'denied', screenRecording: 'denied' };

const present = (p: string): Resolution => ({ path: p, source: 'bundle' });
const UNKNOWN_SIGNATURE = {
  kind: 'unknown' as const,
  hardenedRuntime: null,
  gatekeeper: 'unknown' as const,
  notarization: 'unknown' as const,
};
const FULL_COMPONENTS: Array<{ name: ComponentName; resolution: Resolution }> = [
  { name: 'engine', resolution: present('/Applications/Bimax.app/Contents/Resources/engine/bimax-engine') },
  { name: 'macCapability', resolution: present('/Applications/Bimax.app/Contents/MacOS/bimax-mac-capability') },
  { name: 'cuService', resolution: present('/Applications/Bimax.app/Contents/XPCServices/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service') },
  { name: 'cuBridge', resolution: present('/Applications/Bimax.app/Contents/MacOS/bimax-cu-bridge') },
  { name: 'desktopHelper', resolution: present('/Applications/Bimax.app/Contents/MacOS/bimax-desktop-helper') },
];

function report(overrides: {
  build?: Partial<BuildFacts>;
  permissions?: PermissionReadings;
  components?: Array<{ name: ComponentName; resolution: Resolution }>;
  userTakeover?: { available: boolean; detail?: string };
} = {}): TrustReport {
  return buildTrustReport({
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    build: { ...PACKAGED_BUILD, ...overrides.build },
    permissions: overrides.permissions ?? ALL_GRANTED,
    components: overrides.components ?? FULL_COMPONENTS,
    integrity: { app: { signature: UNKNOWN_SIGNATURE }, components: {} },
    userTakeover: overrides.userTakeover ?? { available: true },
  });
}

describe('coding never depends on a macOS permission', () => {
  test('with every permission DENIED, coding is still available', () => {
    const r = report({ permissions: ALL_DENIED });
    expect(r.coding.available).toBe(true);
    expect(r.coding.requiresPermissions).toEqual([]);
  });

  test('with every permission unreadable, coding is still available', () => {
    const r = report({ permissions: { accessibility: 'unavailable', screenRecording: 'unavailable' } });
    expect(r.coding.available).toBe(true);
  });

  test('coding availability tracks the ENGINE only', () => {
    const withoutEngine = FULL_COMPONENTS.filter((c) => c.name !== 'engine')
      .concat([{ name: 'engine', resolution: { source: 'missing' } }]);
    expect(report({ components: withoutEngine }).coding.available).toBe(false);

    // ...and losing every Computer Use component does not affect it.
    const codingOnly: Array<{ name: ComponentName; resolution: Resolution }> = [
      { name: 'engine', resolution: present('/x/bimax-engine') },
      { name: 'macCapability', resolution: { source: 'missing' } },
      { name: 'cuService', resolution: { source: 'missing' } },
      { name: 'cuBridge', resolution: { source: 'missing' } },
      { name: 'desktopHelper', resolution: { source: 'missing' } },
    ];
    expect(report({ components: codingOnly }).coding.available).toBe(true);
  });

  test('a Computer-Use-only component is labelled as such, and the engine is not', () => {
    const r = report();
    const byName = Object.fromEntries(r.components.map((c) => [c.name, c]));
    expect(byName.engine.computerUseOnly).toBe(false);
    for (const name of ['macCapability', 'cuService', 'cuBridge', 'desktopHelper']) {
      expect(byName[name].computerUseOnly).toBe(true);
    }
  });
});

describe('Computer Use availability is honest about why it is blocked', () => {
  test('everything granted and present means available with no blockers', () => {
    const r = report();
    expect(r.computerUse).toEqual({ available: true, blockers: [] });
  });

  test('each denied permission is named as its own blocker', () => {
    const r = report({ permissions: ALL_DENIED });
    expect(r.computerUse.available).toBe(false);
    expect(r.computerUse.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/Accessibility/),
      expect.stringMatching(/Screen Recording/),
    ]));
  });

  test('a not-determined permission blocks too — undecided is not granted', () => {
    const r = report({ permissions: { accessibility: 'not-determined', screenRecording: 'granted' } });
    expect(r.computerUse.available).toBe(false);
    expect(r.computerUse.blockers.some((b) => /Accessibility/.test(b))).toBe(true);
  });

  test('an unreadable permission blocks and is also recorded as an unknown', () => {
    const r = report({ permissions: { accessibility: 'unavailable', screenRecording: 'granted' } });
    expect(r.computerUse.available).toBe(false);
    expect(r.unknowns.some((u) => /accessibility/i.test(u))).toBe(true);
  });

  test('a missing native component is named individually, not collapsed', () => {
    const missingBridge = FULL_COMPONENTS.map((c) =>
      c.name === 'cuBridge' ? { name: c.name, resolution: { source: 'missing' as const } } : c);
    const r = report({ components: missingBridge });
    expect(r.computerUse.available).toBe(false);
    expect(r.computerUse.blockers.some((b) => /bridge/i.test(b))).toBe(true);
    // Every other Computer Use component must remain healthy — they are present.
    expect(r.computerUse.blockers.filter((b) => /not available/.test(b))).toHaveLength(1);
  });

  test('a missing takeover authority is named and Computer Use fails closed', () => {
    const detail = 'Bimax could not set up the control you would use to take over';
    const r = report({ userTakeover: { available: false, detail } });
    expect(r.computerUse.available).toBe(false);
    expect(r.computerUse.blockers).toContain(detail);
  });
});

describe('unknowns are surfaced rather than implied', () => {
  test('an unpackaged run says its identity is not authoritative', () => {
    const r = report({ build: { packaged: false } });
    expect(r.unknowns.some((u) => /unpackaged/i.test(u))).toBe(true);
  });

  test('a packaged run does not claim that caveat', () => {
    expect(report().unknowns.some((u) => /unpackaged/i.test(u))).toBe(false);
  });

  test('signature and notarization state is declared unevaluated, never guessed', () => {
    // Phase 7 owns signing. A Trust view that silently omitted this would read as "signed".
    expect(report().unknowns.some((u) => /signature|notariz/i.test(u))).toBe(true);
  });

  test('the report never invents a signed/notarized verdict', () => {
    const serialized = JSON.stringify(report());
    expect(serialized).not.toMatch(/"notarized":\s*true|"signed":\s*true/);
  });
});

describe('refused overrides reach the Trust surface', () => {
  test('a packaged run that refused an override shows it against the component', () => {
    const refused: Array<{ name: ComponentName; resolution: Resolution }> = FULL_COMPONENTS.map((c) =>
      c.name === 'cuService'
        ? {
          name: c.name,
          resolution: {
            path: '/Applications/Bimax.app/Contents/XPCServices/BimaxCuService.xpc/Contents/MacOS/bimax-cu-service',
            source: 'bundle' as const,
            refusedOverride: { variable: 'BIMAX_CU_SERVICE_BINARY', value: '/tmp/foreign' },
          },
        }
        : c);
    const service = report({ components: refused }).components.find((c) => c.name === 'cuService');
    expect(service?.refusedOverride).toEqual({ variable: 'BIMAX_CU_SERVICE_BINARY', value: '/tmp/foreign' });
    // The component still resolved from the bundle — the refusal did not degrade it.
    expect(service?.source).toBe('bundle');
    expect(service?.present).toBe(true);
  });

  test('a component report carries the source, so a dev override is visibly not a bundle path', () => {
    const dev = toComponentReport('cuBridge', { path: '/tmp/local', source: 'override' });
    expect(dev).toMatchObject({ source: 'override', present: true, path: '/tmp/local' });
  });

  test('a missing component reports no path at all', () => {
    const missing = toComponentReport('desktopHelper', { source: 'missing' });
    expect(missing.present).toBe(false);
    expect(missing.path).toBeUndefined();
  });
});

describe('permission values are normalized conservatively', () => {
  test('known values map as expected', () => {
    expect(toDisposition('granted')).toBe('granted');
    expect(toDisposition(true)).toBe('granted');
    expect(toDisposition('denied')).toBe('denied');
    expect(toDisposition('restricted')).toBe('denied');
    expect(toDisposition(false)).toBe('denied');
    expect(toDisposition('not-determined')).toBe('not-determined');
  });

  test('anything unrecognized becomes unavailable, never granted', () => {
    // A future Electron value, a null, or a thrown-and-caught undefined must not read as granted.
    for (const raw of [undefined, null, '', 'unknown-future-value', 0, {}, []]) {
      expect(toDisposition(raw)).toBe('unavailable');
    }
  });
});

describe('the declared macOS floor is one number everywhere', () => {
  test('trust.ts, electron-builder.yml and Package.swift agree', () => {
    const builder = yaml.load(read('app/electron-builder.yml')) as Record<string, any>;
    expect(String(builder.mac.minimumSystemVersion)).toBe(MINIMUM_MACOS);

    const swift = read('native/BimaxComputerUseKit/Package.swift');
    const declared = /platforms:\s*\[\.macOS\(\.v(\d+)\)\]/.exec(swift)?.[1];
    expect(declared).toBe(MINIMUM_MACOS.split('.')[0]);
  });
});

describe('reporting is read-only and cannot prompt', () => {
  test('the trust module performs no probing of its own', () => {
    const code = stripComments(read('app/src/main/trust.ts'));
    expect(code).not.toMatch(/from\s+'electron'/);
    // Match process-launching identifiers, not harmless words such as `executableSha256`.
    expect(code).not.toMatch(/\b(?:spawn|exec|child_process)\b/);
    // Every value is injected; the module must not reach for a global.
    expect(code).not.toMatch(/process\.(versions|platform|env)/);
  });

  test('the trust report is built only from the non-prompting permission APIs', () => {
    const main = read('app/src/main/index.ts');
    // Scoped to the reporting path, NOT to index.ts as a whole. The main process does own one
    // legitimate prompting call — `permissions:request-microphone`, which Apple requires the
    // responsible app to issue itself — and a file-wide ban made that path and this invariant
    // mutually exclusive. What must never prompt is *reporting*: opening the Trust Center cannot
    // be the thing that raises a macOS dialog.
    const builder = stripComments(topLevelFunction(main, 'async function currentTrustReport()'));
    // Self-checking scope: this is the report's only permission probe, so if the slice ever stops
    // covering the real builder this fails rather than the bans passing over a stale cut.
    //
    // It used to name the two Electron APIs directly. They now sit behind `hostGrants()`, which
    // asks a fresh child process instead — because macOS decides Accessibility trust once per
    // process, so the long-lived main process can never observe a grant the user makes after
    // launch. The non-prompting invariant is unchanged and still enforced below: the helper's
    // `status` verb preflights (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`) and the
    // in-process fallback is still the `false` variant.
    expect(builder).toContain('hostGrants()');
    // …and the channel must still reach that builder, so the scope cannot drift off the live path.
    expect(main).toMatch(/'trust:report'[^;]*currentTrustReport\(\)/);

    // The builder plus every module it draws report facts from. Only engine.ts can even reach
    // Electron; the rest are pure, and the ban keeps it that way.
    const reportingPath = [
      builder,
      // host.grants.ts joins the list because the probes moved into it — without this the ban
      // would have been relocated out of its own scope rather than upheld.
      ...['trust', 'engine', 'manual-alpha.trust', 'release.integrity', 'host.grants']
        .map((m) => stripComments(read(`app/src/main/${m}.ts`))),
    ].join('\n');
    // The prompting variants of the two APIs above.
    expect(reportingPath).not.toContain('askForMediaAccess');
    expect(reportingPath).not.toContain('isTrustedAccessibilityClient(true)');
    // The helper has a prompting verb too (`request-access`, which calls
    // AXIsProcessTrustedWithOptions + CGRequestScreenCaptureAccess). Reporting may only ever spawn
    // the preflight one, so the argv the reporting path passes is pinned here as well.
    expect(reportingPath).not.toContain("'request-access'");
  });

  test('the channel is registered through the guarded helper like every other', () => {
    const main = read('app/src/main/index.ts');
    expect(main).toMatch(/secureHandle<[^>]*>\(\s*'trust:report'/);
    // Still exactly two raw ipcMain call sites (the two helpers) — this channel added none.
    expect([...main.matchAll(/ipcMain\.(handle|on)\(/g)]).toHaveLength(2);
  });

  test('the renderer gets one narrow method, not a permission lever', () => {
    const preload = read('app/src/preload/index.ts');
    expect(preload).toContain("ipcRenderer.invoke('trust:report')");
    // No request/grant/revoke surface is exposed to the renderer by this slice.
    expect(preload).not.toMatch(/askForMediaAccess|requestPermission|grantPermission/);
  });
});
