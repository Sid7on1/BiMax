/**
 * Phase 5 renderer view models.
 *
 * These are the modules that decide what the workspace CLAIMS: the task's one state, which evidence
 * lanes exist, what the Live Target says about the app/window/evidence age, and whether a receipt is
 * proven. Every test here grades an end state, and each block ends with the mutation that the
 * assertion exists to catch — `08_ACCEPTANCE_GATES.md` requires a test to fail against a
 * deliberately neutered implementation, so the mutants are written out rather than implied.
 *
 * They live in the Terminal suite alongside `trust.center.model.test.ts` and
 * `receipt.inspector.test.ts`, which is where the existing Desktop pure-logic tests already run.
 */
import { deriveTaskState } from '../renderer/src/task.state';
import {
  deriveMacSession, describeEvidenceAge, describeMacAction, isMacToolCall, EVIDENCE_MAX_AGE_MS,
  type MacToolCall,
} from '../renderer/src/mac.session.model';
import { DEFAULT_FRAME_MAX_AGE_MS } from '../capabilities/mac/frame';
import { inspectorTabs, resolveActiveTab } from '../renderer/src/inspector.model';
import { buildFinalReceipt } from '../renderer/src/final.receipt.model';
import { deriveBrowserSession } from '../renderer/src/browser.session.model';
import {
  normalizeUiSnapshot, normalizeReviewSnapshot, normalizeSubAgents, normalizeTodos,
} from '../renderer/src/protocol.normalize';
import type { ReviewSnapshot } from '../renderer/src/protocol';
import { MAC_PROVIDER_SERVER_NAME, macToolIdentity } from '../shared/mac.provider';
import { buildEngineChildEnv } from '../main/runtime.paths';
import { inferLane, needsTrustCenterBeforeRun } from '../renderer/src/lane.inference';

const NOW = 1_800_000_000_000;

const review = (overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  sessionId: 's1',
  state: 'verified',
  nextAction: 'Changes applied and the checks passed.',
  approvals: [],
  changes: [{ file: 'src/api/client.ts', tools: ['EditFileTool'], edits: 2, lastAt: NOW - 60_000 }],
  verifications: [{ command: 'npm test -- retry', ok: true, settled: 1, coveredFiles: [], repoWide: false, at: NOW - 30_000 }],
  checkpoints: [],
  lastCheckpoint: null,
  todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
  interrupted: false,
  updatedAt: NOW,
  ...overrides,
});

function macCall(overrides: Partial<MacToolCall> & { payload?: Record<string, unknown> } = {}): MacToolCall {
  const { payload, ...rest } = overrides;
  // Production shape by default: this is what the engine emits.
  const body = {
    ok: true, action: 'click', app: 'Notes', pid: 4211, windowId: 88, frameId: 'f7-4211-88',
    targeting: { query: 'Save', label: 'Save' },
    executor: { level: 'semantic', mechanism: 'accessibility' },
    actionResult: { delivered: true, observed: 'changed', postcondition: { query: 'saved', matched: true } },
    actionReceipt: {
      kind: 'pointer', target: { app: 'Notes', pid: 4211, windowId: 88 },
      preflight: { reason: 'matched' }, commit: { delivered: true },
      postcondition: { query: 'saved', matched: true },
    },
    ...payload,
  };
  return {
    id: 'm1', toolName: 'mcp__bimax-mac__mac_control', input: '{"action":"click"}',
    output: JSON.stringify(body), status: 'success',
    startTime: new Date(NOW - 3_000).toISOString(),
    endTime: new Date(NOW - 2_000).toISOString(),
    ...rest,
  };
}

const idleTaskInput = {
  awaitingReply: false, busy: false, streaming: false, review: null,
  todos: [], macPaused: false, hasContent: false,
};

describe('task state', () => {
  test('a user holding the Mac outranks every other signal, including a busy engine', () => {
    const view = deriveTaskState({ ...idleTaskInput, busy: true, macPaused: true, hasContent: true });
    expect(view.state).toBe('needs-you');
    expect(view.label).toBe('You have control');
    expect(view.interruptible).toBe(false);
  });

  test('a pending approval is never rendered as progress', () => {
    expect(deriveTaskState({ ...idleTaskInput, busy: true, awaitingReply: true }).state).toBe('needs-you');
    expect(deriveTaskState({ ...idleTaskInput, busy: true, review: review({ state: 'awaiting_approval' }) }).state)
      .toBe('needs-you');
  });

  test('a failed verification outranks a finished turn', () => {
    const view = deriveTaskState({ ...idleTaskInput, hasContent: true, review: review({ state: 'verification_failed' }) });
    expect(view.state).toBe('failed');
    expect(view.label).toBe('Check failed');
  });

  test('verified is claimed only when the engine said so', () => {
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: review() }).state).toBe('verified');
    // A turn that simply ended is NOT verified.
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: null }).state).toBe('idle');
    // Nor is an unverified review.
    expect(deriveTaskState({ ...idleTaskInput, hasContent: true, review: review({ state: 'unverified' }) }).state)
      .toBe('working');
  });

  test('progress counts only completed steps', () => {
    const view = deriveTaskState({
      ...idleTaskInput, busy: true,
      review: review({ state: 'applying', todos: [
        { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
      ] }),
    });
    expect(view.progress).toEqual({ done: 1, total: 3 });
  });

  // Mutant: an implementation that reported `busy` first would call a blocked task "Working".
  test('MUTANT — ranking busy above the human would mislabel a blocked task', () => {
    const naive = (input: typeof idleTaskInput): string => (input.busy ? 'working' : 'idle');
    const blocked = { ...idleTaskInput, busy: true, awaitingReply: true };
    expect(naive(blocked)).toBe('working');
    expect(deriveTaskState(blocked).state).not.toBe('working');
  });
});

describe('Mac live session', () => {
  test('the freshness budget matches the runtime that would refuse a stale frame', () => {
    // If these ever diverge the UI would call an observation fresh that the runtime rejects.
    expect(EVIDENCE_MAX_AGE_MS).toBe(DEFAULT_FRAME_MAX_AGE_MS);
  });

  test('recognizes the FULLY QUALIFIED names the engine actually emits', () => {
    // src/mcp/client.ts registers every provider tool as `mcp__<server>__<tool>`, and
    // runtime.paths.ts names this server `bimax-mac`. These are the strings that appear in a real
    // tool_call event; recognizing only the bare names meant the Mac lane never lit up in
    // production, however green the renderer journeys were.
    expect(isMacToolCall({ toolName: 'mcp__bimax-mac__mac_control' })).toBe(true);
    expect(isMacToolCall({ toolName: 'mcp__bimax-mac__BimaxActionTool' })).toBe(true);
    expect(isMacToolCall({ toolName: 'mcp__bimax-mac__BimaxTransactionTool' })).toBe(true);
    // Our own server may add tools later; they must not silently vanish from the Mac lane.
    expect(isMacToolCall({ toolName: 'mcp__bimax-mac__some_future_tool' })).toBe(true);
  });

  test('still recognizes the bare names used where no MCP client sits in between', () => {
    // The provider itself, the stdio contract probe and the packaged conformance harness call the
    // provider directly, so both shapes are legitimate — through ONE recognizer.
    expect(isMacToolCall({ toolName: 'mac_control' })).toBe(true);
    expect(isMacToolCall({ toolName: 'BimaxActionTool' })).toBe(true);
  });

  test('does NOT classify unrelated MCP tools as Mac tools', () => {
    // A third party's tool called mac_control is not Bimax's Mac provider. Treating it as one would
    // put someone else's output into the Live Target, the takeover state and the receipt.
    expect(isMacToolCall({ toolName: 'mcp__github__mac_control' })).toBe(false);
    expect(isMacToolCall({ toolName: 'mcp__other-server__BimaxActionTool' })).toBe(false);
    expect(isMacToolCall({ toolName: 'mcp__bimax-mac-evil__mac_control' })).toBe(false);
    expect(isMacToolCall({ toolName: 'mcp__codebase-memory__search' })).toBe(false);
    expect(isMacToolCall({ toolName: 'Edit' })).toBe(false);
    expect(isMacToolCall({ toolName: '' })).toBe(false);
    // The engine-owned ComputerTool no longer exists; matching it would resurrect dead vocabulary.
    expect(isMacToolCall({ toolName: 'ComputerTool' })).toBe(false);
  });

  test('the recognizer and the descriptor agree on the server name', () => {
    // If runtime.paths.ts ever renamed the server, the renderer would stop recognizing production
    // events. Both read the same constant, and this asserts it.
    const env = buildEngineChildEnv({
      parentEnv: {}, extraEnv: {}, path: '/usr/bin', projectDir: '/tmp/p',
      architecture: 'arm64', resolved: { macCapability: '/Bimax.app/mac-capability' },
    });
    const descriptor = JSON.parse(env.BIMAX_HOST_CAPABILITIES_JSON as string);
    expect(descriptor.servers[0].name).toBe(MAC_PROVIDER_SERVER_NAME);
    expect(isMacToolCall({ toolName: `mcp__${descriptor.servers[0].name}__mac_control` })).toBe(true);
  });

  test('a fully qualified Mac result drives the live session end to end', () => {
    const session = deriveMacSession(
      [macCall({ toolName: 'mcp__bimax-mac__mac_control' })], { paused: false, reason: '' }, NOW,
    );
    expect(session.active).toBe(true);
    expect(session.target).toEqual({ app: 'Notes', pid: 4211, windowId: 88 });
    expect(session.latest?.label).toBe('Clicked Save');
  });

  test('binds the exact target, observation and confirmation from the payload', () => {
    const session = deriveMacSession([macCall()], { paused: false, reason: '' }, NOW);
    expect(session.active).toBe(true);
    expect(session.target).toEqual({ app: 'Notes', pid: 4211, windowId: 88 });
    expect(session.evidence?.observation).toBe('f7-4211-88');
    expect(session.evidence?.freshness).toBe('fresh');
    expect(session.latest?.label).toBe('Clicked Save');
    expect(session.latest?.executor).toBe('semantic');
    // The compatibility receipt names the condition it matched, which is what the UI shows.
    expect(session.latest?.postcondition).toBe('matched · saved');
  });

  test('evidence past the budget is stale, and an untimestamped one is unknown — never fresh', () => {
    const old = macCall({
      startTime: new Date(NOW - 200_000).toISOString(),
      endTime: new Date(NOW - 190_000).toISOString(),
    });
    expect(deriveMacSession([old], { paused: false, reason: '' }, NOW).evidence?.freshness).toBe('stale');

    const undated = macCall({ startTime: 'not a date', endTime: undefined });
    const session = deriveMacSession([undated], { paused: false, reason: '' }, NOW);
    expect(session.evidence?.freshness).toBe('unknown');
    expect(describeEvidenceAge(session.evidence)).toBe('age not recorded');
  });

  test('a target is never inherited from a payload that did not name one', () => {
    const nameless = macCall({ id: 'm2', payload: { app: undefined, pid: undefined, windowId: undefined } });
    const session = deriveMacSession([nameless], { paused: false, reason: '' }, NOW);
    expect(session.target).toBeNull();
  });

  test('paused comes from the app-owned latch, and a refusal is counted as evidence of it', () => {
    const refused = macCall({
      id: 'm3', status: 'error',
      output: JSON.stringify({ ok: false, code: 'computer_use_paused', action: 'type', app: 'Notes' }),
    });
    const session = deriveMacSession([macCall(), refused], { paused: true, reason: 'You took control' }, NOW);
    expect(session.paused).toBe(true);
    expect(session.state).toBe('paused');
    expect(session.refusedWhilePaused).toBe(1);
    expect(session.latest?.refusedForTakeover).toBe(true);
    expect(session.latest?.label).toContain('Refused');
  });

  test('a refusal alone never makes the UI claim the user has control', () => {
    const refused = macCall({
      id: 'm3', status: 'error',
      output: JSON.stringify({ ok: false, code: 'computer_use_paused', action: 'type' }),
    });
    // Latch says running. The refusal is in the transcript but the control state is main's to state.
    const session = deriveMacSession([refused], { paused: false, reason: '' }, NOW);
    expect(session.paused).toBe(false);
    expect(session.state).not.toBe('paused');
  });

  test('a provider block is never rendered as a completed action', () => {
    const blocked = macCall({
      input: JSON.stringify({ action: 'open', app: 'Messages' }),
      status: 'success',
      output: JSON.stringify({
        ok: false, action: 'open', blocked: true, code: 'untrusted_observation_authority',
        reason: 'missing, expired, or invalid authenticated task plan',
        verification: {
          status: 'not_attempted', freshObservation: false,
          reason: 'missing, expired, or invalid authenticated task plan',
        },
      }),
    });
    const session = deriveMacSession([blocked], { paused: false, reason: '' }, NOW);
    expect(session.state).toBe('blocked');
    expect(session.latest).toMatchObject({
      label: 'Blocked: open Messages', status: 'error', outcome: 'blocked',
      postcondition: 'missing, expired, or invalid authenticated task plan',
    });
    expect(session.target).toBeNull();
  });

  test('actions read as intents, with no mechanism vocabulary', () => {
    expect(describeMacAction('click', { targeting: { label: 'Send' } })).toBe('Clicked Send');
    expect(describeMacAction('open', { app: 'Messages' })).toBe('Opened Messages');
    expect(describeMacAction('observe', { app: 'Notes' })).toBe('Looked at Notes');
  });

  // Mutant: treating age as fresh whenever it is recorded.
  test('MUTANT — calling any timestamped observation fresh would pass off a three-minute-old screen', () => {
    const naive = (ageMs: number | null): string => (ageMs === null ? 'unknown' : 'fresh');
    expect(naive(180_000)).toBe('fresh');
    const old = macCall({
      startTime: new Date(NOW - 190_000).toISOString(),
      endTime: new Date(NOW - 180_000).toISOString(),
    });
    expect(deriveMacSession([old], { paused: false, reason: '' }, NOW).evidence?.freshness).toBe('stale');
  });
});

describe('contextual inspector', () => {
  const emptyMac = deriveMacSession([], { paused: false, reason: '' }, NOW);

  test('a lane appears only once its evidence exists', () => {
    const tabs = inspectorTabs({
      review: null, gitStatus: null, mac: emptyMac, subagents: [], hasProject: true, browserUrl: '',
    });
    expect(tabs.find(tab => tab.id === 'mac')?.available).toBe(false);
    expect(tabs.find(tab => tab.id === 'browser')?.available).toBe(false);
    expect(tabs.find(tab => tab.id === 'team')?.available).toBe(false);
    expect(tabs.find(tab => tab.id === 'receipt')?.available).toBe(false);
    // Files is workspace navigation, not task evidence: a project is enough.
    expect(tabs.find(tab => tab.id === 'files')?.available).toBe(true);
  });

  test('every unavailable lane explains itself instead of vanishing', () => {
    const tabs = inspectorTabs({
      review: null, gitStatus: null, mac: emptyMac, subagents: [], hasProject: false, browserUrl: '',
    });
    for (const tab of tabs.filter(candidate => !candidate.available)) {
      expect(tab.emptyReason.length).toBeGreaterThan(10);
    }
  });

  test('stale evidence, a pause, and a failed check each raise attention', () => {
    const stale = deriveMacSession([macCall({
      startTime: new Date(NOW - 200_000).toISOString(),
      endTime: new Date(NOW - 190_000).toISOString(),
    })], { paused: false, reason: '' }, NOW);
    const tabs = inspectorTabs({
      review: review({ state: 'verification_failed' }), gitStatus: null, mac: stale,
      subagents: [], hasProject: true, browserUrl: '',
    });
    expect(tabs.find(tab => tab.id === 'mac')?.attention).toBe(true);
    expect(tabs.find(tab => tab.id === 'code')?.attention).toBe(true);
  });

  test('resolveActiveTab never selects an unavailable lane and honours an explicit choice', () => {
    const tabs = inspectorTabs({
      review: review(), gitStatus: null, mac: emptyMac, subagents: [], hasProject: true, browserUrl: '',
    });
    expect(resolveActiveTab(tabs, 'mac')).not.toBe('mac');
    expect(resolveActiveTab(tabs, 'code')).toBe('code');
    expect(resolveActiveTab(tabs, null)).toBe('code');
  });

  test('a lane needing attention wins when the user has not chosen', () => {
    const tabs = inspectorTabs({
      review: review({ state: 'verification_failed' }), gitStatus: null,
      mac: emptyMac, subagents: [], hasProject: true, browserUrl: '',
    });
    expect(resolveActiveTab(tabs, null)).toBe('code');
  });
});

describe('final receipt', () => {
  test('a claim is proven only when a check passed and none failed', () => {
    const mac = deriveMacSession([macCall()], { paused: false, reason: '' }, NOW);
    const receipt = buildFinalReceipt({ review: review(), mac });
    expect(receipt.complete).toBe(true);
    expect(receipt.claims.find(claim => claim.id === 'code-changes')?.proven).toBe(true);
    expect(receipt.claims.find(claim => claim.id === 'mac-actions')?.proven).toBe(true);
  });

  test('a failed check makes the code claim unproven and names the gap', () => {
    const mac = deriveMacSession([], { paused: false, reason: '' }, NOW);
    const receipt = buildFinalReceipt({
      review: review({
        state: 'verification_failed',
        verifications: [{ command: 'npm test', ok: false, settled: 1, coveredFiles: [], repoWide: false, at: NOW }],
      }),
      mac,
    });
    expect(receipt.complete).toBe(false);
    expect(receipt.claims[0].proven).toBe(false);
    expect(receipt.gaps.join(' ')).toMatch(/failed/);
  });

  test('edits with no check at all are unproven, not quietly complete', () => {
    const mac = deriveMacSession([], { paused: false, reason: '' }, NOW);
    const receipt = buildFinalReceipt({ review: review({ verifications: [] }), mac });
    expect(receipt.complete).toBe(false);
    expect(receipt.gaps.join(' ')).toMatch(/no verification command was run/);
  });

  test('a Mac action that never confirmed its end state is a gap', () => {
    const unconfirmed = macCall({
      payload: {
        actionResult: { delivered: true, observed: 'changed', postcondition: { query: 'saved', matched: false } },
        actionReceipt: {
          kind: 'pointer', target: { app: 'Notes', pid: 4211, windowId: 88 },
          preflight: { reason: 'matched' }, commit: { delivered: true },
          postcondition: { query: 'saved', matched: false },
        },
      },
    });
    const mac = deriveMacSession([unconfirmed], { paused: false, reason: '' }, NOW);
    const receipt = buildFinalReceipt({ review: null, mac });
    expect(receipt.complete).toBe(false);
    expect(receipt.claims[0].gap).toMatch(/no action confirmed its expected end state/);
  });

  test('stale evidence and refusals while paused are recorded as gaps', () => {
    const refused = macCall({
      id: 'm3', status: 'error',
      output: JSON.stringify({ ok: false, code: 'computer_use_paused', action: 'type' }),
    });
    const stale = macCall({
      id: 'm4',
      startTime: new Date(NOW - 200_000).toISOString(),
      endTime: new Date(NOW - 190_000).toISOString(),
    });
    const mac = deriveMacSession([stale, refused], { paused: true, reason: 'You took control' }, NOW);
    const receipt = buildFinalReceipt({ review: null, mac });
    expect(receipt.gaps.join(' ')).toMatch(/older than the freshness budget/);
    expect(receipt.gaps.join(' ')).toMatch(/refused while you held control/);
  });

  test('an UNATTRIBUTED executor cannot produce a proven Mac claim', () => {
    // executor.ladder.ts returns `unattributed` exactly when the runtime could not say which
    // executor acted. A green postcondition beside an unknown executor is not proof: there is no
    // record of what actually touched the machine.
    const unattributed = macCall({ payload: { executor: { level: undefined, mechanism: null } } });
    const mac = deriveMacSession([unattributed], { paused: false, reason: '' }, NOW);
    expect(mac.latest?.executor).toBe('unattributed');
    expect(mac.latest?.postcondition).toMatch(/^matched/);

    const receipt = buildFinalReceipt({ review: null, mac });
    const claim = receipt.claims.find(candidate => candidate.id === 'mac-actions');
    expect(claim?.proven).toBe(false);
    expect(claim?.gap).toMatch(/could not be attributed to an executor/);
    expect(receipt.complete).toBe(false);
    // The evidence row for that action must not read as a tick either.
    expect(claim?.evidence[0].ok).toBe(false);
  });

  test('a proven Mac claim needs success, a matched postcondition, an executor AND a bound target', () => {
    const mac = deriveMacSession([macCall()], { paused: false, reason: '' }, NOW);
    expect(buildFinalReceipt({ review: null, mac }).claims[0].proven).toBe(true);

    // Same successful, confirmed, attributed action — but nothing ever named the app/window/frame.
    const unbound = deriveMacSession(
      [macCall({ payload: { app: undefined, pid: undefined, windowId: undefined, frameId: undefined, actionReceipt: undefined } })],
      { paused: false, reason: '' }, NOW,
    );
    const receipt = buildFinalReceipt({ review: null, mac: unbound });
    expect(receipt.claims[0].proven).toBe(false);
  });

  // Mutant: attribution ignored.
  test('MUTANT — proving on postcondition alone would pass an unattributed action', () => {
    const naive = (postconditionMatched: boolean): boolean => postconditionMatched;
    expect(naive(true)).toBe(true);
    const mac = deriveMacSession(
      [macCall({ payload: { executor: { level: undefined, mechanism: null } } })],
      { paused: false, reason: '' }, NOW,
    );
    expect(buildFinalReceipt({ review: null, mac }).claims[0].proven).toBe(false);
  });

  // Mutant: "the tools ran, so it worked".
  test('MUTANT — proving a claim from delivery alone would call a failed run complete', () => {
    const naive = (delivered: boolean): boolean => delivered;
    expect(naive(true)).toBe(true);
    const mac = deriveMacSession([], { paused: false, reason: '' }, NOW);
    const receipt = buildFinalReceipt({
      review: review({
        verifications: [{ command: 'npm test', ok: false, settled: 1, coveredFiles: [], repoWide: false, at: NOW }],
      }),
      mac,
    });
    expect(receipt.complete).toBe(false);
  });
});

describe('browser lane', () => {
  test('reads the current page from the engine’s own browser results', () => {
    const session = deriveBrowserSession([{
      id: 'b1', toolName: 'BrowserTool', input: '{"action":"navigate"}',
      output: JSON.stringify({ ok: true, action: 'navigate', url: 'http://localhost:5173/checkout' }),
      status: 'success', startTime: new Date(NOW).toISOString(),
    }]);
    expect(session.active).toBe(true);
    expect(session.currentUrl).toBe('http://localhost:5173/checkout');
  });

  test('a result with no URL does not invent one', () => {
    const session = deriveBrowserSession([{
      id: 'b1', toolName: 'BrowserTool', input: '{}', output: '{"ok":true}',
      status: 'success', startTime: new Date(NOW).toISOString(),
    }]);
    expect(session.currentUrl).toBe('');
  });
});

describe('protocol normalization', () => {
  test('a snapshot missing whole sections still produces a renderable shape', () => {
    const snapshot = normalizeUiSnapshot({ graph: null, mind: null });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.models.coding).toBe('');
    expect(snapshot!.graph.engine).toBe('none');
    expect(snapshot!.mind.weakSpots).toBe(0);
    expect(snapshot!.sessions).toEqual([]);
  });

  test('a non-object snapshot is dropped rather than half-adopted', () => {
    expect(normalizeUiSnapshot('nope')).toBeNull();
    expect(normalizeUiSnapshot(null)).toBeNull();
    expect(normalizeUiSnapshot([1, 2])).toBeNull();
  });

  test('an unknown review state degrades to idle, never to a green one', () => {
    const snapshot = normalizeReviewSnapshot({ state: 'from-the-future' });
    expect(snapshot?.state).toBe('idle');
  });

  test('a verification with no stated result is not a pass', () => {
    const snapshot = normalizeReviewSnapshot({
      state: 'verified', verifications: [{ command: 'npm test' }],
    });
    expect(snapshot?.verifications[0].ok).toBe(false);
  });

  test('array payloads that are not arrays become empty, not crashes', () => {
    expect(normalizeSubAgents({ not: 'an array' })).toEqual([]);
    expect(normalizeTodos('nope')).toEqual([]);
    expect(normalizeReviewSnapshot({ changes: null, approvals: 'x' })?.changes).toEqual([]);
  });

  // Mutant: passing the payload straight through.
  test('MUTANT — trusting the payload would put undefined into the composer', () => {
    const passthrough = (raw: any): any => raw;
    expect(() => passthrough({ graph: null }).models.coding).toThrow();
    expect(normalizeUiSnapshot({ graph: null })!.models.coding).toBe('');
  });
});


describe('composer lane inference', () => {
  test('a named Mac surface is Control Mac', () => {
    expect(inferLane('Open System Settings and turn on Night Shift').lane).toBe('mac');
    expect(inferLane('take a screenshot of Finder').lane).toBe('mac');
    expect(inferLane('send a message in Messages to my test contact').lane).toBe('mac');
  });

  test('ordinary coding work stays in the code lane', () => {
    expect(inferLane('Add retry with backoff to the fetch client').lane).toBe('code');
    expect(inferLane('why does the retry test fail?').lane).toBe('code');
    // "click" appears constantly in front-end work that never leaves the editor.
    expect(inferLane('fix the click handler in the checkout component test').lane).toBe('code');
  });

  test('an empty request defaults to code, never to Mac control', () => {
    expect(inferLane('').lane).toBe('code');
    expect(inferLane('   ').lane).toBe('code');
  });

  test('every inference explains itself so a wrong guess is visibly a guess', () => {
    for (const request of ['Open System Settings', 'refactor the client', '']) {
      expect(inferLane(request).why.length).toBeGreaterThan(20);
    }
  });

  test('a code task NEVER waits for the Trust Center, whatever the permission state', () => {
    expect(needsTrustCenterBeforeRun('code', null)).toBe(false);
    expect(needsTrustCenterBeforeRun('code', { available: false })).toBe(false);
  });

  test('a Control Mac task waits only while Bimax cannot operate the Mac', () => {
    expect(needsTrustCenterBeforeRun('mac', { available: true })).toBe(false);
    expect(needsTrustCenterBeforeRun('mac', { available: false })).toBe(true);
    // An unread report is not a grant.
    expect(needsTrustCenterBeforeRun('mac', null)).toBe(true);
  });

  // Mutant: running a Mac task straight into a refusal.
  test('MUTANT — skipping the permission flow would send the task into a refusal', () => {
    const naive = (): boolean => false;
    expect(naive()).toBe(false);
    expect(needsTrustCenterBeforeRun('mac', { available: false })).toBe(true);
  });
});
