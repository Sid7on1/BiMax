#!/usr/bin/env node
// Repository artifact cleanliness.
//
// Generated runtime state (computer-use session files, recordings, caches) belongs in a user or
// temporary directory, never in the checkout. A test or a dev run that writes one into the tree
// leaves a file that looks like source in `git status` — `app/.bimax/computer/session.json` was
// exactly that. This check fails the gate rather than leaving it to be noticed by hand.
//
// It deliberately does NOT touch the user's own files: it only reports, and only for paths that are
// generated runtime state by definition.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Paths that are runtime state wherever they appear inside the checkout. */
const FORBIDDEN = [
  { pattern: /(^|\/)\.bimax\//, why: 'computer-use runtime state belongs in the project the user opened, not in this repository' },
  { pattern: /(^|\/)out\/renderer\//, why: 'build output' },
];

const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});

const offenders = [];
for (const line of status.split('\n')) {
  if (!line.trim()) continue;
  const file = line.slice(3).trim();
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(file)) offenders.push({ file, why: rule.why });
  }
}

if (offenders.length > 0) {
  console.error('repo cleanliness: FAIL — generated runtime artifacts are in the working tree:');
  for (const offender of offenders) console.error(`  ${offender.file} — ${offender.why}`);
  process.exit(1);
}

console.log('repo cleanliness: PASS no generated runtime artifacts in the working tree');
