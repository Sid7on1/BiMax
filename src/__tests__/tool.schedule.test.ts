import { planToolBatches, runWithConcurrencyLimit, maxParallelToolCalls, DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '../core/tool.schedule';
import { isReadOnlyShellCommand } from '../tools/shell.readonly';

interface Call { name: string; safe: boolean }
const call = (name: string, safe: boolean): Call => ({ name, safe });
const shape = (calls: Call[]) =>
  planToolBatches(calls, c => c.safe).map(b => `${b.kind}:${b.calls.map(c => c.name).join(',')}`);

describe('planToolBatches — model order is the execution order', () => {
  it('keeps a write ahead of a later read instead of running the read first', () => {
    // The defect this replaces: the old partition ran every concurrency-safe call first, so
    // [Edit, Read] read the PRE-edit file and "verified" a change that had not happened.
    expect(shape([call('Edit', false), call('Read', true)]))
      .toEqual(['exclusive:Edit', 'parallel:Read']);
  });

  it('merges only CONSECUTIVE safe calls, never across a barrier', () => {
    expect(shape([call('R1', true), call('R2', true), call('W', false), call('R3', true)]))
      .toEqual(['parallel:R1,R2', 'exclusive:W', 'parallel:R3']);
  });

  it('gives every exclusive call its own barrier', () => {
    expect(shape([call('W1', false), call('W2', false)]))
      .toEqual(['exclusive:W1', 'exclusive:W2']);
  });

  it('returns no batches for no calls', () => {
    expect(planToolBatches([], () => true)).toEqual([]);
  });
});

describe('runWithConcurrencyLimit', () => {
  it('drains siblings and stops replenishment before rejecting a failed dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started: number[] = [];
    let drained = false;
    let rejected = false;
    const run = runWithConcurrencyLimit([0, 1, 2], 2, async i => {
      started.push(i);
      if (i === 0) throw new Error('dispatch failed');
      await gate;
      drained = true;
      return i;
    }).catch(e => { rejected = true; expect(drained).toBe(true); throw e; });
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toBe(false);
    release();
    await expect(run).rejects.toThrow('dispatch failed');
    expect(started).toEqual([0, 1]);
  });

  it.each([NaN, Infinity, -1, 0, 1.9])('normalizes invalid/fractional pool limits: %s', async limit => {
    expect(await runWithConcurrencyLimit([1, 2, 3], limit, async i => i * 2)).toEqual([2, 4, 6]);
  });

  it('returns results in INPUT order regardless of completion order', async () => {
    const delays = [30, 0, 15];
    const out = await runWithConcurrencyLimit(delays, 3, async ms => {
      await new Promise(r => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 0, 15]);
  });

  it('never exceeds the cap', async () => {
    let live = 0;
    let peak = 0;
    await runWithConcurrencyLimit(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      live--;
      return null;
    });
    expect(peak).toBe(4);
  });

  it('stops replenishing once shouldStop flips, leaving un-run entries undefined', async () => {
    let started = 0;
    let stop = false;
    const out = await runWithConcurrencyLimit(Array.from({ length: 8 }, (_, i) => i), 1, async i => {
      started++;
      if (i === 1) stop = true;
      return i;
    }, () => stop);
    expect(started).toBe(2);
    expect(out.slice(2).every(v => v === undefined)).toBe(true);
    expect(out.slice(0, 2)).toEqual([0, 1]);
  });

  it('drains work already dispatched rather than abandoning it', async () => {
    let finished = 0;
    let stop = false;
    await runWithConcurrencyLimit([0, 1, 2, 3], 4, async i => {
      await new Promise(r => setTimeout(r, 5));
      finished++;
      if (i === 0) stop = true;
      return i;
    }, () => stop);
    // All four started before the first settled, so all four must settle.
    expect(finished).toBe(4);
  });

  it('honours BIMAX_MAX_PARALLEL_TOOLS and floors it at 1', () => {
    const original = process.env.BIMAX_MAX_PARALLEL_TOOLS;
    try {
      delete process.env.BIMAX_MAX_PARALLEL_TOOLS;
      expect(maxParallelToolCalls()).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS);
      process.env.BIMAX_MAX_PARALLEL_TOOLS = '1';
      expect(maxParallelToolCalls()).toBe(1);
      process.env.BIMAX_MAX_PARALLEL_TOOLS = '0';
      expect(maxParallelToolCalls()).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS);
      process.env.BIMAX_MAX_PARALLEL_TOOLS = 'nonsense';
      expect(maxParallelToolCalls()).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS);
    } finally {
      if (original === undefined) delete process.env.BIMAX_MAX_PARALLEL_TOOLS;
      else process.env.BIMAX_MAX_PARALLEL_TOOLS = original;
    }
  });
});

describe('isReadOnlyShellCommand — fail-closed per-call concurrency', () => {
  it.each([
    'ls -la', 'git status', 'git log --oneline -5', 'rg TODO src', 'cat package.json',
    'grep -rn foo src | head -20', 'wc -l src/index.ts', 'find . -name "*.ts"',
    '/bin/ls', 'sed -n 1,20p file.ts', 'npm ls --depth 0', 'echo hello',
  ])('allows %s', cmd => expect(isReadOnlyShellCommand(cmd)).toBe(true));

  it.each([
    // Redirects and chains: both of these START with a read-only binary.
    'echo x > out.txt', 'cat a >> b', 'ls && rm -rf /tmp/x', 'ls; rm x', 'ls & sleep 1',
    'echo $(rm -rf x)', 'echo `whoami`',
    // In-place / mutating flags on otherwise-read-only binaries.
    'sed -i s/a/b/ f.ts', 'find . -name "*.log" -delete', 'find . -exec rm {} ;',
    // Mutating subcommands and unknown binaries.
    'git commit -m x', 'git add .', 'npm install', 'npx tsc', 'rm -rf build', 'mkdir -p a',
    './build.sh', 'grep foo | tee out.txt', 'FOO=1 ls',
    // Not a string, empty, or unbalanced quoting.
    '', '   ', 'cat "unbalanced',
  ])('refuses %s', cmd => expect(isReadOnlyShellCommand(cmd)).toBe(false));

  it('refuses a non-string command', () => {
    expect(isReadOnlyShellCommand(undefined)).toBe(false);
    expect(isReadOnlyShellCommand({ command: 'ls' })).toBe(false);
  });

  it('refuses every segment of a pipeline, not just the first', () => {
    expect(isReadOnlyShellCommand('cat f | rm -rf x')).toBe(false);
  });
});
