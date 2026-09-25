import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { entropy, envSecrets, findSecrets, maskSecret, parseEnv, RULES, scanFolders } from '../main/secrets';

/**
 * God's Land stage 6: what a secret is. The negatives and literal positives are gitleaks' own fixtures
 * (fixtures/gitleaks-b58d3f1.json, copied from its rule files at that commit, MIT). gitleaks makes most of its positives
 * at random at test time; ours are made the same way — the rule's prefix plus a random string from the rule's alphabet
 * — from a fixed seed, so a run is repeatable.
 */

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gitleaks-b58d3f1.json'), 'utf8')) as {
  positives: Record<string, string[]>; negatives: Record<string, string[]>;
};

// A linear congruential generator's low bits repeat with a short period — taken modulo 16 or 32 they gave
// "AKIAQAAAAAAAAAYAAAAA", which the entropy floor rightly refused. The high bits are well mixed.
let seed = 20260925;
const random = (alphabet: string, n: number): string => {
  let out = '';
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += alphabet[(seed >>> 16) % alphabet.length]; }
  return out;
};
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LOWER = 'abcdefghijklmnopqrstuvwxyz', DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS, HEX = '0123456789abcdef';

describe('gitleaks\' fixtures', () => {
  test.each(Object.entries(fixtures.negatives).flatMap(([rule, cases]) => cases.map((text) => [rule, text])))('%s: not a secret — %s', (_rule, text) => {
    expect(findSecrets(text)).toEqual([]);
  });
  test.each(Object.entries(fixtures.positives).flatMap(([rule, cases]) => cases.map((text) => [rule, text])))('%s: a secret — %s', (_rule, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0);
  });
});

describe('each rule finds a key made the way gitleaks makes its test keys', () => {
  const made: Array<[string, string]> = [
    ['aws-access-token', `AKIA${random('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`],
    ['stripe-access-token', `sk_live_${random(ALNUM, 24)}`],
    ['github-pat', `ghp_${random(ALNUM, 36)}`],
    ['github-fine-grained-pat', `github_pat_${random(ALNUM + '_', 82)}`],
    ['gitlab-pat', `glpat-${random(ALNUM, 20)}`],
    ['slack-bot-token', `xoxb-${random(DIGITS, 12)}-${random(DIGITS, 12)}${random(ALNUM, 24)}`],
    ['anthropic-api-key', `sk-ant-api03-${random(ALNUM, 93)}AA`],
    ['gcp-api-key', `AIza${random(ALNUM + '-_', 35)}`],
    ['npm-access-token', `npm_${random(LOWER + DIGITS, 36)}`],
    ['huggingface-access-token', `hf_${random(UPPER + LOWER, 34)}`],
    ['sendgrid-api-token', `SG.${random(ALNUM, 22)}.${random(ALNUM, 43)}`],
    ['digitalocean-pat', `dop_v1_${random(HEX, 64)}`],
    ['shopify-access-token', `shpat_${random(HEX, 32)}`],
    ['twilio-api-key', `SK${random(HEX, 32)}`],
    ['jwt', `eyJ${random(ALNUM, 30)}.eyJ${random(ALNUM, 40)}.${random(ALNUM, 43)}`],
    ['url-password', `postgres://app:${random(ALNUM, 16)}@db.internal:5432/app`],
    ['nvidia-api-key', `nvapi-${random(ALNUM + '-_', 64)}`],
  ];
  test.each(made)('%s', (rule, key) => {
    expect(findSecrets(`TOKEN="${key}"`).map((f) => f.rule)).toContain(rule);
  });
  test('every rule has a case here or in gitleaks\' fixtures', () => {
    const covered = new Set([...made.map(([rule]) => rule), 'private-key', 'slack-webhook-url', 'openai-api-key', 'github-oauth', 'github-app-token', 'slack-user-token']);
    expect(RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });
  test('low-randomness look-alikes are not secrets (entropy floors)', () => {
    expect(findSecrets('sk_live_aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([]);
    expect(findSecrets('ghp_' + 'a'.repeat(36))).toEqual([]);
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('abcd')).toBe(2);
  });
});

test('the masked form keeps a recognisable prefix and the last four, and never enough to use', () => {
  expect(maskSecret('sk_live_51H8abcdEFGHijklMNOP89f2')).toBe('sk_live_••••89f2');
  expect(maskSecret('AKIAQWERTYUIOPASDFGH')).toBe('AKIA••••DFGH');
  expect(maskSecret('postgres://app:hunter2@db:5432/x')).toBe('postgres://app:••••@db:5432/x');
  expect(maskSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).toBe('-----BEGIN OPENSSH PRIVATE KEY----- ••••');
  expect(maskSecret('abcdefghij')).toBe('ab••••');
  for (const value of ['sk_live_51H8abcdEFGHijklMNOP89f2', 'abcdefghijklmnopqrstuvwxyz']) expect(maskSecret(value).replace(/•/g, '').length).toBeLessThan(value.length / 2);
});

describe('.env files', () => {
  test('parsing: export, quotes, comments, blanks', () => {
    expect(parseEnv('# comment\nexport A=1\nB="two words"\nC=three # note\n\nD=\'x#y\'')).toEqual([
      { key: 'A', value: '1', line: 2 }, { key: 'B', value: 'two words', line: 3 }, { key: 'C', value: 'three', line: 4 }, { key: 'D', value: 'x#y', line: 6 },
    ]);
  });

  test('offered: recognised keys and secret-named real values; not placeholders or ordinary settings', () => {
    const stripe = `sk_test_${random(ALNUM, 24)}`;
    const found = envSecrets([
      `STRIPE_KEY=${stripe}`,
      'DATABASE_URL=postgres://app:s3cretpass@localhost:5432/db',
      'SESSION_SECRET=9f86d081884c7d659a2feaa0c55ad015',
      'API_KEY=your_api_key_here',
      'API_TOKEN=xxxxxxxx',
      'PORT=3000',
      'NODE_ENV=production',
      'PASSWORD=',
    ].join('\n'));
    expect(found.map((f) => [f.key, f.label])).toEqual([['STRIPE_KEY', 'Stripe key'], ['DATABASE_URL', 'Password in a URL'], ['SESSION_SECRET', 'Secret']]);
  });

  test('scanning reads only .env files in the opened folders, two levels deep, and never the home folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-secrets-'));
    try {
      const project = path.join(home, 'shop');
      fs.mkdirSync(path.join(project, 'api', 'deep', 'deeper'), { recursive: true });
      fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
      const stripe = `sk_live_${random(ALNUM, 24)}`;
      fs.writeFileSync(path.join(project, '.env.local'), `STRIPE_KEY=${stripe}\nPORT=3000\n`);
      fs.writeFileSync(path.join(project, 'api', '.env'), 'JWT_SECRET=0123456789abcdefghij\n');
      fs.writeFileSync(path.join(project, 'api', 'deep', 'deeper', '.env'), 'TOO_DEEP_SECRET=0123456789abcdefghij\n');
      fs.writeFileSync(path.join(project, 'node_modules', 'pkg', '.env'), 'VENDOR_SECRET=0123456789abcdefghij\n');
      fs.writeFileSync(path.join(project, 'notes.md'), `STRIPE=${stripe}\n`);
      fs.writeFileSync(path.join(home, '.env'), 'HOME_SECRET=0123456789abcdefghij\n');
      const found = scanFolders([project, home, '/'], home);
      expect(found.map((f) => [f.key, f.where, f.masked])).toEqual([
        ['STRIPE_KEY', path.join('shop', '.env.local'), `sk_live_••••${stripe.slice(-4)}`],
        ['JWT_SECRET', path.join('shop', 'api', '.env'), '0123456789abcdefghij'.slice(0, 3) + '••••ghij'],
      ]);
      expect(new Set(found.map((f) => f.id)).size).toBe(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
