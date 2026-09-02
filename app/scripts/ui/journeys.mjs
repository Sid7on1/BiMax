#!/usr/bin/env node
// Phase 5 renderer journeys.
//
//   node app/scripts/ui/journeys.mjs              → run every journey, write the report
//   node app/scripts/ui/journeys.mjs --mutate     → additionally run each grader against a
//                                                   deliberately broken end state and REQUIRE it to fail
//   node app/scripts/ui/journeys.mjs --only=J5    → one journey
//
// The rule from `08_ACCEPTANCE_GATES.md` and `competitive/06_HEAD_TO_HEAD_EVALS.md`: a test counts
// only if it fails when the feature is deliberately broken and grades the real end state. So every
// journey below asserts what the user can now SEE or what the app actually TOLD the main process —
// never that a click was dispatched — and `--mutate` proves each of those assertions is load-bearing.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  APP_DIR,
  WINDOW_SIZES,
  serveRenderer,
  openRenderer,
  feed,
  feedEvent,
  setProject,
  setEngineState,
  bridgeCalls,
  settle,
  visibleText,
  clickByText,
  pressChord,
  shot,
  accessibilityFindings,
  typeInComposer,
  setSupervisor,
  horizontalOverflow,
} from './harness.mjs';
import {
  PROJECT,
  baseFixture,
  grantedTrustReport,
  deniedTrustReport,
  uiSnapshot,
  reviewSnapshot,
  failedReviewSnapshot,
  macToolCall,
  browserToolCall,
  codingToolCall,
  userMessage,
  assistantMessage,
  MALFORMED_FRAMES,
} from './fixtures.mjs';

const args = process.argv.slice(2);
const MUTATE = args.includes('--mutate');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(APP_DIR, 'benchmarks/ui/results/phase5', `run-${RUN_ID}`);
const SHOTS_DIR = path.join(APP_DIR, 'benchmarks/ui/screenshots');

class Grade {
  constructor() {
    this.checks = [];
  }
  expect(name, pass, observed) {
    this.checks.push({ name, pass: !!pass, observed: String(observed).slice(0, 400) });
    return this;
  }
  get passed() {
    return this.checks.every((check) => check.pass);
  }
  get failures() {
    return this.checks.filter((check) => !check.pass);
  }
}

/**
 * Bring the shell to a live project with a task in flight. Shared by most journeys so each one
 * only has to describe what makes IT different.
 */
async function bootTask(page, { review = null, tools = [], snapshot = uiSnapshot() } = {}) {
  await setProject(page, PROJECT);
  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [snapshot]);
  await feedEvent(page, 'message', [userMessage('u1', 'Add retry with backoff to the fetch client')]);
  for (const call of tools) await feedEvent(page, 'tool_call', [call]);
  await feedEvent(page, 'message', [
    assistantMessage('a1', 'Added a shared `retry` helper and wired the three call sites.'),
  ]);
  if (review) await feedEvent(page, 'review_update', [review]);
  await settle(page, 350);
}

// ------------------------------------------------------------------------------------------------
// J1 — start a coding task

async function j1(page, dir) {
  await setProject(page, PROJECT);
  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [uiSnapshot({ sessions: [] })]);
  await settle(page, 300);
  await shot(page, dir, 'j1-empty');

  await typeInComposer(page, 'Add retry with backoff to the fetch client');
  await pressChord(page, 'Enter');
  await settle(page, 300);

  const calls = await bridgeCalls(page);
  const submitted = calls.filter((call) => call.name === 'send' && call.payload?.t === 'input');
  const text = await visibleText(page);
  await shot(page, dir, 'j1-submitted');

  return new Grade()
    .expect(
      'the instruction reached the engine exactly once',
      submitted.length === 1,
      JSON.stringify(submitted.map((s) => s.payload.text)),
    )
    .expect(
      'it reached it verbatim',
      submitted[0]?.payload?.text === 'Add retry with backoff to the fetch client',
      submitted[0]?.payload?.text,
    )
    .expect(
      'the user’s own turn is now in the transcript',
      text.includes('Add retry with backoff to the fetch client'),
      'transcript',
    )
    .expect(
      'no engine vocabulary leaked into the task surface',
      !/\b(NDJSON|MCP|XPC|AXUIElement|executor level)\b/.test(text),
      'plain language',
    );
}

// ------------------------------------------------------------------------------------------------
// J2 — review and verify code changes

async function j2(page, dir) {
  await bootTask(page, { review: reviewSnapshot(), tools: [codingToolCall({ id: 'e1' })] });
  await openLane(page, 'Changes');
  const openText = await visibleText(page);
  await shot(page, dir, 'j2-changes');

  await clickByText(page, 'src/api/client.ts');
  await settle(page, 350);
  const diffText = await visibleText(page);
  await shot(page, dir, 'j2-diff');

  return new Grade()
    .expect(
      'the changed files are listed',
      openText.includes('src/api/client.ts') && openText.includes('src/api/retry.ts'),
      'both files',
    )
    .expect(
      'the verification command and its result are shown',
      openText.includes('npm test -- retry'),
      'verification row',
    )
    .expect('the task state says verified', /Verified/.test(openText), openText.match(/Verified[^\n]*/)?.[0] ?? '')
    .expect('the diff for a chosen file is readable', diffText.includes('retry(3, () => fetch(url))'), 'diff hunk');
}

// ------------------------------------------------------------------------------------------------
// J3 — resume a task after interruption/restart

async function j3(page, dir) {
  await bootTask(page, { review: reviewSnapshot() });
  // The engine dies mid-task, then a new generation restores the thread from the session file.
  await setSupervisor(page, {
    phase: 'exited',
    enteredAt: Date.now(),
    attempt: 2,
    generation: 2,
    message: 'Bimax stopped',
    reason: 'engine exited unexpectedly',
    profile: 'full',
    capabilities: [],
    degradedCapabilities: [],
    interruptedSessionId: '2026-08-09_14-02-11',
  });
  await setEngineState(page, 'exited', 'engine exited unexpectedly');
  await feedEvent(page, 'log', [
    { id: 'd1', level: 'error', text: 'engine exited unexpectedly', timestamp: new Date().toISOString() },
  ]);
  await settle(page, 300);
  const crashedText = await visibleText(page);
  await shot(page, dir, 'j3-crashed');

  await setSupervisor(page, {
    phase: 'ready',
    enteredAt: Date.now(),
    attempt: 2,
    generation: 3,
    message: 'Bimax is ready',
    reason: 'ready',
    profile: 'full',
    capabilities: [],
    degradedCapabilities: [],
  });
  await setEngineState(page, 'ready', '');
  await feed(page, { t: 'ready', protocol: 3 });
  await feedEvent(page, 'session_restore', [
    {
      id: '2026-08-09_14-02-11',
      entries: [
        {
          id: 'u1',
          role: 'user',
          content: 'Add retry with backoff to the fetch client',
          timestamp: new Date().toISOString(),
        },
        {
          id: 't1',
          role: 'tool',
          toolName: 'Edit',
          input: 'src/api/retry.ts',
          output: 'ok',
          status: 'success',
          startTime: new Date().toISOString(),
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Added the retry helper and wired the call sites.',
          timestamp: new Date().toISOString(),
        },
      ],
    },
  ]);
  await feedEvent(page, 'review_update', [reviewSnapshot()]);
  await settle(page, 400);
  const resumedText = await visibleText(page);
  await shot(page, dir, 'j3-resumed');

  return new Grade()
    .expect(
      'the crash is stated in the app, not swallowed',
      /Bimax hit a problem/.test(crashedText),
      crashedText.match(/Bimax hit a problem[^\n]*/)?.[0] ?? '',
    )
    .expect(
      'recovery is offered, not just reported',
      /Try again/.test(crashedText) && /Restore last task/.test(crashedText),
      'recovery actions',
    )
    .expect(
      'the restored thread carries the original request',
      resumedText.includes('Add retry with backoff to the fetch client'),
      'user turn restored',
    )
    .expect(
      'the restored thread carries the agent’s answer',
      resumedText.includes('Added the retry helper'),
      'assistant turn restored',
    )
    .expect(
      'the review evidence survived the restart',
      resumedText.includes('src/api/client.ts') || (await openLane(page, 'Changes')).includes('src/api/client.ts'),
      'review restored',
    )
    .expect(
      'the crash banner is gone once the engine is back',
      !/Bimax hit a problem/.test(resumedText),
      'banner cleared',
    );
}

/** Open an evidence lane by its tab label, revealing the inspector first if it is hidden. */
async function openLane(page, label) {
  const shown = await page.evaluate(() => !!document.querySelector('select[aria-label="Choose evidence lane"]'));
  if (!shown) await pressChord(page, 'j');
  const value = await page.evaluate((wanted) => {
    const select = document.querySelector('select[aria-label="Choose evidence lane"]');
    if (!select) return '';
    return Array.from(select.options).find((option) => option.textContent?.startsWith(wanted))?.value || '';
  }, label);
  if (!value) throw new Error(`Evidence lane not found: ${label}`);
  await page.select('select[aria-label="Choose evidence lane"]', value);
  await settle(page, 300);
  return visibleText(page);
}

// ------------------------------------------------------------------------------------------------
// J4 — permissions denied: diagnose, and keep coding

async function j4(page, dir) {
  await bootTask(page, { review: reviewSnapshot() });
  await pressChord(page, 't', ['Meta', 'Shift']);
  await settle(page, 500);
  const trustText = await visibleText(page);
  await shot(page, dir, 'j4-trust-denied');

  const beforeCoachCalls = (await bridgeCalls(page)).length;
  await clickByText(page, 'Open & drag…', { exact: true });
  await settle(page, 300);
  const calls = (await bridgeCalls(page)).slice(beforeCoachCalls);
  const started = calls.filter((call) => call.name === 'permissionCoach.start');
  const stoppedPrematurely = calls.filter((call) => call.name === 'permissionCoach.stop');

  await page.keyboard.press('Escape');
  await settle(page, 300);
  // Coding must still work with the permission denied — the same submit path as J1.
  await typeInComposer(page, 'Run the retry tests again');
  await pressChord(page, 'Enter');
  await settle(page, 300);
  const afterCalls = await bridgeCalls(page);
  const submitted = afterCalls.filter((call) => call.name === 'send' && call.payload?.t === 'input');
  await shot(page, dir, 'j4-coding-still-works');

  return new Grade()
    .expect(
      'the denied permission is named',
      /Accessibility/.test(trustText) && /Off/.test(trustText),
      'permission row',
    )
    .expect(
      'the blocker is stated in plain language',
      /Finish Computer Use setup/.test(trustText) && /needed/.test(trustText),
      'blocker',
    )
    .expect('coding is shown as unaffected', /Code work stays available/.test(trustText), 'coding stays available')
    .expect(
      'Bimax does not claim it can grant the permission',
      /only you and macOS can grant access/.test(trustText),
      'honest wording',
    )
    .expect(
      'the grant path starts the exact Accessibility drag coach',
      started.length === 1 && started[0].payload === 'accessibility',
      JSON.stringify(started),
    )
    .expect(
      'the drag coach survives the inactive-to-active React transition',
      stoppedPrematurely.length === 0,
      JSON.stringify(stoppedPrematurely),
    )
    .expect(
      'a coding instruction still reaches the engine',
      submitted.some((call) => call.payload.text === 'Run the retry tests again'),
      'coding usable',
    );
}

// ------------------------------------------------------------------------------------------------
// J10 — approve only the exact unsigned local Computer Use service build

async function j10(page, dir) {
  await pressChord(page, 't', ['Meta', 'Shift']);
  await settle(page, 500);
  const before = await visibleText(page);
  await shot(page, dir, 'j10-alpha-approval-needed');

  await clickByText(page, 'Approve this exact build', { exact: true });
  await settle(page, 350);
  const after = await visibleText(page);
  const calls = await bridgeCalls(page);
  const approvals = calls.filter((call) => call.name === 'manualAlpha.approve');
  await shot(page, dir, 'j10-alpha-approved');

  return new Grade()
    .expect('the exact code hash is shown before approval', before.includes('b'.repeat(64)), 'full Code Directory hash')
    .expect(
      'the UI says local approval is not builder identity',
      /does not establish who built it/.test(before),
      'provenance boundary',
    )
    .expect(
      'the UI says local approval cannot bypass macOS',
      /never bypasses macOS permissions/.test(before),
      'TCC boundary',
    )
    .expect(
      'the renderer submits the exact displayed hash',
      approvals.length === 1 && approvals[0].payload === 'b'.repeat(64),
      JSON.stringify(approvals),
    )
    .expect(
      'the approved end state is explicit',
      /Local build approved/.test(after) && /Revoke approval/.test(after),
      'approved exact build',
    );
}

// ------------------------------------------------------------------------------------------------
// J11 — understand the loaded model slots and inspect the provider's real catalogue

async function j11(page, dir) {
  await bootTask(page);
  await clickByText(page, 'kimi-k3', { exact: true });
  await clickByText(page, 'Change model…', { exact: false });
  await settle(page, 350);
  const slots = await visibleText(page);
  await shot(page, dir, 'j11-model-slots');

  await clickByText(page, 'Work model:', { exact: false });
  await settle(page, 250);
  await clickByText(page, 'Browse all 5 models', { exact: true });
  await settle(page, 180);
  const picker = await visibleText(page);
  await shot(page, dir, 'j11-model-picker');

  return new Grade()
    .expect('the model catalogue is a dedicated window', /Model catalogue/.test(slots), 'catalogue title')
    .expect(
      'each job has a plain-language slot',
      /Work/.test(slots) && /Quick/.test(slots) && /Vision/.test(slots) && /Backup/.test(slots),
      'slot names',
    )
    .expect(
      'the active model has a human label and exact id',
      /Kimi K3/.test(slots) && /moonshotai\/kimi-k3/.test(slots),
      'label + id',
    )
    .expect(
      'the active provider and unique served count are visible',
      /NVIDIA NIM/.test(slots) && /4 models served/.test(slots),
      'provider status',
    )
    .expect(
      'the picker separates recommendations from provider truth',
      /Recommended/i.test(picker) && /Not served right now/i.test(picker),
      'served distinction',
    )
    .expect(
      'model capabilities are readable before selection',
      /vision/.test(picker) && /1049k context/.test(picker),
      'capability summary',
    );
}

// ------------------------------------------------------------------------------------------------
// J5 — pause / take over / resume a Mac task

async function j5(page, dir) {
  await bootTask(page, {
    review: reviewSnapshot(),
    tools: [
      macToolCall({ id: 'm1', action: 'open', app: 'Notes', label: 'Notes', ageMs: 12_000 }),
      macToolCall({ id: 'm2', action: 'click', app: 'Notes', label: 'New Note', ageMs: 6_000 }),
    ],
  });
  await openLane(page, 'Mac');
  const runningText = await visibleText(page);
  await shot(page, dir, 'j5-running');

  await clickByText(page, 'Take control');
  await settle(page, 350);
  const pausedText = await visibleText(page);
  const pausedCalls = await bridgeCalls(page);
  await shot(page, dir, 'j5-paused');

  // While paused the provider refuses; that refusal arrives as a normal tool result.
  await feedEvent(page, 'tool_call', [
    macToolCall({
      id: 'm3',
      action: 'type',
      app: 'Notes',
      label: 'Body',
      code: 'computer_use_paused',
      status: 'error',
    }),
  ]);
  await settle(page, 300);
  const refusedText = await visibleText(page);
  await shot(page, dir, 'j5-refused-while-paused');

  await clickByText(page, 'Let Bimax continue');
  await settle(page, 350);
  const resumedText = await visibleText(page);
  const resumedCalls = await bridgeCalls(page);
  await shot(page, dir, 'j5-resumed');

  const setCalls = resumedCalls.filter((call) => call.name === 'takeover.set').map((call) => call.payload.paused);

  return new Grade()
    .expect(
      'the exact target app and window are shown',
      /Notes/.test(runningText) && /Window 88/.test(runningText),
      runningText.match(/Window \d+[^\n]*/)?.[0] ?? '',
    )
    .expect(
      'taking control tells main to pause, once',
      pausedCalls.filter((c) => c.name === 'takeover.set' && c.payload.paused === true).length === 1,
      JSON.stringify(setCalls),
    )
    .expect('the UI now states the user has control', /You have control/.test(pausedText), 'paused state')
    .expect('it promises no input until resume', /will not click or type/.test(pausedText), 'promise')
    .expect(
      'an attempted action while paused is shown as refused, not performed',
      /Refused/.test(refusedText) && /Nothing was sent to your Mac/.test(refusedText),
      'refusal row',
    )
    .expect('resuming is explicit and reaches main', setCalls.join(',') === 'true,false', JSON.stringify(setCalls))
    .expect(
      'the paused state is cleared only after main confirms',
      !/You have control/.test(resumedText),
      'resumed state',
    );
}

// ------------------------------------------------------------------------------------------------
// J6 — understand the live target without Diagnostics

async function j6(page, dir) {
  await bootTask(page, {
    review: reviewSnapshot(),
    tools: [
      macToolCall({ id: 'm1', action: 'observe', app: 'Notes', label: 'Notes', ageMs: 4_000 }),
      macToolCall({ id: 'm2', action: 'click', app: 'Notes', label: 'Save', ageMs: 2_000 }),
    ],
  });
  await openLane(page, 'Mac');
  const freshText = await visibleText(page);
  await shot(page, dir, 'j6-live-target');

  // Now the same session with evidence past the freshness budget.
  await feedEvent(page, 'clear', []);
  await bootTask(page, {
    review: reviewSnapshot(),
    tools: [macToolCall({ id: 'm9', action: 'click', app: 'Notes', label: 'Save', ageMs: 95_000 })],
  });
  await openLane(page, 'Mac');
  const staleText = await visibleText(page);
  await shot(page, dir, 'j6-stale-evidence');

  return new Grade()
    .expect('the app being operated is named', /Notes/.test(freshText), 'app')
    .expect('the exact window is named', /Window 88/.test(freshText), 'window')
    .expect(
      'the age of the evidence is stated',
      /Last look .*(just now|s ago|m ago)/.test(freshText),
      freshText.match(/Last look[^\n]*/)?.[0] ?? '',
    )
    .expect(
      'the latest action is readable without jargon',
      /Clicked Save/.test(freshText),
      freshText.match(/Clicked[^\n]*/)?.[0] ?? '',
    )
    .expect('the confirmation is stated, not implied', /Confirmed/.test(freshText), 'postcondition surfaced')
    .expect(
      'stale evidence is called stale',
      /Last look[^\n]*(m ago)/.test(staleText) && /look again before acting/.test(staleText),
      staleText.match(/Last look[^\n]*/)?.[0] ?? '',
    )
    .expect(
      'no plumbing vocabulary is visible at rest',
      !/\b(AXUIElement|CGEvent|ScreenCaptureKit|snapshotId|frameId)\b/.test(freshText),
      'plain language',
    );
}

// ------------------------------------------------------------------------------------------------
// J7 — inspect the final receipt

async function j7(page, dir) {
  await bootTask(page, {
    review: reviewSnapshot(),
    tools: [
      codingToolCall({ id: 'e1' }),
      macToolCall({ id: 'm1', action: 'click', app: 'Notes', label: 'Save', ageMs: 3_000 }),
      browserToolCall({ id: 'b1' }),
    ],
  });
  await openLane(page, 'Receipt');
  const provenText = await visibleText(page);
  await shot(page, dir, 'j7-receipt-proven');

  // Same task, but the check failed and one Mac action never confirmed its end state.
  await feedEvent(page, 'clear', []);
  await bootTask(page, {
    review: failedReviewSnapshot(),
    tools: [
      macToolCall({
        id: 'm1',
        action: 'click',
        app: 'Notes',
        label: 'Save',
        ageMs: 3_000,
        postcondition: { query: 'Reminder saved', matched: false },
      }),
    ],
  });
  await openLane(page, 'Receipt');
  const unprovenText = await visibleText(page);
  await shot(page, dir, 'j7-receipt-unproven');

  return new Grade()
    .expect('the code claim links to its changed files', /src\/api\/client\.ts/.test(provenText), 'code evidence')
    .expect(
      'the code claim links to the check that proves it',
      /npm test -- retry/.test(provenText) && /passed/.test(provenText),
      'verification evidence',
    )
    .expect('the Mac claim links to its action', /Clicked Save/.test(provenText), 'mac evidence')
    .expect('a fully evidenced task says so', /Everything Bimax claimed is proven/.test(provenText), 'complete verdict')
    .expect(
      'a failed check makes the receipt unproven',
      /Some claims are not proven/.test(unprovenText),
      'incomplete verdict',
    )
    .expect(
      'the failed check is named as the gap',
      /check(s)? failed/.test(unprovenText),
      unprovenText.match(/check[^\n]*failed[^\n]*/)?.[0] ?? '',
    )
    .expect(
      'an unconfirmed Mac action is named as a gap',
      /(no action confirmed its expected end state|did not confirm an end state)/.test(unprovenText),
      unprovenText.match(/(no action confirmed[^\n]*|did not confirm[^\n]*)/)?.[0] ?? '',
    );
}

// ------------------------------------------------------------------------------------------------
// J8 — infer the lane, then respect a user correction before execution

async function j8(page, dir) {
  await setProject(page, PROJECT);
  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [uiSnapshot({ sessions: [] })]);
  await settle(page, 300);

  const request = 'Open System Settings and click the Privacy & Security section';
  await typeInComposer(page, request);
  const inferred = await page.evaluate(
    () => document.querySelector('[data-bimax-pill="lane-chip"]')?.textContent?.trim() ?? '',
  );
  await shot(page, dir, 'j8-lane-inferred');

  // Correct the inference to Code. On this denied fixture, any loss of that explicit correction
  // would open Trust Center instead of sending the instruction, so the end state proves it stuck.
  await clickByText(page, 'Control Mac', { exact: true });
  await clickByText(page, 'Code');
  const corrected = await page.evaluate(
    () => document.querySelector('[data-bimax-pill="lane-chip"]')?.textContent?.trim() ?? '',
  );
  await pressChord(page, 'Enter');
  await settle(page, 350);
  const calls = await bridgeCalls(page);
  const text = await visibleText(page);
  await shot(page, dir, 'j8-lane-corrected-submitted');

  const submitted = calls.filter((call) => call.name === 'send' && call.payload?.t === 'input');
  return new Grade()
    .expect('the request is visibly inferred as Control Mac', inferred.includes('Control Mac'), inferred)
    .expect('the user can visibly correct it to Code', corrected === 'Code', corrected)
    .expect(
      'the corrected lane is respected at execution',
      submitted.length === 1 && submitted[0]?.payload?.text === request,
      JSON.stringify(submitted),
    )
    .expect(
      'a corrected Code task does not open the permission flow',
      !/Before Bimax controls your Mac/.test(text),
      'Trust Center stayed closed',
    );
}

// ------------------------------------------------------------------------------------------------
// J9 — first Control Mac task waits for permissions and resumes exactly once

async function j9(page, dir) {
  await setProject(page, PROJECT);
  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [uiSnapshot({ sessions: [] })]);
  await settle(page, 300);

  const macRequest = 'Open System Settings and click Privacy & Security';
  await typeInComposer(page, macRequest);
  await pressChord(page, 'Enter');
  await settle(page, 450);
  const gatedText = await visibleText(page);
  const gatedCalls = await bridgeCalls(page);
  await shot(page, dir, 'j9-first-control-mac-gated');

  // Declining/closing leaves the instruction visible and unsent. Coding remains independent.
  await page.keyboard.press('Escape');
  await settle(page, 250);
  const waitingText = await visibleText(page);
  const codeRequest = 'Add a test for the permission model';
  await typeInComposer(page, codeRequest);
  await pressChord(page, 'Enter');
  await settle(page, 300);

  // Simulate the person returning from System Settings. The sheet and close handler each re-read
  // the real bridge report; only the fresh available report releases the held instruction.
  await page.evaluate((report) => {
    window.__bimaxHarness.fixture.trustReport = report;
  }, grantedTrustReport());
  await clickByText(page, 'Review permissions', { exact: true });
  await settle(page, 350);
  await clickByText(page, 'Checked', { exact: false });
  await settle(page, 350);
  const readyText = await visibleText(page);
  await page.keyboard.press('Escape');
  await settle(page, 450);
  const calls = await bridgeCalls(page);
  const submitted = calls.filter((call) => call.name === 'send' && call.payload?.t === 'input');
  await shot(page, dir, 'j9-waiting-task-released');

  return new Grade()
    .expect(
      'the first Mac task opens contextual permission guidance',
      /Trust Center/.test(gatedText) && gatedText.includes(macRequest),
      'waiting task named',
    )
    .expect(
      'the blocked Mac task is not sent',
      !gatedCalls.some((call) => call.name === 'send' && call.payload?.t === 'input'),
      JSON.stringify(gatedCalls.filter((call) => call.name === 'send')),
    )
    .expect(
      'closing without grants keeps the task visible',
      waitingText.includes(`Waiting to run “${macRequest}”`),
      'waiting banner',
    )
    .expect(
      'a Code task still runs while the Mac task waits',
      submitted.some((call) => call.payload?.text === codeRequest),
      JSON.stringify(submitted),
    )
    .expect(
      'a fresh granted report visibly makes Mac control ready',
      /Control Mac is ready/.test(readyText),
      'ready after re-check',
    )
    .expect(
      'the original Mac task resumes exactly once after the grant',
      submitted.filter((call) => call.payload?.text === macRequest).length === 1,
      JSON.stringify(submitted),
    );
}

// J12 — an incompatible Computer Use route opens the dedicated model preflight and cannot run

async function j12(page, dir) {
  await setProject(page, PROJECT);
  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [uiSnapshot({ sessions: [] })]);
  await settle(page, 250);

  // The explicit phrase makes lane selection deterministic, so this journey measures model
  // compatibility rather than duplicating J8's lane-inference coverage.
  const request = 'Control my Mac: open Calculator and enter 7 × 8';
  await typeInComposer(page, request);
  await pressChord(page, 'Enter');
  await settle(page, 450);
  const blocked = await visibleText(page);
  const before = await bridgeCalls(page);
  await shot(page, dir, 'j12-model-preflight-blocked');

  await clickByText(page, 'Vision model:', { exact: false });
  await settle(page, 200);
  await clickByText(page, 'Gemini 3 Flash', { exact: false });
  await settle(page, 350);
  const ready = await visibleText(page);
  await clickByText(page, 'Continue to permissions', { exact: true });
  await settle(page, 300);
  const after = await bridgeCalls(page);
  const submitted = after.filter(
    (call) => call.name === 'send' && call.payload?.t === 'input' && call.payload?.text === request,
  );
  await shot(page, dir, 'j12-model-preflight-ready');

  return new Grade()
    .expect(
      'an incompatible route opens a dedicated model window',
      /Models for Control Mac/.test(blocked),
      'preflight title',
    )
    .expect(
      'the missing screenshot route is explained',
      /Vision model for screenshot grounding|supports image input/.test(blocked),
      'vision requirement',
    )
    .expect(
      'the task does not reach the engine before a compatible route exists',
      !before.some((call) => call.name === 'send' && call.payload?.t === 'input'),
      JSON.stringify(before.filter((call) => call.name === 'send')),
    )
    .expect(
      'the selected work and vision roles are shown as ready',
      /Control Mac model route is ready/.test(ready),
      'ready route',
    )
    .expect(
      'the held task resumes exactly once after model preflight',
      submitted.length === 1,
      JSON.stringify(submitted),
    );
}

// ------------------------------------------------------------------------------------------------
// Resilience: malformed / stale protocol frames, and the empty/loading/error/crash states

async function jResilience(page, dir, pageErrors) {
  await setProject(page, PROJECT);
  await settle(page, 250);
  const loadingText = await visibleText(page);
  await shot(page, dir, 'r1-loading');

  await feed(page, { t: 'ready', protocol: 3 });
  await setEngineState(page, 'ready', '');
  await feedEvent(page, 'ui_snapshot', [uiSnapshot({ sessions: [] })]);
  await settle(page, 250);
  const emptyText = await visibleText(page);
  await shot(page, dir, 'r2-empty');

  const before = pageErrors.length;
  for (const frame of MALFORMED_FRAMES) await feed(page, frame);
  await settle(page, 400);
  const afterMalformed = pageErrors.length;
  const malformedText = await visibleText(page);
  await shot(page, dir, 'r3-malformed');

  // An engine on an incompatible protocol major must be visible, not silently tolerated.
  await feed(page, { t: 'ready', protocol: 99 });
  await settle(page, 250);
  const mismatchText = await visibleText(page);
  await shot(page, dir, 'r4-protocol-mismatch');

  await setEngineState(page, 'exited', 'engine crashed');
  await feedEvent(page, 'log', [
    { id: 'x1', level: 'error', text: 'engine crashed', timestamp: new Date().toISOString() },
  ]);
  await settle(page, 250);
  await shot(page, dir, 'r5-crashed');

  return new Grade()
    .expect(
      'an unopened task shows a real empty state, not a blank pane',
      emptyText.trim().length > 40,
      `${emptyText.trim().length} chars`,
    )
    .expect(
      'a project that has not reported yet renders without a blank window',
      loadingText.trim().length > 20,
      `${loadingText.trim().length} chars`,
    )
    .expect('no malformed or unknown frame threw', afterMalformed === before, pageErrors.slice(before).join(' | '))
    .expect('the shell is still usable after malformed frames', malformedText.includes('Bimax'), 'shell alive')
    .expect(
      'an unparseable Mac result does not fabricate a target',
      !/Window undefined|pid undefined|NaN/.test(malformedText),
      'no fabricated facts',
    )
    .expect('an incompatible protocol version is stated', /needs an update/i.test(mismatchText), 'mismatch banner');
}

// ------------------------------------------------------------------------------------------------
// Keyboard + accessibility, at every supported window size

async function jAccess(page, dir, size) {
  await bootTask(page, {
    review: reviewSnapshot(),
    tools: [macToolCall({ id: 'm1', ageMs: 3_000 }), browserToolCall({ id: 'b1' })],
  });

  const grade = new Grade();
  const overflow = await horizontalOverflow(page);
  grade.expect(`no horizontal overflow at ${size.name} (${size.width}×${size.height})`, overflow <= 1, `${overflow}px`);

  // Every primary surface, keyboard only.
  await pressChord(page, 'j');
  const inspectorHidden = await visibleText(page);
  await pressChord(page, 'j');
  const inspectorShown = await visibleText(page);
  grade.expect('⌘J toggles the inspector', inspectorHidden !== inspectorShown, 'toggled');

  await pressChord(page, 'b');
  const sidebarHidden = await visibleText(page);
  await pressChord(page, 'b');
  grade.expect('⌘B toggles the task list', !sidebarHidden.includes('Earlier tasks'), 'sidebar hidden');

  await pressChord(page, 'k');
  const paletteOpen = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Search BiMAX…"]');
    return !!input && input.getBoundingClientRect().width > 0;
  });
  grade.expect('⌘K opens the palette', paletteOpen, String(paletteOpen));
  await page.keyboard.press('Escape');
  await settle(page);

  await pressChord(page, 't', ['Meta', 'Shift']);
  await settle(page, 400);
  const trust = await visibleText(page);
  grade.expect('⌘⇧T opens the Trust Center', /Trust Center/.test(trust), 'trust');
  await page.keyboard.press('Escape');
  await settle(page, 250);

  await pressChord(page, 'p', ['Meta', 'Shift']);
  await settle(page, 300);
  const paused = await visibleText(page);
  grade.expect('⌘⇧P takes control of the Mac', /You have control/.test(paused), 'paused');
  await pressChord(page, 'p', ['Meta', 'Shift']);
  await settle(page, 300);

  await pressChord(page, 't');
  await settle(page, 400);
  const terminal = await visibleText(page);
  grade.expect('⌘T opens the terminal drawer', /this project’s shell/.test(terminal), 'terminal drawer');
  await pressChord(page, 't');
  await settle(page, 250);

  const findings = await accessibilityFindings(page);
  grade.expect(
    'every control, image and tab is named and reachable',
    findings.length === 0,
    findings.join(' | ') || 'none',
  );

  await shot(page, dir, `a11y-${size.name}`);
  return grade;
}

// ------------------------------------------------------------------------------------------------
// Interaction cost.
//
// The Phase 5 constraint is "avoid polling, screenshot churn, unnecessary rerenders and permanent
// heavy panels" — so this MEASURES rather than asserts a guessed budget. It reports the numbers into
// the run report and only fails on a bound wide enough that crossing it means something structural
// broke (an unbounded re-render, a runaway timer), not that the machine was busy.

async function jPerformance(page, dir) {
  await bootTask(page, { review: reviewSnapshot() });

  // A long Mac session: 200 provider results folded into the live target and the timeline.
  const started = Date.now();
  for (let index = 0; index < 200; index++) {
    await feedEvent(page, 'tool_call', [macToolCall({ id: `p${index}`, ageMs: 1_000 + index })]);
  }
  await settle(page, 600);
  const foldMs = Date.now() - started;
  await openLane(page, 'Mac');

  const interaction = await page.evaluate(async () => {
    const timings = [];
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter(
      (tab) => tab.getAttribute('aria-disabled') !== 'true',
    );
    for (let round = 0; round < 12; round++) {
      const tab = tabs[round % tabs.length];
      const start = performance.now();
      tab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    return {
      p50: timings[Math.floor(timings.length * 0.5)],
      p95: timings[Math.floor(timings.length * 0.95)] ?? timings[timings.length - 1],
      max: timings[timings.length - 1],
      samples: timings.length,
    };
  });

  // Nothing may be running on a timer once the task is idle.
  const idleWork = await page.evaluate(async () => {
    let frames = 0;
    const tick = () => {
      frames++;
      requestAnimationFrame(tick);
    };
    // Count how many animation frames the page itself schedules over a quiet second: a page with no
    // running animation still gets frames from this probe, so what matters is that nothing else is
    // mutating the DOM. Record the DOM mutation count instead.
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    requestAnimationFrame(tick);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    observer.disconnect();
    return { framesProbed: frames, domMutationsWhileIdle: mutations };
  });

  await shot(page, dir, 'perf-long-session');

  const grade = new Grade()
    .expect('200 Mac results fold in under 8s', foldMs < 8_000, `${foldMs}ms`)
    .expect(
      'switching evidence lanes stays under 150ms at p95',
      interaction.p95 < 150,
      `p50 ${interaction.p50.toFixed(1)}ms · p95 ${interaction.p95.toFixed(1)}ms · max ${interaction.max.toFixed(1)}ms`,
    )
    .expect(
      'an idle task does not keep mutating the DOM',
      idleWork.domMutationsWhileIdle < 20,
      `${idleWork.domMutationsWhileIdle} mutations in 1s`,
    );
  grade.measurements = { foldMs, interaction, idleWork };
  return grade;
}

// ------------------------------------------------------------------------------------------------
// Screenshot regression at every supported window size

async function screenshotMatrix(base, fixtureFactory) {
  const captured = [];
  for (const size of WINDOW_SIZES) {
    const { browser, page } = await openRenderer({ base, fixture: fixtureFactory(), size });
    await bootTask(page, {
      review: reviewSnapshot(),
      tools: [macToolCall({ id: 'm1', ageMs: 3_000 }), codingToolCall({ id: 'e1' })],
    });
    await shot(page, SHOTS_DIR, `task-${size.name}`);
    captured.push(`task-${size.name}.png`);
    await openLane(page, 'Mac');
    await shot(page, SHOTS_DIR, `live-target-${size.name}`);
    captured.push(`live-target-${size.name}.png`);
    await openLane(page, 'Receipt');
    await shot(page, SHOTS_DIR, `receipt-${size.name}`);
    captured.push(`receipt-${size.name}.png`);
    await pressChord(page, 't', ['Meta', 'Shift']);
    await settle(page, 450);
    await shot(page, SHOTS_DIR, `trust-center-${size.name}`);
    captured.push(`trust-center-${size.name}.png`);
    await browser.close();
  }
  return captured;
}

// ------------------------------------------------------------------------------------------------
// Mutations — each one breaks the END STATE a journey grades, and the grader MUST fail.

const MUTATIONS = [
  {
    id: 'M1-pause-not-honoured',
    journey: 'J5',
    describe: 'main never applies the pause (the latch is decorative)',
    // The stand-in stops applying the request, exactly as a broken authority would.
    async run(page, dir) {
      await page.evaluate(() => {
        const H = window.__bimaxHarness;
        const original = window.bimax.takeover.set;
        window.bimax.takeover.set = async (request) => {
          H.calls.push({ name: 'takeover.set', payload: request, at: Date.now() });
          return H.fixture.takeover; // never transitions
        };
        return original;
      });
      return j5(page, dir);
    },
  },
  {
    id: 'M2-stale-evidence-looks-fresh',
    journey: 'J6',
    describe: 'a two-minute-old observation is presented as the current one',
    async run(page, dir) {
      await bootTask(page, {
        review: reviewSnapshot(),
        tools: [macToolCall({ id: 'm9', action: 'click', app: 'Notes', label: 'Save', ageMs: 120_000 })],
      });
      const text = await openLane(page, 'Mac');
      await shot(page, dir, 'mut-stale');
      // The J6 freshness assertion, applied to stale evidence: it must NOT read as fresh.
      return new Grade().expect(
        'stale evidence reads as fresh',
        /Last look (just now|\ds ago)/.test(text),
        text.match(/Last look[^\n]*/)?.[0] ?? '',
      );
    },
  },
  {
    id: 'M3-unproven-claim-looks-proven',
    journey: 'J7',
    describe: 'a failed check and an unconfirmed action still produce a complete receipt',
    async run(page, dir) {
      await bootTask(page, {
        review: failedReviewSnapshot(),
        tools: [macToolCall({ id: 'm1', ageMs: 3_000, postcondition: { query: 'Reminder saved', matched: false } })],
      });
      const text = await openLane(page, 'Receipt');
      await shot(page, dir, 'mut-receipt');
      return new Grade().expect(
        'a task with a failed check claims everything is proven',
        /Everything Bimax claimed is proven/.test(text),
        'verdict',
      );
    },
  },
  {
    id: 'M4-denied-permission-blocks-coding',
    journey: 'J4',
    describe: 'the app reports coding as unavailable when a macOS permission is denied',
    async run(page, dir) {
      await bootTask(page, { review: reviewSnapshot() });
      await pressChord(page, 't', ['Meta', 'Shift']);
      await settle(page, 500);
      const text = await visibleText(page);
      await shot(page, dir, 'mut-permissions');
      return new Grade().expect(
        'coding is reported unavailable under a denied permission',
        /Coding[\s\S]{0,80}Unavailable/.test(text),
        text.match(/Coding[\s\S]{0,60}/)?.[0] ?? '',
      );
    },
  },
  {
    id: 'M5-coach-destroyed-on-activation',
    journey: 'J4',
    describe: 'the permission coach is stopped immediately after main reports that it started',
    async run(page, dir) {
      await bootTask(page, { review: reviewSnapshot() });
      await pressChord(page, 't', ['Meta', 'Shift']);
      await settle(page, 500);
      await page.evaluate(() => {
        const original = window.bimax.permissionCoach.start;
        window.bimax.permissionCoach.start = async (which) => {
          const started = await original(which);
          if (started) await window.bimax.permissionCoach.stop();
          return started;
        };
      });
      const before = (await bridgeCalls(page)).length;
      await clickByText(page, 'Open & drag…', { exact: true });
      await settle(page, 300);
      const calls = (await bridgeCalls(page)).slice(before);
      await shot(page, dir, 'mut-coach-destroyed');
      return new Grade().expect(
        'an activated drag coach remains alive',
        !calls.some((call) => call.name === 'permissionCoach.stop'),
        JSON.stringify(calls.filter((call) => call.name.startsWith('permissionCoach.'))),
      );
    },
  },
];

// ------------------------------------------------------------------------------------------------

const JOURNEYS = [
  { id: 'J1', name: 'Start a coding task', run: j1, fixture: () => baseFixture() },
  { id: 'J2', name: 'Review and verify code changes', run: j2, fixture: () => baseFixture() },
  { id: 'J3', name: 'Resume a task after a crash', run: j3, fixture: () => baseFixture() },
  {
    id: 'J4',
    name: 'Diagnose Mac permissions while coding stays usable',
    run: j4,
    fixture: () => baseFixture({ trustReport: deniedTrustReport() }),
  },
  { id: 'J5', name: 'Pause, take over and resume a Mac task', run: j5, fixture: () => baseFixture() },
  { id: 'J6', name: 'Understand the live target without Diagnostics', run: j6, fixture: () => baseFixture() },
  { id: 'J7', name: 'Inspect the final receipt', run: j7, fixture: () => baseFixture() },
  {
    id: 'J8',
    name: 'Infer and correct the task lane',
    run: j8,
    fixture: () => baseFixture({ trustReport: deniedTrustReport() }),
  },
  {
    id: 'J9',
    name: 'Gate and resume the first Control Mac task',
    run: j9,
    fixture: () => baseFixture({ trustReport: deniedTrustReport() }),
  },
  {
    id: 'J10',
    name: 'Approve an exact unsigned local Computer Use build',
    run: j10,
    fixture: () =>
      baseFixture({
        trustReport: deniedTrustReport(),
        manualAlphaStatus: {
          state: 'approval-required',
          ready: false,
          canApprove: true,
          serviceVersion: 'fixture-1',
          codeDirectoryHash: 'b'.repeat(64),
          detail: 'This local Computer Use service build needs exact-hash approval.',
        },
      }),
  },
  { id: 'J11', name: 'Inspect the loaded model slots and provider catalogue', run: j11, fixture: () => baseFixture() },
  {
    id: 'J12',
    name: 'Gate Control Mac on a compatible model route',
    run: j12,
    fixture: () => {
      const fixture = baseFixture();
      fixture.config.visionModel = '';
      return fixture;
    },
  },
];

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
  const { server, base } = await serveRenderer();
  const results = [];
  const started = new Date().toISOString();

  try {
    for (const journey of JOURNEYS) {
      if (ONLY && journey.id !== ONLY) continue;
      const { browser, page, pageErrors } = await openRenderer({ base, fixture: journey.fixture() });
      let grade;
      let error = null;
      try {
        grade = await journey.run(page, RESULTS_DIR);
      } catch (failure) {
        error = String(failure?.stack || failure);
        grade = new Grade().expect('journey completed', false, error);
      }
      const findings = await accessibilityFindings(page).catch(() => []);
      results.push({
        id: journey.id,
        name: journey.name,
        outcome: grade.passed && pageErrors.length === 0 ? 'pass' : 'fail',
        checks: grade.checks,
        pageErrors,
        accessibilityFindings: findings,
        error,
      });
      console.log(`${grade.passed && pageErrors.length === 0 ? 'PASS' : 'FAIL'} ${journey.id} ${journey.name}`);
      for (const failed of grade.failures) console.log(`   ✗ ${failed.name} — observed: ${failed.observed}`);
      for (const pageError of pageErrors) console.log(`   ✗ renderer error: ${pageError}`);
      await browser.close();
    }

    if (!ONLY) {
      // Resilience
      const resilience = await openRenderer({ base, fixture: baseFixture() });
      const rGrade = await jResilience(resilience.page, RESULTS_DIR, resilience.pageErrors);
      results.push({
        id: 'R1',
        name: 'Loading, empty, malformed, mismatched and crashed states',
        outcome: rGrade.passed ? 'pass' : 'fail',
        checks: rGrade.checks,
        pageErrors: resilience.pageErrors,
        accessibilityFindings: [],
        error: null,
      });
      console.log(`${rGrade.passed ? 'PASS' : 'FAIL'} R1 resilience`);
      for (const failed of rGrade.failures) console.log(`   ✗ ${failed.name} — observed: ${failed.observed}`);
      await resilience.browser.close();

      // Interaction cost, measured
      const perf = await openRenderer({ base, fixture: baseFixture() });
      const perfGrade = await jPerformance(perf.page, RESULTS_DIR);
      results.push({
        id: 'P1',
        name: 'Interaction cost on a long Mac session',
        outcome: perfGrade.passed && perf.pageErrors.length === 0 ? 'pass' : 'fail',
        checks: perfGrade.checks,
        pageErrors: perf.pageErrors,
        accessibilityFindings: [],
        measurements: perfGrade.measurements,
        error: null,
      });
      console.log(`${perfGrade.passed ? 'PASS' : 'FAIL'} P1 interaction cost`);
      for (const failed of perfGrade.failures) console.log(`   ✗ ${failed.name} — observed: ${failed.observed}`);
      for (const check of perfGrade.checks) console.log(`   · ${check.name}: ${check.observed}`);
      await perf.browser.close();

      // Keyboard + accessibility at each supported size
      for (const size of WINDOW_SIZES) {
        const run = await openRenderer({ base, fixture: baseFixture(), size });
        const grade = await jAccess(run.page, RESULTS_DIR, size);
        results.push({
          id: `A-${size.name}`,
          name: `Keyboard and accessibility at ${size.width}×${size.height}`,
          outcome: grade.passed && run.pageErrors.length === 0 ? 'pass' : 'fail',
          checks: grade.checks,
          pageErrors: run.pageErrors,
          accessibilityFindings: [],
          error: null,
        });
        console.log(`${grade.passed && run.pageErrors.length === 0 ? 'PASS' : 'FAIL'} A-${size.name}`);
        for (const failed of grade.failures) console.log(`   ✗ ${failed.name} — observed: ${failed.observed}`);
        await run.browser.close();
      }
    }

    const screenshots = ONLY ? [] : await screenshotMatrix(base, () => baseFixture());

    // Mutations: each grader must FAIL against its broken end state.
    const mutations = [];
    if (MUTATE) {
      for (const mutation of MUTATIONS) {
        const fixture =
          mutation.id === 'M4-denied-permission-blocks-coding'
            ? baseFixture({ trustReport: deniedTrustReport() })
            : baseFixture();
        const run = await openRenderer({ base, fixture });
        let grade;
        try {
          grade = await mutation.run(run.page, RESULTS_DIR);
        } catch (failure) {
          grade = new Grade().expect('mutation ran', false, String(failure));
        }
        // A mutation is only useful if the grader REJECTS it.
        const detected = !grade.passed;
        mutations.push({
          id: mutation.id,
          journey: mutation.journey,
          describe: mutation.describe,
          detected,
          checks: grade.checks,
        });
        console.log(
          `${detected ? 'PASS' : 'FAIL'} mutation ${mutation.id} (${detected ? 'rejected as required' : 'SLIPPED THROUGH'})`,
        );
        await run.browser.close();
      }
    }

    const report = {
      schema_version: '1.0',
      phase: 5,
      run_id: RUN_ID,
      started_at: started,
      ended_at: new Date().toISOString(),
      product: 'bimax-desktop-renderer',
      grader: {
        version: '1.0',
        mutation_pass_ran: MUTATE,
        mutant_checks_passed: MUTATE ? mutations.every((m) => m.detected) : null,
      },
      window_sizes: WINDOW_SIZES,
      journeys: results,
      mutations,
      screenshots,
      totals: {
        journeys: results.length,
        passed: results.filter((r) => r.outcome === 'pass').length,
        failed: results.filter((r) => r.outcome === 'fail').length,
      },
    };
    writeFileSync(path.join(RESULTS_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport: ${path.relative(process.cwd(), path.join(RESULTS_DIR, 'report.json'))}`);
    console.log(`screenshots: ${path.relative(process.cwd(), SHOTS_DIR)}`);
    console.log(`journeys ${report.totals.passed}/${report.totals.journeys} passed`);

    const ok = report.totals.failed === 0 && (!MUTATE || mutations.every((m) => m.detected));
    process.exitCode = ok ? 0 : 1;
  } finally {
    server.close();
  }
}

await main();
