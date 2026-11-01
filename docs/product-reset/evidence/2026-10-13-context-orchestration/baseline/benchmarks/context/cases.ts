import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { encode } from 'gpt-tokenizer';
import { VectorStore } from '../../src/memory/vector.store';
import { recallForTurn } from '../../src/memory/recall';
import { CodeIndex } from '../../src/memory/code.index';
import { createCodeSearchTool } from '../../src/tools/implementations/code.search.tool';
import { createReadFileTool } from '../../src/tools/implementations/file.tool';
import { ContextManager } from '../../src/memory/context.manager';
import { fileStateCache } from '../../src/memory/file-state-cache';
import { AgentLoop } from '../../src/core/agent.loop';
import { ToolRegistry } from '../../src/tools/tool.registry';
import { buildTool } from '../../src/tools/tool.factory';
import { archiveOutput } from '../../src/context/output.archive';
import { createContextArchiveTool } from '../../src/tools/implementations/context-archive.tool';
import { GraphStore } from '../../src/graph/graph.store';
import { StaticAnalyzer } from '../../src/graph/static.analyzer';
import { planContext } from '../../src/graph/context.planner';
import { FactStore, factsFromSegment } from '../../src/memory/facts';
import { compressText } from '../../src/memory/headroom.compress';
import type { Segment } from '../../src/documents/extract';
import { estimatedTokens, hasAll, hasNone, hasSpan, spanRecall, withinBudget } from './graders';

/**
 * The context benchmark's cases: small fixed fixtures, each run through the real pipeline stage that feeds
 * the prompt, each graded on the text that stage produces. See DESIGN.md for what this does and does not
 * measure.
 */

export const BENCHMARK_VERSION = 'context-bench@3';

export type Family =
  | 'single-hop' | 'multi-hop-code' | 'temporal' | 'source-change'
  | 'long-session' | 'numeric' | 'budget' | 'scope' | 'workspace';

export const FAMILIES: Family[] = [
  'single-hop', 'multi-hop-code', 'temporal', 'source-change', 'long-session', 'numeric', 'budget', 'scope', 'workspace',
];

export interface GradedText {
  sha256: string;
  tokens: number;
  excerpt: string;
}

export interface CaseResult {
  id: string;
  family: Family;
  title: string;
  /** `pass`/`fail` are graded; `measured` records numbers with no pass rule; `error` threw, and counts as a failure. */
  outcome: 'pass' | 'fail' | 'measured' | 'error';
  metrics: Record<string, number | string | boolean | null>;
  graded?: GradedText;
  error?: string;
}

type Outcome = Pick<CaseResult, 'outcome' | 'metrics' | 'graded'>;

export interface BenchCase {
  id: string;
  family: Family;
  title: string;
  run: () => Promise<Outcome>;
}

export function gradedText(text: string): GradedText {
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    tokens: encode(text).length,
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 280),
  };
}

const graded = (passed: boolean, text: string, metrics: CaseResult['metrics'] = {}): Outcome =>
  ({ outcome: passed ? 'pass' : 'fail', metrics, graded: gradedText(text) });

const measured = (text: string, metrics: CaseResult['metrics']): Outcome =>
  ({ outcome: 'measured', metrics, graded: gradedText(text) });

const governor = { approveTaskExecution: async () => {} } as any;

/** A summarizer that keeps nothing, so compaction cases measure only what the pipeline preserves structurally. */
const summarizerKeepsNothing = { async *chat() { yield { type: 'token', text: '## Goal\nContinue the task.' }; } } as any;

const JAN_1 = new Date('2026-01-01T00:00:00Z');

function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
}

function textOf(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Fact rows as graded text, with only the source file's name, so identical runs hash identically. */
function factsText(rows: { sourceFile: string }[]): string {
  return JSON.stringify(rows.map((row) => ({ ...row, sourceFile: path.basename(row.sourceFile) })));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** Rewrites a file with same-length text and puts the old modification time back. */
function rewriteKeepingSizeAndMtime(file: string, text: string): void {
  const before = fs.statSync(file);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, JAN_1, JAN_1);
  const after = fs.statSync(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('fixture rewrite changed size or mtime');
}

// ───────────────────────────── fixtures ─────────────────────────────

const SINGLE_HOP_NOTES: Record<string, string> = {
  'orchid-launch': Array.from({ length: 100 }, (_, i) =>
    `Background section ${i}: ordinary operational details unrelated to the question.\n`).join('\n')
    + '\nThe orchid launch passphrase is VIOLET-SENTINEL.\n',
  'deploy-web': '## Deployment\nThe web app deploys from the release branch with the blue-green script. To roll back the web app, redeploy tag web-rollback-7.',
  'deploy-api': '## Deployment\nThe API deploys from main through the canary pipeline. To roll back the API, redeploy tag api-rollback-3.',
  'payments-hi': 'भुगतान विवरण: मासिक भुगतान की अंतिम तिथि 15 तारीख है। देर से भुगतान पर शुल्क लगता है।',
  'cache-eviction-window': 'The cache eviction window is 45 minutes for session data.',
  'cache-eviction-policy': 'The cache eviction policy is least recently used, applied per tenant.',
  'cache-warmup': 'Cache warmup after a deploy takes about two minutes before eviction starts.',
  'cache-size': 'The cache holds at most 2 GB before eviction pressure begins.',
  'cache-metrics': 'Cache eviction counts are exported as a Prometheus metric every minute.',
  'office-move': 'The office moves to the third floor in May; guests sign in at reception.',
};

const TEMPORAL_NOTES: Record<string, string> = {
  'timeout-march': '2026-03-01 decision: the request timeout is 30 seconds.',
  'timeout-june': '2026-06-10 decision: the request timeout is now 60 seconds, replacing the earlier value.',
  'timeout-idle': 'The idle timeout for websocket requests is 300 seconds.',
  'timeout-connect': 'The connect timeout for outbound requests is 5 seconds.',
  'exporter-runbook': 'Runbook, current: the metrics exporter listens on port 9464.',
  'exporter-owner': 'Owner note, current: the metrics exporter listens on port 9100.',
  'freeze-2025': '2025-11-20 announcement: the release freeze starts on Friday.',
  'freeze-2026': '2026-09-11 announcement: the release freeze starts on Friday.',
};

const RETRY_REPO: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: false }, include: ['src/**/*.ts'] }),
  'src/net/cancel.ts': `/** Cooperative cancellation shared by every network call. */
export class CancellationToken {
  private cancelled = false;
  private listeners: Array<() => void> = [];
  cancel(): void { this.cancelled = true; for (const listener of this.listeners) listener(); }
  onCancel(listener: () => void): void { this.listeners.push(listener); }
  throwIfCancelled(): void { if (this.cancelled) throw new Error('operation cancelled'); }
}
`,
  'src/config/limits.ts': `/** How many attempts a request makes before it gives up. */
export const RETRY_LIMIT = 3;
`,
  'src/net/retry.ts': `import { CancellationToken } from './cancel';
import { RETRY_LIMIT } from '../config/limits';

/** Re-run an operation with exponential backoff until it succeeds, the limit is reached, or the token is cancelled. */
export async function retryWithBackoff<T>(operation: () => Promise<T>, token: CancellationToken): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    token.throwIfCancelled();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RETRY_LIMIT) throw error;
      await sleep(2 ** attempt * 100, token);
    }
  }
}

function sleep(ms: number, token: CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    token.onCancel(() => { clearTimeout(timer); resolve(); });
  });
}
`,
  'src/net/client.ts': `import { retryWithBackoff } from './retry';
import { CancellationToken } from './cancel';
import { log } from '../log/logger';

export async function fetchReport(token: CancellationToken): Promise<string> {
  log('fetching report');
  return retryWithBackoff(async () => 'report', token);
}
`,
  'src/net/retry.test.ts': `import { retryWithBackoff } from './retry';
import { CancellationToken } from './cancel';

// Cancelling during backoff must stop further attempts.
export async function stopsRetryingOnceCancelled(): Promise<boolean> {
  const token = new CancellationToken();
  let attempts = 0;
  await retryWithBackoff(async () => { attempts++; token.cancel(); throw new Error('flaky'); }, token).catch(() => undefined);
  return attempts === 1;
}
`,
  'src/log/logger.ts': `export function log(message: string): void { console.log(message); }
`,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
    `src/jobs/job${i + 1}.ts`,
    `import { log } from '../log/logger';\n\n/** Job ${i + 1}: logs retry attempts for its queue. */\nexport function runJob${i + 1}(): void {\n  log('job ${i + 1}: retry scheduled, retry count reset, retry backoff noted');\n}\n`,
  ])),
};

const SCOPED_REPO: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${i}.ts`, 'export const needle = "needle";\n'])),
  'wanted/target.ts': `export const needle = "needle";\n/* ${'padding '.repeat(200)} */\n`,
  'wantedExtra/leak.ts': 'export const boundarysentinel = 1;\n',
};

// Held out (version 3): written before record 50 step 7 and never tuned against. They vary the shape of S5, M1 and M2.
const HELD_OUT_NOTES: Record<string, string> = {
  'parking-hours': 'The parking garage closes at 10 pm on weekdays and at 6 pm on weekends.',
  'reception': 'Visitors sign in at the reception desk on the ground floor.',
  'badges': 'Replacement badges are issued by the security office on the second floor.',
  'meeting-rooms': 'Meeting rooms are booked through the calendar and released after ten idle minutes.',
};

const BILLING_REPO: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: false }, include: ['src/**/*.ts'] }),
  'src/currency/round.ts': `/** Money helpers: amounts are held as numbers of whole units. */
export function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
`,
  'src/tax/rates.ts': `/** The value added tax applied to every invoice line. */
export const VAT_RATE = 0.2;
`,
  'src/billing/invoice.ts': `import { roundCents } from '../currency/round';
import { VAT_RATE } from '../tax/rates';

/** The amount a customer pays for these line amounts. */
export function invoiceTotal(lines: number[]): number {
  const net = lines.reduce((sum, line) => sum + line, 0);
  return roundCents(net * (1 + VAT_RATE));
}
`,
  'src/billing/invoice.test.ts': `import { invoiceTotal } from './invoice';

// Ten units of goods cost twelve with tax.
export function chargesTaxOnTopOfLines(): boolean {
  return invoiceTotal([10]) === 12;
}
`,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `src/reports/report${i + 1}.ts`,
    `/** Report ${i + 1}: prints the invoice totals for the month, rounded for display. */\nexport function printReport${i + 1}(): void {\n  console.log('invoice totals, rounded');\n}\n`,
  ])),
};

const UPLOAD_REPO: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: false }, include: ['src/**/*.ts'] }),
  'src/config/upload.ts': `/** The largest file accepted, in megabytes. */
export const MAX_UPLOAD_MB = 5;
`,
  'src/upload/handler.ts': `import { MAX_UPLOAD_MB } from '../config/upload';

export function acceptFile(sizeBytes: number): boolean {
  return sizeBytes <= MAX_UPLOAD_MB * 1024 * 1024;
}
`,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    `src/ui/banner${i + 1}.ts`,
    `/** Banner ${i + 1}: tells the user an upload was rejected or is still in progress. */\nexport function banner${i + 1}(): string {\n  return 'upload rejected or in progress';\n}\n`,
  ])),
};

const FAILED_CHUNKS = [37, 180, 311];
const BOUNDARY_QUESTION = 'Which file sets the retry limit for uploads?';

/** Natural text of about `chars` characters, so a tokenizer and a four-characters estimate roughly agree. */
function prose(chars: number): string {
  const sentence = 'Follow the project rules carefully and verify every change before reporting it. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

/** A shell call and its result, as the loop records them. */
function shellExchange(id: string, content: string): any[] {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'BashTool', arguments: JSON.stringify({ command: 'npm run upload' }) } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
}

/** Tokens in a request as sent: system prompt, tool schemas and each message's content, measured with a real tokenizer. */
function requestTokens(request: { messages: any[]; options: any }): number {
  return encode(String(request.options.system ?? '')).length
    + encode(JSON.stringify(request.options.tools ?? [])).length
    + request.messages.reduce((sum, m) => sum + 4 + encode(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length
      + (m.tool_calls ? encode(JSON.stringify(m.tool_calls)).length : 0), 0);
}

// ───────────────────────────── cases ─────────────────────────────

export function buildCases(temp: string): BenchCase[] {
  const dir = (name: string): string => {
    const d = path.join(temp, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const memoryStore = (name: string, notes: Record<string, string | { text: string; tags: string[] }>) => once(async () => {
    const store = new VectorStore(null as any, null as any, { storePath: path.join(temp, `${name}.json`), dedup: false });
    for (const [id, note] of Object.entries(notes)) {
      const { text, tags } = typeof note === 'string' ? { text: note, tags: ['note'] } : note;
      await store.storeDocument(id, text, tags);
    }
    return store;
  });

  const recallText = async (store: VectorStore, query: string, maxChars?: number): Promise<string> =>
    (await recallForTurn(store, query, maxChars ? { maxChars } : {}))?.text ?? '';

  const codeIndex = async (name: string, files: Record<string, string>, budgetFiles = 500) => {
    const root = dir(name);
    writeTree(root, files);
    const index = new CodeIndex(null, null, { root, storePath: path.join(temp, `${name}.db`) });
    await index.sync(budgetFiles);
    return { root, index };
  };

  const search = async (index: CodeIndex, root: string, query: string, limit = 5, pathPrefix?: string): Promise<string> =>
    textOf(await createCodeSearchTool(governor, index).execute({ query, limit, ...(pathPrefix ? { pathPrefix } : {}) }, { cwd: root }));

  const singleHop = memoryStore('single-hop', SINGLE_HOP_NOTES);
  const temporal = memoryStore('temporal', TEMPORAL_NOTES);
  const retryRepo = once(() => codeIndex('retry-repo', RETRY_REPO));
  const retryGraph = once(async () => {
    const { root } = await retryRepo();
    const store = new GraphStore(':memory:');
    new StaticAnalyzer(root, store).analyzeProject();
    return { root, store };
  });

  const answerCase = (id: string, title: string, query: string, spans: string[]): BenchCase => ({
    id, family: 'single-hop', title,
    run: async () => {
      const text = await recallText(await singleHop(), query);
      return graded(hasAll(text, spans), text, { expected: spans.join(' | '), recalled: text.length > 0 });
    },
  });

  const temporalCase = (id: string, title: string, query: string, required: string[], forbidden: string[] = []): BenchCase => ({
    id, family: 'temporal', title,
    run: async () => {
      const text = await recallText(await temporal(), query);
      return graded(hasAll(text, required) && hasNone(text, forbidden), text, { required: required.join(' | '), requiredRecall: spanRecall(text, required) });
    },
  });

  const largeTargetGraph = once(async () => {
    const root = dir('budget-pack');
    writeTree(root, { 'large.ts': `export function target() {\n${'  const descriptiveVariable = "long body";\n'.repeat(150)}}\n` });
    const store = new GraphStore(':memory:');
    store.addNode({ id: 'budget-target', type: 'FUNCTION', name: 'target', filePath: 'large.ts', startLine: 1, endLine: 152 });
    return { root, store };
  });

  const longSession = once(async () => {
    const manager = new ContextManager(summarizerKeepsNothing);
    let messages: any[] = [
      { role: 'system', content: 'You are Bimax, a coding agent.' },
      { role: 'user', content: 'Constraint: never modify package.json, and work only inside src/.' },
      { role: 'assistant', content: 'Test run: npm test passed at revision 4f2a9c1 with 212 tests.' },
      { role: 'assistant', content: 'Tried raising the test timeout; it did not fix the flaky upload test.' },
    ];
    for (let round = 0; round < 10; round++) {
      for (let turn = 0; turn < 20; turn++) {
        messages.push({ role: turn % 2 ? 'assistant' : 'user', content: `Round ${round}, turn ${turn}: routine progress on the upload module.` });
      }
      messages = await manager.compact(messages);
    }
    return { manager, messages, text: messages.map((m) => String(m.content)).join('\n') };
  });

  const facts = once(async () => {
    const store = new FactStore(path.join(temp, 'facts.db'));
    if (!store.available()) throw new Error('fact store unavailable on this runtime');
    const add = (text: string, sheet: string, name: string) => store.add(factsFromSegment(
      { text, locator: { sheet }, via: 'cells' } as Segment,
      { file: path.join(temp, name), name, entryId: name },
    ));
    add('Tag\tThickness (mm)\tInspected\nE-204\t7.8\t2026-05-01\nE-205\t9.1\t2026-05-02\nE-206\t6.2\t2026-05-03\nE-207\t8.4\t', 'Shell thickness', 'shell-inspection.xlsx');
    add('Tag\tThickness (in)\tInspected\nP-310\t0.25\t2026-04-11\nP-311\t0.31\t2026-04-12', 'Piping', 'piping-inspection.xlsx');
    return store;
  });

  const scopedRepo = once(() => codeIndex('scoped-repo', SCOPED_REPO, 100));

  const codeTaggedStore = memoryStore('code-tagged', {
    'helper-code': { text: 'parseInvoiceTotals returns the invoice totals grouped by currency.', tags: ['code'] },
    'helper-note': 'Invoices are exported nightly to the finance share.',
  });

  const partialIndex = once(async () => {
    const { root, index } = await codeIndex('partial-index', {
      'src/a.ts': 'export const alphasentinel = 1;\n',
      'src/b.ts': 'export const betasentinel = 2;\n',
      'src/c.ts': 'export const gammasentinel = 3;\n',
    }, 1);
    const outputs = await Promise.all(['alphasentinel', 'betasentinel', 'gammasentinel'].map(async (term) => ({ term, text: await search(index, root, term) })));
    return {
      hit: outputs.find((o) => !o.text.startsWith('No matching code found')),
      miss: outputs.find((o) => o.text.startsWith('No matching code found')),
    };
  });

  const heldOutNotes = memoryStore('held-out-notes', HELD_OUT_NOTES);
  const billingRepo = once(() => codeIndex('billing-repo', BILLING_REPO));
  const uploadRepo = once(() => codeIndex('upload-repo', UPLOAD_REPO));

  /** One turn through the real AgentLoop with a model that records each main request instead of calling a provider. */
  const boundaryTurn = async (shape: { window: number; systemChars: number; toolChars: number; history: number }) => {
    const requests: Array<{ messages: any[]; options: any }> = [];
    const llm = {
      async *chat(messages: any[], options: any = {}) {
        const main = options.system !== undefined;
        if (main) requests.push({ messages: messages.map((m) => ({ ...m })), options });
        yield { type: 'token', text: main ? 'The retry limit lives in src/config/limits.ts.' : '## Goal\nContinue the task.' };
      },
    } as any;
    const tools = new ToolRegistry();
    tools.register(buildTool({
      name: 'GrepTool', description: prose(shape.toolChars), isDestructive: false,
      schema: { type: 'object', properties: { pattern: { type: 'string', description: 'What to search for.' } }, required: ['pattern'] },
      execute: async () => 'no matches',
    }, governor));
    const history = Array.from({ length: shape.history }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Earlier turn ${i}: ${prose(200)}` }));
    const loop = new AgentLoop(llm, tools, undefined, shape.window);
    let text = '';
    for await (const chunk of loop.execute([...history, { role: 'user', content: BOUNDARY_QUESTION }], prose(shape.systemChars), { maxIterations: 1 })) text += chunk;
    return { requests, text };
  };

  return [
    // ── single-hop: the answering span reaches the recall block
    answerCase('S1', 'answer at the end of a long note', 'What is the orchid launch passphrase?', ['VIOLET-SENTINEL']),
    answerCase('S2', 'duplicate headings, the distinguishing note wins', 'How do we roll back the API deployment?', ['api-rollback-3']),
    answerCase('S3', 'a non-Latin query finds its note', 'मासिक भुगतान की अंतिम तिथि क्या है?', ['15 तारीख']),
    answerCase('S4', 'the answer among topical distractors', 'What is the cache eviction window?', ['45 minutes']),
    {
      id: 'S5', family: 'single-hop', title: 'no answer exists, so nothing is injected',
      run: async () => {
        const text = await recallText(await singleHop(), 'What is the guest wifi password at the office?');
        return graded(text === '', text, { abstained: text === '', injectedChars: text.length });
      },
    },

    // ── multi-hop-code: every required file or symbol reaches the tool output or the pack
    {
      id: 'M1', family: 'multi-hop-code', title: 'retry change needs the retry code, the cancellation contract and the test',
      run: async () => {
        const { root, index } = await retryRepo();
        const text = await search(index, root, 'change retry behaviour without breaking cancellation');
        const required = ['src/net/retry.ts', 'src/net/cancel.ts', 'src/net/retry.test.ts'];
        return graded(hasAll(text, required), text, { itemRecall: spanRecall(text, required) });
      },
    },
    {
      id: 'M2', family: 'multi-hop-code', title: 'a low-similarity config limit behind a behaviour question',
      run: async () => {
        const { root, index } = await retryRepo();
        const text = await search(index, root, 'why does a request give up after three attempts');
        const required = ['src/config/limits.ts', 'src/net/retry.ts'];
        return graded(hasAll(text, required), text, { itemRecall: spanRecall(text, required) });
      },
    },
    {
      id: 'M3', family: 'multi-hop-code', title: 'the context pack carries the body, the caller and the test caller',
      run: async () => {
        const { root, store } = await retryGraph();
        const pack = await planContext(store, 'func:src/net/retry.ts:retryWithBackoff', { cwd: root });
        const text = 'error' in pack ? pack.error : pack.text;
        const required = ['throwIfCancelled', 'fetchReport', 'stopsRetryingOnceCancelled'];
        return graded(!('error' in pack) && hasAll(text, required), text, { itemRecall: spanRecall(text, required), packError: 'error' in pack });
      },
    },

    // ── temporal: current, historical and conflicting values reach the recall block
    temporalCase('T1', 'the current value of a changed decision', 'What request timeout did we settle on?', ['60 seconds']),
    temporalCase('T2', 'the historical value when asked for it', 'What was the request timeout before June 2026?', ['30 seconds']),
    temporalCase('T3', 'both sides of a conflict between current sources', 'Which port does the metrics exporter listen on?', ['9464', '9100']),
    temporalCase('T4', 'the latest of two identically worded notes', 'When does the current release freeze start?', ['2026-09-11']),

    // ── source-change: stale text is never served as current
    {
      id: 'C1', family: 'source-change', title: 'a same-size, same-mtime rewrite',
      run: async () => {
        const { root, index } = await codeIndex('change-rewrite', { 'src/state.ts': 'export const state = "oldsentinel";\n' });
        const file = path.join(root, 'src/state.ts');
        fs.utimesSync(file, JAN_1, JAN_1);
        await index.sync();
        rewriteKeepingSizeAndMtime(file, 'export const state = "newsentinel";\n');
        await index.sync();
        const stale = await search(index, root, 'oldsentinel');
        const current = await search(index, root, 'newsentinel');
        return graded(!hasSpan(stale, 'oldsentinel') && hasSpan(current, 'newsentinel'), `${stale}\n${current}`, { staleAdmitted: hasSpan(stale, 'oldsentinel') });
      },
    },
    {
      id: 'C2', family: 'source-change', title: 'a renamed file',
      run: async () => {
        const { root, index } = await codeIndex('change-rename', { 'src/a/renamesource.ts': 'export const renamesentinel = 1;\n' });
        fs.mkdirSync(path.join(root, 'src/b'), { recursive: true });
        fs.renameSync(path.join(root, 'src/a/renamesource.ts'), path.join(root, 'src/b/renamed.ts'));
        await index.sync();
        const text = await search(index, root, 'renamesentinel');
        return graded(hasSpan(text, 'src/b/renamed.ts') && !hasSpan(text, 'src/a/renamesource.ts'), text, { staleAdmitted: hasSpan(text, 'src/a/renamesource.ts') });
      },
    },
    {
      id: 'C3', family: 'source-change', title: 'a deleted file',
      run: async () => {
        const { root, index } = await codeIndex('change-delete', { 'src/deleted.ts': 'export const deletesentinel = 1;\n', 'src/kept.ts': 'export const kept = 1;\n' });
        fs.unlinkSync(path.join(root, 'src/deleted.ts'));
        await index.sync();
        const text = await search(index, root, 'deletesentinel');
        // Paired with a live file in the same index, so a search that returns nothing cannot pass.
        const kept = await search(index, root, 'kept');
        return graded(!hasSpan(text, 'deletesentinel') && hasSpan(kept, 'src/kept.ts'), `${text}\n${kept}`, { staleAdmitted: hasSpan(text, 'deletesentinel'), liveFound: hasSpan(kept, 'src/kept.ts') });
      },
    },
    {
      id: 'C4', family: 'source-change', title: 'a change the index has not synced yet',
      run: async () => {
        const { root, index } = await codeIndex('change-unsynced', { 'src/unsynced.ts': 'export const marker = "beforesentinel";\n' });
        fs.writeFileSync(path.join(root, 'src/unsynced.ts'), 'export const marker = "aftersentinel, rewritten while the index was idle";\n');
        const text = await search(index, root, 'beforesentinel');
        // The new text must be found, so a search that returns nothing cannot pass.
        const current = await search(index, root, 'aftersentinel');
        return graded(!hasSpan(text, 'beforesentinel') && hasSpan(current, 'aftersentinel'), `${text}\n${current}`, { staleAdmitted: hasSpan(text, 'beforesentinel'), currentFound: hasSpan(current, 'aftersentinel') });
      },
    },
    {
      id: 'C5', family: 'source-change', title: 'a read-cache hit after a same-size, same-mtime rewrite',
      run: async () => {
        const root = dir('change-read-cache');
        const file = path.join(root, 'read.ts');
        fs.writeFileSync(file, 'export const state = "oldsentinel";\n');
        fs.utimesSync(file, JAN_1, JAN_1);
        const tool = createReadFileTool(governor);
        try {
          await tool.execute({ path: 'read.ts' }, { cwd: root });
          rewriteKeepingSizeAndMtime(file, 'export const state = "newsentinel";\n');
          const text = textOf(await tool.execute({ path: 'read.ts' }, { cwd: root }));
          return graded(hasSpan(text, 'newsentinel') && !hasSpan(text, 'oldsentinel'), text, { staleAdmitted: hasSpan(text, 'oldsentinel') });
        } finally {
          fileStateCache.invalidate(file);
        }
      },
    },

    // ── long-session: what survives ten compactions structurally
    {
      id: 'L1', family: 'long-session', title: "the user's constraint survives ten compactions",
      run: async () => { const { text } = await longSession(); return graded(hasSpan(text, 'never modify package.json'), text); },
    },
    {
      id: 'L2', family: 'long-session', title: 'the tested revision survives ten compactions',
      run: async () => { const { text } = await longSession(); return graded(hasSpan(text, '4f2a9c1'), text); },
    },
    {
      id: 'L3', family: 'long-session', title: 'a failed attempt survives ten compactions',
      run: async () => { const { text } = await longSession(); return graded(hasSpan(text, 'raising the test timeout'), text); },
    },
    {
      id: 'L4', family: 'long-session', title: 'context size after ten compactions',
      run: async () => {
        const { manager, messages, text } = await longSession();
        return measured(text, { messages: messages.length, estimatedTokens: manager.estimateTokens(messages) });
      },
    },

    // ── numeric: exact values with provenance, nothing inferred
    {
      id: 'N1', family: 'numeric', title: 'an exact value below a threshold, with its source row',
      run: async () => {
        const rows = (await facts()).query({ property: 'thickness', op: 'lt', value: 7 });
        const row = rows.find((r) => r.subject === 'E-206');
        const ok = !!row && row.value === 6.2 && row.unit === 'mm' && hasSpan(row.locator, 'Shell thickness') && row.sourceName === 'shell-inspection.xlsx';
        return graded(ok, factsText(rows), { rows: rows.length });
      },
    },
    {
      id: 'N2', family: 'numeric', title: 'units stay visible and unconverted when two tables differ',
      run: async () => {
        const rows = (await facts()).query({ property: 'thickness' });
        const inches = rows.filter((r) => r.subject.startsWith('P-'));
        const ok = rows.every((r) => r.unit !== null) && inches.length === 2 && inches.every((r) => r.unit === 'in') && inches.some((r) => r.value === 0.25);
        return graded(ok, factsText(rows), { units: [...new Set(rows.map((r) => r.unit))].join(',') });
      },
    },
    {
      id: 'N3', family: 'numeric', title: 'a missing date is not invented',
      run: async () => {
        const rows = (await facts()).query({ subject: 'E-207' });
        return graded(rows.length === 1 && rows[0].measuredOn === null, factsText(rows));
      },
    },
    {
      id: 'N4', family: 'numeric', title: 'a full-domain question returns every row',
      run: async () => {
        const rows = (await facts()).query({ property: 'thickness' });
        return graded(rows.length === 6, factsText(rows), { rows: rows.length });
      },
    },
    {
      id: 'N5', family: 'numeric', title: 'compression keeps the outlier in a numeric log',
      run: async () => {
        const log = Array.from({ length: 40 }, (_, i) => `latency ${i === 23 ? 900 : 100 + (i % 7) * 10} ms`).join('\n');
        const text = compressText(log);
        return graded(hasSpan(text, '900') && text.length < log.length, text, { compressedChars: text.length, originalChars: log.length });
      },
    },

    // ── budget: stated budgets hold; sizes recorded
    {
      id: 'B1', family: 'budget', title: 'context packs fit 100, 300, 800 and 1500 tokens measured from their text, and 10 is refused',
      run: async () => {
        const { root, store } = await largeTargetGraph();
        // Sizes are measured from the returned text, never taken from the pack's own tokenEstimate, and every one of
        // these budgets fits the target's headers, so an error is a failure here (audit 51, U09).
        const sizes: Record<string, number | string> = {};
        let failures = 0;
        for (const budget of [100, 300, 800, 1500]) {
          const pack = await planContext(store, 'budget-target', { cwd: root, maxTokens: budget });
          if ('error' in pack) { sizes[`at${budget}`] = 'error'; failures++; continue; }
          sizes[`at${budget}`] = estimatedTokens(pack.text);
          if (!withinBudget(pack.text, budget) || !hasSpan(pack.text, 'target') || !hasSpan(pack.text, 'descriptiveVariable')) failures++;
        }
        // A budget below the headers must be refused in words, never answered with an oversized pack.
        const impossible = await planContext(store, 'budget-target', { cwd: root, maxTokens: 10 });
        const refused = 'error' in impossible && /cannot fit in 10 tokens/.test(impossible.error);
        sizes.at10 = 'error' in impossible ? 'error' : estimatedTokens(impossible.text);
        return graded(failures === 0 && refused, JSON.stringify(sizes), { failures, refused, ...sizes });
      },
    },
    {
      id: 'B2', family: 'budget', title: 'a recall block stays within its character budget',
      run: async () => {
        const maxChars = 600;
        const text = await recallText(await singleHop(), 'What is the orchid launch passphrase?', maxChars);
        const body = text.split('\n').slice(1).join('\n');
        return graded(text !== '' && body.length <= maxChars + 8, text, { maxChars, bodyChars: body.length });
      },
    },
    {
      id: 'B3', family: 'budget', title: 'code search output size for a five-result query',
      run: async () => {
        const { root, index } = await retryRepo();
        const text = await search(index, root, 'change retry behaviour without breaking cancellation');
        return measured(text, { outputTokens: encode(text).length });
      },
    },
    {
      id: 'B4', family: 'budget', title: 'recall block size for a long-note answer',
      run: async () => {
        const text = await recallText(await singleHop(), 'What is the orchid launch passphrase?');
        return measured(text, { recallTokens: encode(text).length });
      },
    },

    {
      id: 'B5', family: 'budget', title: 'the answer survives a 600-character recall budget',
      run: async () => {
        const text = await recallText(await singleHop(), 'What is the orchid launch passphrase?', 600);
        return graded(hasSpan(text, 'VIOLET-SENTINEL'), text, { maxChars: 600 });
      },
    },

    // ── scope: scoped search stays in scope; incompleteness is said out loud
    {
      id: 'SC1', family: 'scope', title: 'a scoped search finds the in-scope hit under out-of-scope pressure',
      run: async () => {
        const { root, index } = await scopedRepo();
        const text = await search(index, root, 'needle', 1, 'wanted');
        return graded(hasSpan(text, 'wanted/target.ts'), text);
      },
    },
    {
      id: 'SC2', family: 'scope', title: 'a sibling directory with the same prefix stays out',
      run: async () => {
        const { root, index } = await scopedRepo();
        const text = await search(index, root, 'boundarysentinel', 5, 'wanted');
        // Control: without the scope the sibling is found, so its absence above is the scope, not an empty search.
        const unscoped = await search(index, root, 'boundarysentinel', 5);
        return graded(!hasSpan(text, 'wantedExtra/leak.ts') && hasSpan(unscoped, 'wantedExtra/leak.ts'), `${text}\n${unscoped}`, { siblingFoundUnscoped: hasSpan(unscoped, 'wantedExtra/leak.ts') });
      },
    },
    {
      id: 'SC3', family: 'scope', title: 'results from an incomplete index say the index is incomplete',
      run: async () => {
        const { hit } = await partialIndex();
        if (!hit) throw new Error('partial index returned no hits for any term');
        return graded(hasSpan(hit.text, 'index incomplete'), hit.text);
      },
    },
    {
      id: 'SC4', family: 'scope', title: 'no results from an incomplete index are not presented as absence',
      run: async () => {
        const { hit, miss } = await partialIndex();
        if (!miss) throw new Error('partial index found every term; the fixture is not partial');
        // A search that finds nothing at all is not an incomplete index: some term must be found.
        if (!hit) throw new Error('partial index returned no hits for any term; retrieval is not working');
        return graded(hasSpan(miss.text, 'syncing') || hasSpan(miss.text, 'incomplete'), miss.text);
      },
    },
    {
      id: 'SC5', family: 'scope', title: 'automatic recall leaves code-tagged documents to code search',
      run: async () => {
        const store = await codeTaggedStore();
        const text = await recallText(store, 'What does parseInvoiceTotals return for invoices?');
        return graded(!hasSpan(text, 'grouped by currency'), text);
      },
    },

    // ── version 3: held out for record 50 step 7, written before it and never tuned against
    {
      id: 'H1', family: 'single-hop', title: 'held out: no note answers, so nothing is injected',
      run: async () => {
        const text = await recallText(await heldOutNotes(), 'What is the door code for the third floor conference room?');
        return graded(text === '', text, { abstained: text === '', injectedChars: text.length });
      },
    },
    {
      id: 'H2', family: 'single-hop', title: 'held out: a note that answers is still injected',
      run: async () => {
        const text = await recallText(await heldOutNotes(), 'When does the parking garage close on weekdays?');
        return graded(hasSpan(text, '10 pm'), text);
      },
    },
    {
      id: 'H3', family: 'multi-hop-code', title: 'held out: a rounding change needs the invoice code, the rounding helper and the test',
      run: async () => {
        const { root, index } = await billingRepo();
        const text = await search(index, root, 'change how invoice totals are rounded without breaking the tax');
        const required = ['src/billing/invoice.ts', 'src/currency/round.ts', 'src/billing/invoice.test.ts'];
        return graded(hasAll(text, required), text, { itemRecall: spanRecall(text, required) });
      },
    },
    {
      id: 'H4', family: 'multi-hop-code', title: 'held out: an upload limit behind a behaviour question',
      run: async () => {
        const { root, index } = await uploadRepo();
        const text = await search(index, root, 'why is a file rejected above five megabytes');
        const required = ['src/config/upload.ts', 'src/upload/handler.ts'];
        return graded(hasAll(text, required), text, { itemRecall: spanRecall(text, required) });
      },
    },

    // ── version 3: the request boundary (record 50 step 6)
    {
      id: 'R1', family: 'budget', title: 'the request sent to the model fits its context window',
      run: async () => {
        const window = 3000;
        const { requests, text } = await boundaryTurn({ window, systemChars: 6000, toolChars: 6000, history: 30 });
        const main = requests[0];
        if (!main) return graded(false, text, { sent: false });
        const tokens = requestTokens(main);
        const questionSent = main.messages.some((m) => m.role === 'user' && String(m.content).includes(BOUNDARY_QUESTION));
        return graded(tokens <= window && questionSent, `${tokens} tokens\n${text}`, { requestTokens: tokens, window, questionSent });
      },
    },
    {
      id: 'R2', family: 'budget', title: 'a request that cannot fit is not sent, and the turn says why',
      run: async () => {
        const { requests, text } = await boundaryTurn({ window: 1000, systemChars: 8000, toolChars: 400, history: 2 });
        return graded(requests.length === 0 && /does not fit|cannot fit/i.test(text), text, { requestsSent: requests.length });
      },
    },

    // ── version 3: logs keep their shape (record 50 step 6)
    {
      id: 'N6', family: 'numeric', title: 'a compacted log keeps its line count, its failures and a route to the raw output',
      run: async () => {
        const manager = new ContextManager(summarizerKeepsNothing, 2000);
        const log = Array.from({ length: 400 }, (_, i) => (FAILED_CHUNKS.includes(i)
          ? `ERROR upload chunk ${i} failed: connection reset`
          : `INFO upload chunk ${i} stored in ${100 + (i % 9)} ms`)).join('\n');
        const messages = [
          { role: 'user', content: 'Upload the release assets and report what failed.' },
          ...shellExchange('c0', log),
          ...Array.from({ length: 9 }, (_, i) => shellExchange(`c${i + 1}`, `filler result ${i}`)).flat(),
        ];
        const out = await manager.checkAndCompact(messages as any);
        const text = String(out.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c0')?.content ?? '');
        const ok = hasSpan(text, '400 lines') && hasSpan(text, 'ERROR upload chunk 37 failed') && /archive:[0-9a-f]{32}/.test(text);
        return graded(ok, text, { chars: text.length, rawChars: log.length });
      },
    },

    // ── version 3: a large output is a queryable workspace (record 47 §3.6, record 50 step 7)
    {
      id: 'A1', family: 'workspace', title: 'a question about a large archived output is answered by searching it, not by reading it whole',
      run: async () => {
        const log = Array.from({ length: 2000 }, (_, i) => ([412, 1207, 1880].includes(i)
          ? `ERROR shard ${i} checksum mismatch`
          : `INFO shard ${i} verified`)).join('\n');
        const archived = archiveOutput(log);
        if (!archived) throw new Error('the archive could not be written');
        const text = textOf(await createContextArchiveTool(governor).execute({ handle: archived.handle, pattern: 'ERROR' }, { cwd: temp }));
        const expected = ['413: ERROR shard 412 checksum mismatch', '1208: ERROR shard 1207 checksum mismatch', '1881: ERROR shard 1880 checksum mismatch'];
        return graded(expected.every((line) => text.includes(line)) && text.length < 1000, text.slice(0, 4000), { chars: text.length });
      },
    },

    // ── version 3: continuity when the context manager is rebuilt (record 50 step 8)
    {
      id: 'L5', family: 'long-session', title: "the user's constraint survives a context manager rebuilt mid-task, as on a model switch",
      run: async () => {
        const { messages } = await longSession();
        const rebuilt = new ContextManager(summarizerKeepsNothing, 64000);
        let next: any[] = [...messages];
        for (let turn = 0; turn < 20; turn++) {
          next.push({ role: turn % 2 ? 'assistant' : 'user', content: `After the switch, turn ${turn}: routine progress on the upload module.` });
        }
        next = await rebuilt.compact(next);
        const text = next.map((m) => String(m.content)).join('\n');
        return graded(hasSpan(text, 'never modify package.json'), text);
      },
    },
  ];

}
