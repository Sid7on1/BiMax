import { parseSignatureAssessment } from '../../../main/release.integrity';
import { buildDiagnosticExport } from '../../../main/diagnostic.export';

describe('Phase 7 measured release facts', () => {
  test('recognizes only explicit Developer ID + notarized Gatekeeper evidence', () => {
    const result = parseSignatureAssessment(
      { ok: true, stdout: '', stderr: 'Identifier=ai.bimax.app\nAuthority=Developer ID Application: Bimax (TEAM123)\nTeamIdentifier=TEAM123\nCodeDirectory v=20500 size=1 flags=0x10000(runtime)' },
      { ok: true, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID' },
    );
    expect(result).toMatchObject({
      kind: 'developer-id', teamIdentifier: 'TEAM123', hardenedRuntime: true,
      gatekeeper: 'accepted', notarization: 'accepted',
    });
  });

  test('an unsigned or rejected assessment can never become a stable-looking fact', () => {
    const result = parseSignatureAssessment(
      { ok: false, stdout: '', stderr: 'code object is not signed at all' },
      { ok: false, stdout: '', stderr: 'rejected' },
    );
    expect(result).toEqual({
      kind: 'unsigned', hardenedRuntime: null, gatekeeper: 'rejected', notarization: 'rejected',
    });
  });

  test('reports a non-Apple certificate as local development without upgrading it to stable', () => {
    const result = parseSignatureAssessment(
      { ok: true, stdout: '', stderr: 'Identifier=ai.bimax.app\nAuthority=Bimax Local Code Signing\nTeamIdentifier=not set\nCodeDirectory v=20400 size=1 flags=0x0(none)' },
      { ok: false, stdout: '', stderr: 'rejected' },
    );
    expect(result).toMatchObject({
      kind: 'local-development', authority: 'Bimax Local Code Signing', hardenedRuntime: false,
      gatekeeper: 'rejected', notarization: 'rejected',
    });
  });

  test('diagnostic export is allowlisted and omits paths, raw logs, commands and secrets', () => {
    const exported = buildDiagnosticExport({
      now: () => new Date('2026-08-09T00:00:00.000Z'),
      trust: {
        generatedAt: '2026-08-09T00:00:00.000Z',
        build: { packaged: true },
        release: { qualification: 'manual-alpha' },
        appIntegrity: { executableSha256: 'abc', signature: { kind: 'unsigned' } },
        permissions: { accessibility: 'denied', screenRecording: 'denied' },
        coding: { available: true, requiresPermissions: [] },
        computerUse: { available: false, blockers: ['permission'] },
        unknowns: [],
        components: [{
          name: 'engine', label: 'Coding engine', present: true, source: 'bundle', computerUseOnly: false,
          path: '/Users/alice/Secret/client', refusedOverride: { variable: 'TOKEN', value: 'sk-secretvalue' },
          sha256: 'def',
        }],
      } as any,
      status: null,
      crashes: [{ project: '/Users/alice/Secret', command: '/secret/engine', logTail: 'token=sk-secretvalue', kind: 'crash', at: 'now' } as any],
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain('/Users/alice');
    expect(text).not.toContain('/secret/engine');
    expect(text).not.toContain('sk-secretvalue');
    expect(text).toContain('project paths, file contents and source code');
    expect(text).toContain('"refusedOverride":true');
  });
});
