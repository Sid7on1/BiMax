// Deterministic worlds for the Phase 5 renderer journeys.
//
// Everything here is DATA. A journey selects a world and then drives the real renderer through it,
// so the same component tree is graded under permissions denied, stale evidence, a crashed engine
// and malformed protocol frames without any test-only branch in the product code.

export const PROJECT = '/Users/dev/projects/bimax';

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export function baseFixture(overrides = {}) {
  return {
    project: PROJECT,
    recentProjects: [PROJECT, '/Users/dev/projects/payments-service'],
    config: {
      model: 'moonshotai/kimi-k3',
      liteModel: 'mistralai/mistral-7b-instruct-v0.3',
      visionModel: 'moonshotai/kimi-k3',
      temperature: 1,
      maxTokens: 4096,
      contextMode: 'smart',
      contextWindowTokens: 1048576,
      reducedMotion: false,
      autoVerify: true,
      diffApproval: true,
    },
    catalog: {
      providers: [
        {
          name: 'nvidia',
          label: 'NVIDIA NIM',
          baseURL: 'https://integrate.api.nvidia.com/v1',
          apiKeyEnv: 'NVIDIA_API_KEY',
          hasKey: true,
          keyHint: '7Kp2',
          keyCount: 2,
          active: true,
        },
        {
          name: 'openai',
          label: 'OpenAI',
          baseURL: 'https://api.openai.com/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
          hasKey: false,
          keyCount: 0,
          active: false,
        },
      ],
      models: [
        {
          id: 'moonshotai/kimi-k3',
          label: 'Kimi K3',
          desc: 'Native multimodal coding, vision, and tool work.',
          tier: 'coding',
          recommendedFor: ['coding', 'vision'],
          served: true,
          curated: true,
          tags: ['coding', 'vision', 'agentic', 'tools'],
          parameters: '2.8T · 104B active',
          releaseDate: '2026-08-20',
          capabilities: {
            visionInput: true,
            reasoningEffortKnob: true,
            thinking: true,
            structuredOutputs: true,
            parallelToolCalls: false,
            contextWindow: 1048576,
          },
        },
        {
          id: 'mistralai/mistral-7b-instruct-v0.3',
          label: 'Mistral 7B Instruct',
          desc: 'Compact plain model for fast replies.',
          tier: 'lite',
          recommendedFor: ['lite'],
          served: true,
          curated: true,
          tags: ['quick', 'instruct', 'plain'],
          parameters: '7B',
          releaseDate: '2024-05-22',
          capabilities: {
            visionInput: false,
            reasoningEffortKnob: false,
            thinking: false,
            structuredOutputs: false,
            parallelToolCalls: false,
            contextWindow: 32768,
          },
        },
        {
          id: 'meta/muse-glimmer-30b',
          label: 'Muse Glimmer 30B',
          desc: 'Native image input, reasoning, and tool calls.',
          tier: 'vision',
          recommendedFor: ['vision', 'coding'],
          served: true,
          curated: true,
          tags: ['vision', 'agentic', 'tools'],
          parameters: '29.6B',
          releaseDate: '2026-08-10',
          capabilities: {
            visionInput: true,
            reasoningEffortKnob: true,
            thinking: true,
            structuredOutputs: true,
            parallelToolCalls: true,
            contextWindow: 131072,
          },
        },
        {
          id: 'openai/gpt-oss-120b',
          label: 'GPT-OSS 120B',
          desc: 'Heavy reasoning model; available through Browse all in Quick.',
          tier: 'coding',
          recommendedFor: ['coding'],
          served: true,
          curated: true,
          tags: ['coding', 'reasoning'],
          parameters: '120B',
          releaseDate: '2025-08-05',
          capabilities: {
            visionInput: false,
            reasoningEffortKnob: true,
            thinking: true,
            structuredOutputs: true,
            parallelToolCalls: true,
            contextWindow: 131072,
          },
        },
        {
          id: 'legacy/model-v1',
          label: 'Legacy Model V1',
          desc: 'Pinned previously but not served by this provider.',
          tier: 'other',
          served: false,
          curated: true,
        },
      ],
    },
    supervisor: {
      phase: 'ready',
      enteredAt: Date.now(),
      attempt: 1,
      generation: 1,
      message: 'Bimax is ready',
      reason: 'ready',
      profile: 'full',
      capabilities: [],
      degradedCapabilities: [],
      lastHeartbeat: {
        at: Date.now(),
        uptimeMs: 42000,
        rssMb: 286,
        heapMb: 121,
        eventLoopDelayMs: 2,
        activeTurn: false,
      },
    },
    crashHistory: [],
    git: {
      status: {
        branch: 'feat/retry-backoff',
        ahead: 1,
        behind: 0,
        files: [
          { path: 'src/api/client.ts', status: 'M', staged: true, insertions: 14, deletions: 3 },
          { path: 'src/api/retry.ts', status: '?', staged: false, insertions: 22, deletions: 0 },
        ],
      },
      diff: [
        'diff --git a/src/api/client.ts b/src/api/client.ts',
        '@@ -10,7 +10,9 @@ export class ApiClient {',
        '-    const res = await fetch(url);',
        '+    const res = await retry(3, () => fetch(url));',
        '     if (!res.ok) throw new ApiError(res);',
      ].join('\n'),
    },
    files: {
      '': [
        { name: 'src', dir: true },
        { name: 'package.json', dir: false },
      ],
      src: [
        { name: 'api', dir: true },
        { name: 'index.ts', dir: false },
      ],
    },
    fileContent: 'export const DEFAULT_ATTEMPTS = 3;\n',
    sessionsMeta: [],
    trustReport: grantedTrustReport(),
    manualAlphaStatus: {
      state: 'developer-id',
      ready: true,
      canApprove: false,
      serviceVersion: 'fixture-1',
      permissions: { accessibility: 'granted', screenRecording: 'granted' },
      detail: 'The Computer Use service has a production signing identity.',
    },
    takeover: { paused: false, generation: 0, reason: '', actor: 'system', changedAtMs: 0 },
    ...overrides,
  };
}

export function grantedTrustReport() {
  return {
    generatedAt: iso(),
    build: {
      packaged: true,
      appVersion: '1.1.0',
      electron: '43.3.0',
      chrome: '150',
      node: '24.18.1',
      platform: 'darwin',
      osRelease: '25.5.0',
      minimumMacOS: '13.0',
    },
    permissions: { accessibility: 'granted', screenRecording: 'granted' },
    components: [
      {
        name: 'engine',
        label: 'Coding engine',
        present: true,
        path: '/Applications/Bimax.app/Contents/Resources/engine/bimax-engine',
        source: 'bundle',
        computerUseOnly: false,
      },
      {
        name: 'macCapability',
        label: 'Mac capability provider',
        present: true,
        path: '/Applications/Bimax.app/Contents/Resources/mac-capability',
        source: 'bundle',
        computerUseOnly: true,
      },
      {
        name: 'cuService',
        label: 'Mac service',
        present: true,
        path: '/Applications/Bimax.app/Contents/XPCServices/BimaxCuService.xpc',
        source: 'bundle',
        computerUseOnly: true,
      },
    ],
    coding: { available: true, requiresPermissions: [] },
    computerUse: { available: true, blockers: [] },
    unknowns: [],
  };
}

export function deniedTrustReport() {
  const report = grantedTrustReport();
  report.permissions = { accessibility: 'denied', screenRecording: 'not-determined' };
  report.computerUse = {
    available: false,
    blockers: ['Accessibility permission is not granted', 'Screen Recording permission has not been decided'],
  };
  report.unknowns = ['whether this build is signed with a Developer ID identity'];
  // The invariant that must survive every permission state.
  report.coding = { available: true, requiresPermissions: [] };
  return report;
}

export const uiSnapshot = (overrides = {}) => ({
  models: { coding: 'moonshotai/kimi-k3', lite: 'mistralai/mistral-7b-instruct-v0.3' },
  goalCount: 1,
  mind: {
    weakSpots: 1,
    driveDeviations: 0,
    habits: 3,
    weak: [
      { tool: 'Edit', domain: 'go', failRate: 0.31, pWeak: 0.92, n: 26, advice: 'Prefer SymbolEdit for Go receivers.' },
    ],
    ledger: { resolved: 128, open: 4, expired: 9, coveragePct: 0.93, overconfident: 1 },
  },
  graph: {
    nodeCount: 48213,
    fileCount: 512,
    aiGraphBuilt: true,
    modules: [
      { name: 'src/core', criticality: 'high' },
      { name: 'src/api', criticality: 'med' },
    ],
    engine: 'codebase-memory',
  },
  contextWindow: 128000,
  tokensBaseline: 8948,
  compressionSaved: 12400,
  workspace: { count: 1, names: ['bimax'], writable: 1 },
  sessions: [
    {
      id: '2026-08-09_14-02-11',
      title: 'Add retry with backoff to the fetch client',
      startedAt: iso(-40 * 60e3),
      messageCount: 12,
      cwd: PROJECT,
      current: true,
    },
    {
      id: '2026-08-09_09-31-52',
      title: 'Fix pty resize race in the terminal',
      startedAt: iso(-5 * 3600e3),
      messageCount: 34,
      cwd: PROJECT,
      current: false,
    },
    {
      id: '2026-08-08_18-20-05',
      title: 'Wire word-level diffs into review',
      startedAt: iso(-20 * 3600e3),
      messageCount: 58,
      cwd: PROJECT,
      current: false,
    },
  ],
  checkpoints: [{ id: 'cp-9f2', label: 'green baseline', ts: Date.now() - 8 * 60e3, auto: false }],
  git: { branch: 'feat/retry-backoff', dirty: 2, ahead: 1, behind: 0 },
  tools: { registered: 47, ready: 21, deferred: 24, discovered: 2, mcp: 1, graphReady: true },
  ...overrides,
});

export const reviewSnapshot = (overrides = {}) => ({
  sessionId: '2026-08-09_14-02-11',
  state: 'verified',
  nextAction: 'Changes applied and the retry tests pass.',
  approvals: [
    {
      id: 1,
      kind: 'diff',
      question: 'Apply the retry changes to src/api/client.ts?',
      requestedAt: Date.now() - 5 * 60e3,
      resolution: { value: 'Approve', approved: true, at: Date.now() - 4 * 60e3 },
    },
  ],
  changes: [
    { file: 'src/api/client.ts', tools: ['EditFileTool'], edits: 2, lastCallId: 'tc-2', lastAt: Date.now() - 2 * 60e3 },
    { file: 'src/api/retry.ts', tools: ['WriteFileTool'], edits: 1, lastCallId: 'tc-3', lastAt: Date.now() - 2 * 60e3 },
  ],
  verifications: [
    {
      command: 'npm test -- retry',
      ok: true,
      settled: 2,
      coveredFiles: ['src/api/retry.ts'],
      repoWide: false,
      at: Date.now() - 45e3,
    },
  ],
  checkpoints: [{ id: 'cp-1', label: 'verified task', ts: Date.now() - 30e3, auto: false, ok: true }],
  lastCheckpoint: { id: 'cp-1', label: 'verified task', ts: Date.now() - 30e3, auto: false, ok: true },
  todos: [
    { content: 'Find the fetch call sites', status: 'completed' },
    { content: 'Add the retry helper', status: 'completed' },
    { content: 'Wire it into the client', status: 'completed' },
  ],
  interrupted: false,
  updatedAt: Date.now(),
  ...overrides,
});

export const failedReviewSnapshot = () =>
  reviewSnapshot({
    state: 'verification_failed',
    nextAction: 'npm test -- retry failed after these edits. Fix it and run the check again.',
    verifications: [
      {
        command: 'npm test -- retry',
        ok: false,
        settled: 2,
        coveredFiles: ['src/api/retry.ts'],
        repoWide: false,
        at: Date.now() - 45e3,
      },
    ],
    checkpoints: [],
    lastCheckpoint: null,
    todos: [
      { content: 'Find the fetch call sites', status: 'completed' },
      { content: 'Add the retry helper', status: 'completed' },
      { content: 'Fix the failing retry test', status: 'in_progress' },
    ],
  });

// --- Mac lane -----------------------------------------------------------------------------------

/**
 * A `mac_control` result as the Desktop provider actually emits it. `ageMs` moves the recorded
 * timestamp so a journey can produce genuinely stale evidence without waiting.
 */
/**
 * The engine registers provider tools as `mcp__<server>__<tool>` (src/mcp/client.ts), so a
 * production `tool_call` event names `mcp__bimax-mac__mac_control` — never the bare name the
 * provider declares over stdio. Fixtures use the production shape by default; `toolName` can still
 * be overridden to cover the bare form and the negative cases.
 */
export const QUALIFIED_MAC_CONTROL = 'mcp__bimax-mac__mac_control';
export const QUALIFIED_MAC_ACTION_TOOL = 'mcp__bimax-mac__BimaxActionTool';

export function macToolCall({
  id,
  action = 'click',
  app = 'Notes',
  pid = 4211,
  windowId = 88,
  frameId = 'f7-4211-88',
  ageMs = 2_000,
  ok = true,
  executor = 'semantic',
  mechanism = 'accessibility',
  postcondition = { query: 'Reminder saved', matched: true },
  label = 'Save',
  status = 'success',
  screenshot = '',
  code = undefined,
  toolName = QUALIFIED_MAC_CONTROL,
}) {
  const at = Date.now() - ageMs;
  const output = code
    ? JSON.stringify({
        ok: false,
        code,
        action,
        app,
        pid,
        windowId,
        error: 'computer use is paused because you took control',
      })
    : JSON.stringify(
        {
          ok,
          action,
          app,
          pid,
          windowId,
          frameId,
          driver: 'bimax-native',
          ...(screenshot ? { screenshot } : {}),
          targeting: { query: label, confidence: 'high', margin: 0.4, label, role: 'AXButton', reasons: ['label'] },
          executor: { level: executor, mechanism, description: `${executor} native action (${mechanism})` },
          actionResult: {
            delivered: ok,
            observed: ok ? 'changed' : 'failed',
            confidence: ok ? 'proven' : 'unknown',
            postcondition,
          },
          actionReceipt: {
            kind: 'pointer',
            target: { app, pid, windowId, element: label, role: 'AXButton' },
            preflight: {
              recipientPid: pid,
              recipientApp: app,
              windowMatched: true,
              elementMatched: true,
              elementConfidence: 'high',
              stable: true,
              reason: 'recipient matched by role + label',
            },
            commit: { delivered: ok, recipientApp: app },
            postcondition,
          },
        },
        null,
        2,
      );
  return {
    id,
    toolName,
    input: JSON.stringify({ action, query: label }),
    output,
    status,
    startTime: new Date(at - 400).toISOString(),
    endTime: new Date(at).toISOString(),
  };
}

export const browserToolCall = ({ id, url = 'http://localhost:5173/checkout', action = 'navigate' }) => ({
  id,
  toolName: 'BrowserTool',
  input: JSON.stringify({ action, url }),
  output: JSON.stringify({ ok: true, action, url, title: 'Checkout' }),
  status: 'success',
  startTime: iso(-8_000),
  endTime: iso(-7_000),
});

export const codingToolCall = ({ id, toolName = 'Edit', input = 'src/api/retry.ts — add retry()', output = 'ok' }) => ({
  id,
  toolName,
  input,
  output,
  status: 'success',
  startTime: iso(-9_000),
  endTime: iso(-8_000),
});

export const userMessage = (id, content) => ({ id, role: 'user', content, timestamp: iso(-60_000) });

export const assistantMessage = (id, content) => ({
  id,
  role: 'assistant',
  content,
  timestamp: iso(-30_000),
  thoughtMs: 2400,
});

// --- Malformed and stale protocol material -------------------------------------------------------

/**
 * Frames a hostile or out-of-date engine could send. The renderer must survive every one of them
 * without a page error and without rendering a fabricated fact.
 */
export const MALFORMED_FRAMES = [
  { t: 'event', name: 'ui_snapshot', args: [null] },
  { t: 'event', name: 'ui_snapshot', args: [{ graph: null, mind: null }] },
  { t: 'event', name: 'review_update', args: ['not-an-object'] },
  {
    t: 'event',
    name: 'review_update',
    args: [
      { state: 'from-the-future', changes: null, verifications: null, approvals: null, todos: null, checkpoints: null },
    ],
  },
  {
    t: 'event',
    name: 'tool_call',
    args: [
      {
        id: 'bad-1',
        toolName: 'mac_control',
        input: '{',
        output: 'not json at all',
        status: 'success',
        startTime: 'never',
      },
    ],
  },
  {
    t: 'event',
    name: 'tool_call',
    args: [
      {
        id: 'bad-2',
        toolName: 'mac_control',
        input: '{}',
        output: JSON.stringify({ ok: true, action: 'click' }),
        status: 'success',
        startTime: iso(),
      },
    ],
  },
  { t: 'event', name: 'subagent_update', args: ['nope'] },
  { t: 'event', name: 'todo_update', args: [{ not: 'an array' }] },
  { t: 'event', name: 'message', args: [null] },
  { t: 'event', name: 'a_message_type_from_a_newer_engine', args: [{ anything: true }] },
  { t: 'a_frame_type_from_a_newer_engine', payload: { anything: true } },
];
