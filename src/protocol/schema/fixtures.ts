import {
  Outbound,
  Inbound,
  PROTOCOL_FEATURES,
  PROTOCOL_MAX_COMPATIBLE_MAJOR,
  PROTOCOL_MIN_COMPATIBLE_MAJOR,
  PROTOCOL_SEMVER,
  PROTOCOL_VERSION,
} from '../protocol';
import type { UiSnapshot } from '../ui.snapshot';

/**
 * Protocol contract fixtures (v2 §3.11, honest-minimal tier).
 *
 * ONE canonical instance of every wire message, type-checked against the TS protocol
 * types at compile time and committed as `fixtures.json` for the Go side to strict-
 * decode (DisallowUnknownFields) in `tui/protocol_contract_test.go`. The result: a
 * field added or renamed on either side fails a test instead of silently garbling the
 * wire. Full codegen (schema → TS + Go structs) can replace the hand-mirrored types
 * later; the CONTRACT — both sides tested against one artifact — starts holding now.
 *
 * Every fixture deliberately populates EVERY optional field of its variant, so the
 * strict decoder exercises the whole surface, not the happy minimum.
 */

export const OUTBOUND_FIXTURES: Outbound[] = [
  { t: 'event', name: 'message', args: [{ role: 'assistant', content: 'hello', level: 'info' }] },
  {
    t: 'request',
    id: 7,
    kind: 'prompt',
    question: 'Run `npm test`?',
    options: ['Yes', 'No', 'Always Allow'],
    isAsk: false,
    isMulti: false,
  },
  {
    t: 'request',
    id: 8,
    kind: 'diff',
    question: 'Apply this edit?',
    options: ['Yes', 'No'],
    isAsk: false,
    isMulti: false,
    body: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new',
  },
  { t: 'request', id: 9, kind: 'input', question: 'Branch name:', options: [], isAsk: true, isMulti: false },
  { t: 'ready', protocol: PROTOCOL_VERSION },
  {
    t: 'hello',
    engine: { version: '1.1.0', buildCommit: '01234567' },
    protocolVersion: PROTOCOL_SEMVER,
    protocolMajor: PROTOCOL_VERSION,
    minCompatibleMajor: PROTOCOL_MIN_COMPATIBLE_MAJOR,
    maxCompatibleMajor: PROTOCOL_MAX_COMPATIBLE_MAJOR,
    features: [...PROTOCOL_FEATURES],
  },
  {
    t: 'queryResult',
    id: 3,
    items: [
      {
        value: '/git',
        label: '/git',
        desc: 'Git helpers',
        kind: 'command',
        disabled: true,
        disabledReason: 'repo not initialized',
      },
      { value: '@handlePayment', label: 'handlePayment', desc: 'src/pay.ts', kind: 'symbol' },
      { value: '@./src/', label: './src/', desc: 'directory', kind: 'path' },
    ],
  },
  { t: 'pong', id: 42 },
  {
    t: 'configResult',
    id: 5,
    config: { model: 'moonshotai/kimi-k3', notificationBell: false, temperature: 1, contextMode: 'smart' },
  },
  { t: 'boot', phase: 'loading_graph', detail: 'sqlite graph store', pid: 4242 },
  { t: 'health', uptimeMs: 61234, rssMb: 312, heapMb: 148, eventLoopDelayMs: 4, activeTurn: true, phase: 'ready' },
  // v3 additive (2026-08-10). `served: false` on a curated entry is the "unverified" case the
  // front-end must not render as "unavailable", so the fixture carries one of each.
  {
    t: 'catalogResult',
    id: 8,
    providers: [
      {
        name: 'openai-compatible',
        label: 'OpenAI-compatible',
        baseURL: 'https://api.example.invalid/v1',
        apiKeyEnv: 'BGW_API_KEY',
        hasKey: true,
        keyHint: '…4242',
        keyCount: 2,
        active: true,
      },
    ],
    models: [
      {
        id: 'moonshotai/kimi-k3',
        label: 'Kimi K3',
        desc: 'native multimodal coding agent',
        tier: 'coding',
        recommendedFor: ['coding', 'vision'],
        tags: ['coding', 'vision', 'agentic'],
        parameters: '2.8T · 104B active',
        releaseDate: '2026-08-20',
        served: true,
        curated: true,
        capabilities: {
          visionInput: false,
          reasoningEffortKnob: true,
          thinking: false,
          structuredOutputs: true,
          parallelToolCalls: true,
          contextWindow: 131072,
        },
      },
      {
        id: 'curated/unverified-vision',
        label: 'Unverified Vision',
        desc: 'curated but not served by this endpoint',
        tier: 'vision',
        served: false,
        curated: true,
        avoidAutoSelect: true,
      },
    ],
  },
];

export const INBOUND_FIXTURES: Inbound[] = [
  { t: 'reply', id: 7, value: 'Yes' },
  { t: 'input', text: 'refactor the auth module' },
  { t: 'interrupt' },
  { t: 'query', id: 3, text: '/g' },
  { t: 'menuSelect', id: 'model-menu', value: 'claude-fable-5' },
  { t: 'ping', id: 42 },
  { t: 'configGet', id: 5 },
  { t: 'configSet', id: 6, patch: { notificationBell: true, reasoningEffort: 'high' } },
  { t: 'resume', id: 'sess-20260712-abc123' },
  { t: 'controls', mode: 'code', tier: 'heavy', autonomy: 'ask' },
  // v3 additive (2026-08-10). `apiKey` is write-only and never echoed back; the value here is an
  // obvious placeholder so this committed fixture can never be mistaken for a real credential.
  { t: 'catalogGet', id: 8, refresh: true },
  {
    t: 'providerSet',
    id: 9,
    name: 'openai-compatible',
    baseURL: 'https://api.example.invalid/v1',
    apiKey: 'fixture-not-a-real-key',
  },
];

// Compile-time exhaustiveness: adding a new message variant without a fixture makes
// these records fail to type-check — the contract cannot silently under-cover.
export const OUTBOUND_KINDS: Record<Outbound['t'], true> = {
  event: true,
  request: true,
  ready: true,
  hello: true,
  queryResult: true,
  pong: true,
  configResult: true,
  catalogResult: true,
  boot: true,
  health: true,
};
export const INBOUND_KINDS: Record<Inbound['t'], true> = {
  reply: true,
  input: true,
  interrupt: true,
  query: true,
  menuSelect: true,
  ping: true,
  configGet: true,
  configSet: true,
  catalogGet: true,
  providerSet: true,
  resume: true,
  controls: true,
};

/**
 * Semantic parity fixture for the ui_snapshot payload (which rides event args and therefore
 * escapes the Outbound strict decode). Typed against the REAL UiSnapshot interface with EVERY
 * optional populated: adding a field here without mirroring it in tui/protocol.go turns the Go
 * strict-decode test red — a produced-but-ignored field can no longer drift silently.
 */
export const UI_SNAPSHOT_FIXTURE: Required<UiSnapshot> = {
  models: { coding: 'model-a', lite: 'model-b', vision: 'model-c' },
  goalCount: 1,
  mind: {
    weakSpots: 1,
    driveDeviations: 1,
    habits: 1,
    weak: [{ tool: 'BashTool', domain: 'shell', failRate: 0.4, pWeak: 0.9, n: 12, advice: 'verify first' }],
    drives: [{ label: 'type errors', value: '3', ok: false, spark: [1, 0, 1] }],
    habitNames: ['read-then-edit'],
    ledger: { resolved: 3, open: 1, expired: 1, coveragePct: 75, overconfident: 0 },
  },
  graph: {
    nodeCount: 10,
    fileCount: 4,
    aiGraphBuilt: true,
    modules: [{ name: 'core', criticality: 'high' }],
    engine: 'native',
  },
  contextWindow: 128000,
  tokensBaseline: 9000,
  compressionSaved: 1200,
  workspace: { count: 2, names: ['repo-a', 'repo-b'], writable: 1 },
  sessions: [
    { id: 's1', title: 'fix auth', startedAt: '2026-07-22T00:00:00Z', messageCount: 8, cwd: '/w', current: true },
  ],
  checkpoints: [{ id: 'c1', label: 'before refactor', ts: 1753142400000, auto: false }],
  git: { branch: 'main', dirty: 2, ahead: 1, behind: 0 },
  tools: { registered: 40, ready: 25, deferred: 12, discovered: 3, mcp: 5, graphReady: true },
  tasks: [
    {
      id: 't1',
      kind: 'shell',
      title: 'npm test',
      state: 'running',
      elapsedMs: 4200,
      attention: false,
      pinned: true,
      lastEvent: 'output',
      progress: 0.5,
      canPause: true,
      canResume: false,
      canCancel: true,
    },
  ],
};

/** The committed artifact both sides test against. Regenerate with `npm run gen:protocol`. */
export function fixturesJson(): string {
  return (
    JSON.stringify(
      {
        protocolVersion: PROTOCOL_VERSION,
        outbound: OUTBOUND_FIXTURES,
        inbound: INBOUND_FIXTURES,
        uiSnapshot: UI_SNAPSHOT_FIXTURE,
      },
      null,
      2,
    ) + '\n'
  );
}
