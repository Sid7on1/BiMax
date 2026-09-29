import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSecrets, redactSecretsDeep } from '../security/secret.scan';
import { SessionRecorder } from '../engine/session.recorder';
import { endSessionMeta } from '../db/session.meta';
import { archiveOutput, readArchivedOutput } from '../context/output.archive';
import { redactForLedger } from '../core/execution.ledger';

/**
 * Flaw list A3: keys that pass through a command or a tool result must not be kept in plain text on disk. The engine
 * scrubs what it saves — the session transcript, archived tool output, the ledger — with the same rules the notch uses
 * to recognise a copied key (src/security/secret.scan.ts). These keys are made up; each has the shape and randomness
 * of a real one.
 */

const NVIDIA = 'nvapi-q7Zr2LmX9vKc4TbW1yHs8NdPf3GjU6oEa0RiQlVxYnMkBzCuDw5eFtAg';
const DEEPSEEK = 'sk-4f9a1c7e2b8d4e6f9a0b3c5d7e1f2a8b';
const OPENROUTER = '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';
const DB_PASSWORD = 'Tr0ub4dor9xQ';

describe('redactSecrets', () => {
  test('replaces each key with the rule that caught it', () => {
    const out = redactSecrets(`curl -H "Authorization: Bearer ${NVIDIA}" https://integrate.api.nvidia.com`);
    expect(out).toBe('curl -H "Authorization: Bearer [redacted:nvidia-api-key]" https://integrate.api.nvidia.com');
  });

  test('catches the plain sk- keys OpenAI-compatible providers issue, which gitleaks\' OpenAI rule does not', () => {
    expect(redactSecrets(`DEEPSEEK_API_KEY=${DEEPSEEK}`)).toBe('DEEPSEEK_API_KEY=[redacted:generic-sk-key]');
    expect(redactSecrets(`key: ${OPENROUTER}\n`)).toBe('key: [redacted:generic-sk-key]\n');
  });

  test('a password in a URL loses only the password, so the log still names the host', () => {
    expect(redactSecrets(`psql postgres://app:${DB_PASSWORD}@db.internal:5432/app`))
      .toBe('psql postgres://app:[redacted:url-password]@db.internal:5432/app');
  });

  test('ordinary text is left exactly as it was', () => {
    for (const text of [
      'npm run task-runner-20260929 --workers 4',  // the old ledger rule read this as an sk- key
      'docker volume rm disk-cache-20260929-aarch64-build',  // "sk-" inside a word is not a key
      'pip install scikit-learn sk-video',
      'git checkout feature/sk-long-branch-name-without-digits',
      'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'see https://example.com/docs?page=2',
    ]) expect(redactSecrets(text)).toBe(text);
  });

  test('every copy of a key in one text is replaced, and overlapping finds collapse to one marker', () => {
    const out = redactSecrets(`${NVIDIA} and again ${NVIDIA}`);
    expect(out).toBe('[redacted:nvidia-api-key] and again [redacted:nvidia-api-key]');
    expect(out).not.toContain('nvapi-q7');
  });

  test('redactSecretsDeep scrubs strings at any depth and keeps the shape', () => {
    const value = { tool: 'BashTool', input: { command: `export KEY=${NVIDIA}` }, list: [DEEPSEEK, 3, null] };
    expect(redactSecretsDeep(value)).toEqual({
      tool: 'BashTool', input: { command: 'export KEY=[redacted:nvidia-api-key]' }, list: ['[redacted:generic-sk-key]', 3, null],
    });
    expect(value.input.command).toContain(NVIDIA); // a copy: the caller's live object is untouched
  });
});

describe('what the engine keeps on disk', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-redact-'));
    process.chdir(dir);
  });
  afterEach(() => {
    endSessionMeta();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the session transcript holds no key that went through a message or a tool call', () => {
    const r = new SessionRecorder();
    r.onMessage({ id: 'u1', role: 'user', content: `use this key ${NVIDIA} for the deploy`, timestamp: new Date() });
    r.onToolResult({
      id: 't1', toolName: 'BashTool', input: `echo ${DEEPSEEK} > .env`, output: `wrote ${DEEPSEEK}`, status: 'success',
      startTime: new Date(), endTime: new Date(),
    });
    const sessions = path.join(dir, '.breakglass', 'sessions');
    const file = fs.readdirSync(sessions).find((f) => f.endsWith('.jsonl') && !f.startsWith('sessions-meta'))!;
    const text = fs.readFileSync(path.join(sessions, file), 'utf8');
    expect(text).not.toContain(NVIDIA);
    expect(text).not.toContain(DEEPSEEK);
    expect(text).toContain('use this key [redacted:nvidia-api-key] for the deploy');
    expect(text).toContain('echo [redacted:generic-sk-key] > .env');
  });

  test('archived tool output is scrubbed and still reads back as intact', () => {
    const archived = archiveOutput(`line 1\nTOKEN=${NVIDIA}\nline 3`)!;
    expect(archived).not.toBeNull();
    const read = readArchivedOutput(archived.handle);
    expect(read).toEqual(expect.objectContaining({ ok: true, text: 'line 1\nTOKEN=[redacted:nvidia-api-key]\nline 3' }));
  });

  test('the execution ledger uses the shared rules and no longer eats ordinary words', () => {
    expect(redactForLedger({ command: 'npm run task-runner-20260929' })).toEqual({ command: 'npm run task-runner-20260929' });
    expect(redactForLedger({ command: `psql postgres://app:${DB_PASSWORD}@db/app` }))
      .toEqual({ command: 'psql postgres://app:[redacted:url-password]@db/app' });
  });
});
