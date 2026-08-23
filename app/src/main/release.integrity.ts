import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Measured release facts. No value is inferred from a bundle name or from app.isPackaged. */
export type SignatureKind = 'developer-id' | 'apple-development' | 'local-development' | 'ad-hoc' | 'unsigned' | 'unknown';
export type NotarizationState = 'accepted' | 'rejected' | 'unknown';

export interface CodeSignatureReport {
  kind: SignatureKind;
  identifier?: string;
  teamIdentifier?: string;
  authority?: string;
  hardenedRuntime: boolean | null;
  gatekeeper: 'accepted' | 'rejected' | 'unknown';
  notarization: NotarizationState;
}

export interface ExecutableIntegrity {
  sha256?: string;
  signature: CodeSignatureReport;
}

export interface CommandResult { ok: boolean; stdout: string; stderr: string }

function field(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim();
}

/** Parse codesign + spctl output without turning an absent fact into a positive release claim. */
export function parseSignatureAssessment(codesign: CommandResult, spctl: CommandResult): CodeSignatureReport {
  const signingText = `${codesign.stdout}\n${codesign.stderr}`;
  const assessmentText = `${spctl.stdout}\n${spctl.stderr}`;
  const authority = field(signingText, 'Authority');
  const flags = field(signingText, 'CodeDirectory') || signingText;

  let kind: SignatureKind = 'unknown';
  if (!codesign.ok && /not signed at all|code object is not signed/i.test(signingText)) kind = 'unsigned';
  else if (/^Signature=adhoc$/m.test(signingText) || /flags=.*adhoc/i.test(signingText)) kind = 'ad-hoc';
  else if (authority?.startsWith('Developer ID Application:')) kind = 'developer-id';
  else if (authority?.startsWith('Apple Development:')) kind = 'apple-development';
  else if (codesign.ok && authority) kind = 'local-development';

  const gatekeeper = spctl.ok
    ? 'accepted'
    : /rejected|deny|not accepted/i.test(assessmentText) ? 'rejected' : 'unknown';
  const notarization = /source=Notarized Developer ID/i.test(assessmentText)
    ? 'accepted'
    : gatekeeper === 'rejected' ? 'rejected' : 'unknown';

  return {
    kind,
    ...(field(signingText, 'Identifier') ? { identifier: field(signingText, 'Identifier') } : {}),
    ...(field(signingText, 'TeamIdentifier') && field(signingText, 'TeamIdentifier') !== 'not set'
      ? { teamIdentifier: field(signingText, 'TeamIdentifier') }
      : {}),
    ...(authority ? { authority } : {}),
    hardenedRuntime: codesign.ok ? /\bruntime\b/i.test(flags) : null,
    gatekeeper,
    notarization,
  };
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(file: string, args: string[]): CommandResult {
  try {
    return { ok: true, stdout: execFileSync(file, args, { encoding: 'utf8', timeout: 5_000 }), stderr: '' };
  } catch (error) {
    const value = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: String(value.stdout || ''),
      stderr: String(value.stderr || (error instanceof Error ? error.message : '')),
    };
  }
}

/** Non-prompting local measurement used by Trust Center. */
export function inspectExecutable(file: string, platform = process.platform): ExecutableIntegrity {
  let sha256: string | undefined;
  try { sha256 = sha256File(file); } catch { /* missing/unreadable remains unknown */ }
  if (platform !== 'darwin') {
    return {
      ...(sha256 ? { sha256 } : {}),
      signature: {
        kind: 'unknown', hardenedRuntime: null, gatekeeper: 'unknown', notarization: 'unknown',
      },
    };
  }
  const codesign = run('/usr/bin/codesign', ['--display', '--verbose=4', file]);
  const spctl = run('/usr/sbin/spctl', ['--assess', '--verbose=4', '--type', 'execute', file]);
  return { ...(sha256 ? { sha256 } : {}), signature: parseSignatureAssessment(codesign, spctl) };
}
