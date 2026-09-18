import { globalCommandRegistry } from './registry';
import { getSelfModel } from '../../mind/self.model';
import { getHabitMiner } from '../../mind/habit.compiler';
import { getUserModel } from '../../mind/user.model';
import { getDrivesEngine } from '../../mind/drives.engine';
import { getEpistemicLedger } from '../../mind/epistemic.ledger';
import { getDreamEngine } from '../../mind/dream.engine';
import { getDogfoodEngine } from '../../mind/dogfood.engine';
import { getEventLedger } from '../../mind/event.ledger';
import { getTaintTracker } from '../../mind/taint';
import { rebuildSelfModel } from '../../mind/views';
import { listEpisodes, loadEpisode } from '../../mind/episode.recorder';
import { replayEpisode } from '../../mind/replay.harness';
import { MutationEngine } from '../../mind/mutation.engine';
import { getExemplarStore } from '../../mind/exemplar.store';
import { getPolicyArms, ARM_IDS, ArmId } from '../../mind/policy.arms';
import { foldRuns } from '../../core/pipeline.journal';
import { getFileClaims } from '../../core/file.claims';

/**
 * The Mind layer's command surface — the AGI-direction features, inspectable from the TUI:
 *   /self    — everything the agent knows about ITSELF (and you)
 *   /drives  — homeostatic health signals + on-demand measurement
 *   /dream   — run/inspect offline consolidation + self-play cycles
 *   /habits  — mined procedural memory, compile to recipes
 *   /dogfood — use the built artifact as a user; file bug reports
 */

globalCommandRegistry.register({
  name: '/self',
  aliases: ['/mind'],
  category: 'Code & Intelligence',
  description: 'Self-knowledge — learned failure rates, calibration, habits, user model, drives',
  execute: async () => {
    const dreams = getDreamEngine().journal();
    const last = dreams[dreams.length - 1];
    const lines = [
      '## Self-model — what BiMax knows about itself',
      '',
      '**Error surface (learned from own telemetry)**',
      ...getSelfModel().report(),
      '',
      '**Calibration (claims vs. hard evidence)**',
      ...getEpistemicLedger().report(),
      '',
      '**Habits (procedural memory)**',
      ...getHabitMiner().report(),
      '',
      '**User model (theory of mind)**',
      ...getUserModel().report(),
      '',
      '**Drives (homeostasis)**',
      ...getDrivesEngine().report(),
      '',
      '**Dreams**',
      last
        ? `- Last cycle ${last.at}: ${last.deviations.length} deviation(s), ${last.lessons.length} lesson(s)${last.practice ? `, practice ${last.practice.graded ? 'PASSED' : last.practice.attempted ? 'failed' : 'skipped'}` : ''} · ${dreams.length} cycle(s) total`
        : '- No dream cycles yet — run /dream.',
      '',
      '_Weak spots, calibration gaps, habits, user prefs and drive deviations are injected into the system prompt automatically — the agent routes around what you see here._',
    ];
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/drives',
  category: 'Code & Intelligence',
  description: 'Homeostatic drives — check codebase setpoints (tests, types, debt, hygiene)',
  execute: async (args, context) => {
    const engine = getDrivesEngine();
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'check' || sub === 'quick') {
      const quick = sub === 'quick' || (args[1] || '').toLowerCase() === 'quick';
      context.addSystemMessage('info', quick ? '🫀 Measuring drives (quick — skips builds/tests)…' : '🫀 Measuring drives (full — runs typecheck/build/tests sequentially, this can take minutes)…');
      await engine.check({ quick });
      const dev = engine.deviations();
      const header = dev.length === 0 ? '✓ All measured drives at setpoint.' : `✗ ${dev.length} drive(s) deviating.`;
      return { type: 'message', level: dev.length === 0 ? 'success' : 'error', content: [`## Drives\n${header}`, '', ...engine.report()].join('\n') };
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = args[1];
      if (!id || !engine.setEnabled(id, sub === 'enable')) {
        return { type: 'message', level: 'error', content: `Usage: /drives ${sub} <id> — ids: ${engine.list().map(d => d.id).join(', ')}` };
      }
      return { type: 'message', level: 'success', content: `Drive \`${id}\` ${sub}d.` };
    }

    const lines = [
      '## Drives (homeostasis)',
      '',
      ...engine.report(),
      '',
      '_`/drives check` measures everything (runs builds/tests) · `/drives quick` cheap signals only · `/drives enable|disable <id>`. Deviations are injected into the agent prompt and feed /dream practice._',
    ];
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/dream',
  category: 'Code & Intelligence',
  description: 'Dream cycle — consolidate lessons, compile habits, self-play practice in a worktree',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'history') {
      const journal = getDreamEngine().journal().slice(-10).reverse();
      if (journal.length === 0) return { type: 'message', level: 'info', content: 'No dream cycles recorded yet. Run `/dream` (or `/dream deep` to include build/test measurement).' };
      const lines = ['## Dream journal (latest first)', ''];
      const irt = new MutationEngine().irt();
      if (irt.n > 0) {
        const frontier = Object.entries(irt.b).sort((a, b) => Math.abs((1 / (1 + Math.exp(-(irt.theta - a[1])))) - 0.65) - Math.abs((1 / (1 + Math.exp(-(irt.theta - b[1])))) - 0.65))[0];
        lines.push(`**Curriculum:** skill θ=${irt.theta.toFixed(2)} over ${irt.n} gradeable episode(s) · ${irt.active ? `IRT ACTIVE — frontier class \`${frontier[0]}\`` : `Beta frontier (IRT takes over at ${100})`}`, '');
      }
      const sat = new MutationEngine().saturation();
      if (sat.n >= 20) {
        lines.push(
          sat.plateaued
            ? `⚠ **Practice saturated** — success ${Math.round(sat.priorRate * 100)}% → ${Math.round(sat.recentRate * 100)}% over the last ${sat.n} gradeable episodes (no improvement beyond noise). The curriculum needs new task classes.`
            : `**Learning curve:** success ${Math.round(sat.priorRate * 100)}% → ${Math.round(sat.recentRate * 100)}% over the last ${sat.n} gradeable episodes — still improving.`,
          ''
        );
      }
      for (const d of journal) {
        lines.push(`**${d.at}** — ${d.deviations.length} deviation(s), ${d.lessons.length} lesson(s), ${d.habitsCompiled}/${d.habitsMined} habits compiled${d.practice ? ` · practice[${d.practice.driveId}]: ${d.practice.branch ? `PASSED → ${d.practice.branch}` : d.practice.attempted ? 'failed grade' : d.practice.note || 'skipped'}` : ''}${d.selfPlay?.attempted ? ` · self-play[${d.selfPlay.task?.op}]: ${d.selfPlay.fixed ? (d.selfPlay.exactRestore ? 'FIXED (exact)' : 'FIXED (alt)') : 'failed'}` : ''}`);
      }
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    const deep = sub === 'deep';
    context.addSystemMessage('info', `💤 Dream cycle starting${deep ? ' (deep)' : ''} — measure → consolidate → practice. Sequential and bounded.`);
    const report = await getDreamEngine().cycle({
      deep,
      log: (level, msg) => context.addSystemMessage(level === 'error' ? 'error' : level === 'success' ? 'success' : 'info', `💤 ${msg}`),
    });
    const lines = [
      '## Dream cycle complete',
      '',
      `**Deviations found:** ${report.deviations.length ? report.deviations.join(' · ') : 'none'}`,
      `**Lessons consolidated:** ${report.lessons.length ? '' : 'none new'}`,
      ...report.lessons.map(l => `- ${l}`),
      `**Habits:** ${report.habitsCompiled}/${report.habitsMined} compiled`,
    ];
    if (report.practice) {
      const p = report.practice;
      lines.push(`**Practice (restoration):** ${p.branch ? `✓ PASSED objective grade — patch on \`${p.branch}\` (review + merge if good)` : p.attempted ? `✗ failed the objective re-measurement${p.note ? ` (${p.note})` : ''} — attempt discarded, lesson kept` : p.note || 'skipped'}`);
    } else {
      lines.push('**Practice (restoration):** skipped — no drive deviations to restore (healthy).');
    }
    if (report.selfPlay) {
      const s = report.selfPlay;
      if (s.attempted && s.task) {
        const grade = s.fixed
          ? (s.exactRestore ? '✓ FIXED — exactly restored the ground truth' : '✓ FIXED — alternative route, tests green')
          : '✗ failed the objective grade — failure event is the lesson';
        lines.push(`**Self-play (${s.generator || 'mutation'}, ground truth known):** planted \`${s.task.op}\` in \`${s.task.file}:${s.task.line}\` · killed by \`${s.task.testFile}\` · ${grade}${s.survivors ? ` · ${s.survivors} survivor(s) logged as verification gaps` : ''}`);
      } else {
        lines.push(`**Self-play (${s.generator || 'mutation'}):** ${s.note || 'skipped'}${s.survivors ? ` — ${s.survivors} defect(s) survived their tests (verification gaps, in the ledger)` : ''}`);
      }
    }
    if (report.history) {
      const h = report.history;
      lines.push(`**History replay (real task, re-verified):** ${h.attempted
        ? `episode \`${h.episodeId}\` "${h.taskPreview}" · ${h.fixed ? `✓ re-solved, verified by \`${h.evidenceCommand}\`` : '✗ failed the recorded evidence command'}`
        : h.note || 'skipped'}`);
    }
    lines.push('', '_Lessons land in project memory; weak-spot routing updates the system prompt next turn. `/dream history` shows past cycles._');
    return { type: 'message', level: 'success', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/habits',
  category: 'Code & Intelligence',
  description: 'Procedural memory — recurring tool sequences mined into compiled macros',
  execute: async (args, context) => {
    const miner = getHabitMiner();
    if ((args[0] || '').toLowerCase() === 'run') {
      const slug = args[1];
      const macro = miner.executable().find(h => h.slug === slug);
      if (!macro) {
        const avail = miner.executable().map(h => `\`${h.slug}\``).join(', ') || 'none yet — macros appear when a habit\'s commands prove stable';
        return { type: 'message', level: 'error', content: `Usage: /habits run <slug>. Executable macros: ${avail}` };
      }
      // Replay through the governed BashTool — every safety gate (governor, analyzer,
      // plan-mode veto) applies exactly as if the agent ran each command itself.
      const bash = context.options?.toolRegistry?.getTool?.('BashTool');
      if (!bash) return { type: 'message', level: 'error', content: 'BashTool unavailable in this context.' };
      const lines: string[] = [`## ⚡ Habit macro \`${slug}\` — ${macro.commands!.length} step(s)`, ''];
      for (const [i, cmd] of macro.commands!.entries()) {
        context.addSystemMessage('info', `⚡ [${i + 1}/${macro.commands!.length}] ${cmd}`);
        try {
          const out = await bash.execute({ command: cmd }, { cwd: context.cwd });
          const text = typeof out === 'string' ? out : JSON.stringify(out);
          const failed = /command failed|exit(?:ed with)? code [1-9]/i.test(text.slice(0, 500));
          lines.push(`- ${failed ? '✗' : '✓'} \`${cmd}\``);
          if (failed) {
            lines.push(`  \`\`\`\n  ${text.split('\n').slice(0, 8).join('\n  ')}\n  \`\`\``, '', '_Stopped at the failing step — later steps not run._');
            return { type: 'message', level: 'error', content: lines.join('\n') };
          }
        } catch (e: any) {
          lines.push(`- ✗ \`${cmd}\` — ${e?.message}`, '', '_Stopped at the failing step — later steps not run._');
          return { type: 'message', level: 'error', content: lines.join('\n') };
        }
      }
      lines.push('', '_All steps green._');
      return { type: 'message', level: 'success', content: lines.join('\n') };
    }
    if ((args[0] || '').toLowerCase() === 'compile') {
      miner.mine();
      const compiled = miner.compileAll();
      return {
        type: 'message',
        level: 'success',
        content: compiled.length
          ? `⚙ Compiled ${compiled.length} habit(s) → .bimax/habits/. They're now hinted in the agent prompt so the sequences run as one batch.\n\n${miner.report().join('\n')}`
          : `Nothing new to compile.\n\n${miner.report().join('\n')}`,
      };
    }
    miner.mine();
    return {
      type: 'message',
      level: 'info',
      content: ['## Habits (procedural memory)', '', ...miner.report(), '', '_`/habits compile` turns recurring sequences into recipes; ⚡ macros with stable commands run deterministically via `/habits run <slug>` (through the governed BashTool)._'].join('\n'),
    };
  },
});

globalCommandRegistry.register({
  name: '/dogfood',
  category: 'Code & Intelligence',
  description: 'Use the built artifact as a real user — TUI/CLI/site probes, bug reports on failures',
  execute: async (_args, context) => {
    const engine = getDogfoodEngine();
    const applicable = engine.applicableProbes();
    if (applicable.length === 0) {
      return { type: 'message', level: 'info', content: 'No dogfoodable artifacts found (looked for tui/bimax-tui, dist/index.js or a package bin, and a built site). Build something first.' };
    }
    context.addSystemMessage('info', `🐕 Dogfooding ${applicable.join(', ')} — sequential probes with timeouts…`);
    const { results, reportPath } = await engine.run((level, msg) => context.addSystemMessage(level, `🐕 ${msg}`));
    const lines = ['## Dogfood report', ''];
    for (const r of results) {
      const glyph = !r.ran ? '·' : r.passed ? '✓' : '✗';
      lines.push(`- ${glyph} **${r.id}** (${r.persona}): ${r.summary}`);
      if (r.ran && r.passed === false && r.evidence) lines.push(`  \`\`\`\n  ${r.evidence.split('\n').slice(0, 6).join('\n  ')}\n  \`\`\``);
    }
    const failures = results.filter(r => r.ran && r.passed === false).length;
    if (reportPath) lines.push('', `Structured bug report: \`${reportPath}\` (also remembered as gotchas — the agent will see them).`);
    lines.push('', failures === 0 ? '_Everything usable — the artifacts pass a real user\'s first session._' : `_${failures} probe(s) failed — ask the agent to fix the bug report._`);
    return { type: 'message', level: failures === 0 ? 'success' : 'error', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/ledger',
  category: 'Code & Intelligence',
  description: 'Event ledger — append-only, hash-chained log of tool outcomes (v2 single source of truth)',
  execute: async (args) => {
    const ledger = getEventLedger();
    if (!ledger.isAvailable()) {
      return { type: 'message', level: 'info', content: 'Event ledger unavailable (node:sqlite not supported on this Node build). The agent runs fine without it — recording is best-effort.' };
    }
    if ((args[0] || '').toLowerCase() === 'verify') {
      const v = ledger.verifyChain();
      return {
        type: 'message', level: v.ok ? 'success' : 'error',
        content: v.ok
          ? `Hash chain intact — ${v.events} event(s), every hash covers its predecessor.`
          : `Hash chain BROKEN at event #${v.brokenAt} (of ${v.events}) — the log was modified after the fact.`,
      };
    }
    if ((args[0] || '').toLowerCase() === 'rebuild') {
      const report = rebuildSelfModel(ledger);
      if (!report) return { type: 'message', level: 'info', content: 'Nothing to rebuild — the ledger has no tool_outcome events yet.' };
      return {
        type: 'message', level: 'success',
        content: [
          '## Self-model rebuilt from the ledger',
          '',
          `Replayed **${report.events}** tool_outcome event(s) (${report.skipped} rejected/blocked skipped) → **${report.cells}** cell(s) (was ${report.cellsBefore}).`,
          report.agreed
            ? '_Live state agreed with the fold — no drift between the JSON cache and the event log._'
            : '_⚠ Live state had FEWER samples than the ledger in at least one cell — the JSON had drifted; the rebuilt view is now authoritative._',
          '',
          '_The self-model JSON is now a materialized view: drop it any time, this rebuilds it._',
        ].join('\n'),
      };
    }
    const byType = ledger.countByType();
    const lines = ['## Event ledger — `.bimax/ledger.db`', ''];
    const total = ledger.count();
    lines.push(`**${total} event(s)** — append-only, hash-chained. \`/ledger verify\` audits the chain · \`/ledger rebuild\` refolds the self-model from it.`, '');
    for (const [type, n] of Object.entries(byType)) lines.push(`- \`${type}\` × ${n}`);
    const tail = ledger.tail(8);
    if (tail.length > 0) {
      lines.push('', '**Recent**');
      for (const e of tail) {
        const p = e.payload || {};
        const detail = e.type === 'tool_outcome'
          ? `${p.tool}×${p.domain} → ${p.status}${p.errorClass ? ` [${p.errorClass}]` : ''}${p.exitCode !== undefined && p.exitCode !== null ? ` (exit ${p.exitCode})` : ''}`
          : JSON.stringify(p).slice(0, 80);
        lines.push(`- #${e.id} ${new Date(e.ts).toLocaleTimeString()} \`${e.type}\` ${detail}`);
      }
    }
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/episodes',
  aliases: ['/blackbox'],
  category: 'Code & Intelligence',
  description: 'Black-box flight recorder — every agent run is a replayable, hash-chained episode bundle',
  execute: async (args) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'replay') {
      const id = args[1];
      if (!id) return { type: 'message', level: 'error', content: 'Usage: `/episodes replay <id>` — re-runs the recording through the current harness at zero token cost.' };
      const report = await replayEpisode(id);
      if ('error' in report) return { type: 'message', level: 'error', content: report.error };
      const lines = [
        `## Replay \`${report.id}\` — ${report.identical ? '✓ IDENTICAL' : '✗ DIVERGED'}`,
        '',
        `Served **${report.callsServed}/${report.callsRecorded}** recorded call(s) · ${report.divergences.length} divergence(s) · ${report.toolResultsMissing} tool result(s) missing${report.systemChanged ? ' · system prompt CHANGED vs recording' : ''}`,
      ];
      if (report.identical) {
        lines.push('', '_The current harness reproduces this episode bit-for-bit — request hashes, trajectory, and tool results all match the recording (the determinism gate holds)._');
      } else {
        for (const d of report.divergences.slice(0, 5)) {
          lines.push(`- call #${d.idx}: request hash \`${d.got.slice(0, 12)}…\` ≠ recorded \`${d.expected.slice(0, 12)}…\` — the harness change alters the trajectory from here.`);
        }
        if (report.divergences.length > 5) lines.push(`- …and ${report.divergences.length - 5} more`);
      }
      for (const c of report.caveats) lines.push(`- ⚠ ${c}`);
      if (report.finalText) lines.push('', `**Re-run output:** ${report.finalText.replace(/\s+/g, ' ').slice(0, 200)}${report.finalText.length > 200 ? '…' : ''}`);
      return { type: 'message', level: report.identical ? 'success' : 'info', content: lines.join('\n') };
    }

    if (sub && sub !== 'list') {
      const id = sub === 'verify' || sub === 'show' ? args[1] : args[0];
      if (!id) return { type: 'message', level: 'error', content: 'Usage: `/episodes [<id> | replay <id> | verify <id>]`' };
      const ep = loadEpisode(id);
      if (!ep) return { type: 'message', level: 'error', content: `No episode bundle \`${id}\` found under \`.bimax/episodes/\`.` };

      if (sub === 'verify') {
        return {
          type: 'message', level: ep.chainOk ? 'success' : 'error',
          content: ep.chainOk
            ? `Bundle intact — header + ${ep.calls.length} call(s), every line's hash covers its predecessor.`
            : `Bundle TAMPERED — hash chain breaks at line ${ep.brokenAt}. The recording was modified after the fact.`,
        };
      }

      const lines = [
        `## Episode \`${ep.header.id}\` — flight recording`,
        '',
        `Started ${new Date(ep.header.startedAt).toLocaleString()} · ${ep.calls.length} LLM call(s) · chain ${ep.chainOk ? 'intact ✓' : `BROKEN at line ${ep.brokenAt} ✗`}${ep.header.lite ? ' · lite tier' : ''}`,
        '',
      ];
      for (const c of ep.calls) {
        const r = c.response || ({} as any);
        const parts: string[] = [];
        if (r.thinking) parts.push(`thought ${r.thinking.length}ch`);
        if (r.toolCalls?.length) parts.push(`→ ${r.toolCalls.map((t: any) => t.name).join(', ')}`);
        if (r.text) parts.push(`"${r.text.replace(/\s+/g, ' ').slice(0, 70)}${r.text.length > 70 ? '…' : ''}"`);
        if (r.usage) parts.push(`${r.usage.prompt}+${r.usage.completion}tok`);
        if (r.error) parts.push(`⚠ ${r.error.slice(0, 60)}`);
        if (r.incomplete) parts.push('⚠ incomplete (aborted mid-stream)');
        lines.push(`- **#${c.idx}** ${new Date(c.ts).toLocaleTimeString()} · ${c.msgCount} msgs${c.reset ? ' (compacted)' : ''} · ${parts.join(' · ') || '(empty turn)'}`);
      }
      lines.push('', `_Replay: this bundle serves these exact responses to a re-run at zero token cost — a request that no longer hash-matches marks where a harness change diverges._`);
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    const eps = listEpisodes();
    if (eps.length === 0) {
      return { type: 'message', level: 'info', content: 'No episodes recorded yet — every agent run records one automatically (`BIMAX_RECORDER=0` disables).' };
    }
    const lines = [
      '## Episodes — `.bimax/episodes/` (black-box recorder)',
      '',
      `**${eps.length} bundle(s)** · hash-chained JSONL, pruned to the last 40 · \`/episodes <id>\` shows the recording · \`/episodes replay <id>\` re-runs it through the current harness (zero tokens) · \`/episodes verify <id>\` audits it.`,
      '',
    ];
    for (const e of eps.slice(-12).reverse()) {
      const dur = Math.max(0, Math.round((e.endedAt - e.startedAt) / 1000));
      lines.push(`- \`${e.id}\` ${new Date(e.startedAt).toLocaleString()} · ${e.calls} call(s), ${e.toolCalls} tool call(s) · ${dur}s · ${(e.bytes / 1024).toFixed(1)}KB${e.incomplete ? ' · ⚠ aborted' : ''}`);
    }
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/claims',
  category: 'Code & Intelligence',
  description: 'File claims — live path leases held by concurrent agents (merge queue, cross-process)',
  execute: async (args) => {
    const claims = getFileClaims();
    if ((args[0] || '').toLowerCase() === 'release' && args[1]) {
      const n = claims.release(args[1]);
      return { type: 'message', level: n > 0 ? 'success' : 'info', content: n > 0 ? `Released ${n} claim(s) held by \`${args[1]}\`.` : `No live claim matches \`${args[1]}\`.` };
    }
    const live = claims.live();
    if (live.length === 0) {
      return { type: 'message', level: 'info', content: 'No live file claims — no concurrent agent is holding paths right now. (Leases appear here while swarm merges, heals, or a second session mutates the repo.)' };
    }
    const lines = ['## Live file claims (v2 merge queue — path tier)', ''];
    for (const c of live) {
      const age = Math.round((Date.now() - c.at) / 1000);
      lines.push(`- **${c.agent}** (pid ${c.pid}, ${age}s old, TTL ${Math.round(c.ttlMs / 60000)}m) → ${c.paths.slice(0, 5).map(p => `\`${p}\``).join(', ')}${c.paths.length > 5 ? ` +${c.paths.length - 5} more` : ''}`);
    }
    lines.push('', '_Overlapping acquires queue until release/TTL/holder-death. `/claims release <agent|id>` force-releases._');
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/pipelines',
  category: 'Code & Intelligence',
  description: 'Durable pipelines — journaled runs (beast/heal/…), where each one is, what resumes',
  execute: async () => {
    const byPipeline: Record<string, ReturnType<typeof foldRuns>> = {};
    for (const p of ['beast']) byPipeline[p] = foldRuns(getEventLedger(), p);
    const lines = ['## Pipeline journal (v2 §3.10 — every step transition is a ledger event)', ''];
    let any = false;
    for (const [pipeline, runs] of Object.entries(byPipeline)) {
      for (const r of Object.values(runs).slice(-10)) {
        any = true;
        const steps = Object.entries(r.steps).map(([s, st]) => `${st.done ? '✔' : st.failed ? '✖' : '…'} ${s}`).join(' → ');
        const state = r.finished ? (r.failed ? 'FAILED' : 'done') : '⏳ INCOMPLETE — resumable';
        lines.push(`- **${pipeline}** \`${r.run}\` · ${state} · ${steps || '(no steps yet)'}${!r.finished && r.lastStep ? ` · re-run the same command to resume after \`${r.lastStep}\`` : ''}`);
      }
    }
    if (!any) lines.push('_No journaled runs yet — `/beast <goal>` writes one automatically._');
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/arms',
  category: 'Code & Intelligence',
  description: 'Policy arms — measured effect of each learned prompt intervention (IPS over the ledger)',
  execute: async (args) => {
    const arms = getPolicyArms();
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'shadow' || sub === 'activate') {
      const id = args[1] as ArmId;
      if (!ARM_IDS.includes(id)) {
        return { type: 'message', level: 'error', content: `Usage: \`/arms ${sub} <arm>\` — arms: ${ARM_IDS.join(', ')}` };
      }
      arms.setStatus(id, sub === 'shadow' ? 'shadow' : 'active');
      const restored = arms.holdoutRate() > 0 ? 'ACTIVE (shows with the holdout propensity)' : 'ACTIVE (always shows — the holdout is off)';
      return { type: 'message', level: 'success', content: `Arm \`${id}\` → ${sub === 'shadow' ? 'SHADOW (logs counterfactuals, never enters the prompt)' : restored}.` };
    }

    const rows = arms.report();
    const holdout = arms.holdoutRate();
    const lines = [
      '## Policy arms — every mind prompt block, measured (v2 §4.4)',
      '',
      'Each injection logs its decision + propensity; rewards fold from episode tool-success. IPS answers "does showing this block help?" from historical traffic at zero token cost.',
      '',
    ];
    for (const r of rows) {
      const eff = r.lift !== null
        ? `V(show)=${(r.vShow! * 100).toFixed(0)}% V(hide)=${(r.vHide! * 100).toFixed(0)}% → lift ${r.lift >= 0 ? '+' : ''}${(r.lift * 100).toFixed(0)}pp`
        : holdout <= 0 && r.status === 'active'
          ? 'no counterfactual — the holdout is off, so this arm always shows'
          : 'no counterfactual data yet (both sides of the holdout need observations)';
      lines.push(`- **${r.arm}** [${r.status}] · ${r.decisions} scored decision(s), shown ${Math.round(r.shownRate * 100)}% · ${eff}${r.lift !== null && r.lift < 0 && r.decisions >= 30 ? ' · ⚠ consider `/arms shadow ' + r.arm + '`' : ''}`);
    }
    const budget = holdout > 0
      ? `Holdout ${(holdout * 100).toFixed(0)}% — active arms hide that often to buy the counterfactual.`
      : 'Holdout is **off** (the default): arms always show, so no lift can be estimated. Set `BIMAX_POLICY_HOLDOUT=0.1` to start buying counterfactuals — worth it once episodes are accruing and something reads the estimate.';
    lines.push('', `_\`/arms shadow <arm>\` demotes (stops acting, keeps logging) · \`/arms activate <arm>\` restores. ${budget}_`);
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/exemplars',
  category: 'Code & Intelligence',
  description: 'Verified experience — episodes that passed objective checks, retrieved into prompts for similar tasks',
  execute: async (args) => {
    const store = getExemplarStore();
    const all = store.all();
    if (all.length === 0) {
      return { type: 'message', level: 'info', content: 'No verified exemplars yet — they accumulate from /dream self-play (mutation fixes, regenerations) and history replay. Only episodes that passed an objective check are kept.' };
    }

    // With a query: show exactly what a task phrased like this would retrieve (the receipts).
    const query = args.join(' ').trim();
    if (query) {
      const hits = store.retrieve(query, 5);
      if (hits.length === 0) {
        return { type: 'message', level: 'info', content: `Nothing in the corpus is similar enough to "${query}" — a task phrased like this gets NO exemplar block (below the similarity floor).` };
      }
      const lines = [`## Retrieval preview — "${query}"`, ''];
      for (const { item: e, sim } of hits) {
        lines.push(`- **${Math.round(sim * 100)}%** [${e.kind}/${e.outcome}] ${e.task ? `"${e.task.slice(0, 80)}"` : `${e.op} in \`${e.file}\``} · verified by \`${e.testFile || e.evidence || 'recorded check'}\``);
      }
      lines.push('', '_The top matches above the floor are injected into the system prompt for a task like this._');
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    const byKind: Record<string, number> = {};
    for (const e of all) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const lines = [
      '## Verified experience — `.bimax/exemplars.json`',
      '',
      `**${all.length} exemplar(s)** · ${Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(' · ')}`,
      '',
    ];
    for (const e of all.slice(-12).reverse()) {
      lines.push(`- ${e.at ? new Date(e.at).toLocaleString() : '—'} [${e.kind}/${e.outcome}] ${e.task ? `"${e.task.slice(0, 70)}"` : `${e.op} in \`${e.file}\``} · verified by \`${e.testFile || e.evidence || 'recorded check'}\``);
    }
    lines.push('', '_These are retrieved (local embeddings, k-NN) into the prompt when a new task is similar — the agent gets better at THIS repo with every verified episode. `/exemplars <query>` previews a retrieval._');
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/taint',
  category: 'Code & Intelligence',
  description: 'Context taint — untrusted web/MCP content narrows what Bash may do; review + clear here',
  execute: async (args) => {
    const tracker = getTaintTracker();
    if ((args[0] || '').toLowerCase() === 'clear') {
      if (!tracker.isTainted()) return { type: 'message', level: 'info', content: 'Context is not tainted — nothing to clear.' };
      tracker.clear('cleared by user via /taint clear');
      return { type: 'message', level: 'success', content: 'Taint cleared — network-capable commands are back to normal gating. Make sure you actually reviewed the untrusted content first.' };
    }
    if (!tracker.isTainted()) {
      return { type: 'message', level: 'info', content: 'Context is **clean** — no web/MCP content has entered the conversation. Network commands run under normal gating.' };
    }
    const lines = [
      '## ⚠ Context is TAINTED',
      '',
      'Untrusted content is in the conversation window. Until cleared: network-capable commands',
      '(curl/wget/ssh/scp/git push/installs…) are **blocked in auto mode** and always ask elsewhere.',
      '',
      '**Untrusted content in this window:**',
    ];
    for (const m of tracker.marks().slice(-10).reverse()) {
      lines.push(`- [${m.source}] ${m.detail} · ${new Date(m.at).toLocaleTimeString()}`);
    }
    lines.push('', '_Review the content above for injected instructions, then `/taint clear` — or `/clear` the conversation._');
    return { type: 'message', level: 'warn' as any, content: lines.join('\n') };
  },
});

globalCommandRegistry.register({
  name: '/harness',
  category: 'Code & Intelligence',
  description: 'Self-tuned harness patches + counterfactual lab. `mine`, `retire|approve|reject|rollback <id>`, `lab [show|run|explain <exp>]`.',
  execute: async (args) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getHarnessTuner } = require('../../mind/harness.tuner') as typeof import('../../mind/harness.tuner');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { labEnabled } = require('../../mind/harness.lab') as typeof import('../../mind/harness.lab');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { explainExperiment } = require('../../mind/harness.lab.eval') as typeof import('../../mind/harness.lab.eval');
    const tuner = getHarnessTuner();
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'mine') {
      const r = tuner.mine();
      const lab = await tuner.labPass();
      const labNote = labEnabled()
        ? ` Lab: ${lab.evaluated} evaluated, ${lab.activated} activated, ${lab.rejected} rejected, ${lab.skipped} unchanged.`
        : ' Lab disabled (BIMAX_HARNESS_LAB=0) — patches activate immediately.';
      return { type: 'message', level: 'info', content: `Mining pass done — ${r.created} patch(es) created, ${r.retired} retired.${labNote}` };
    }
    if (sub === 'retire' && args[1]) {
      return tuner.retire(args[1])
        ? { type: 'message', level: 'success', content: `Patch ${args[1]} retired.` }
        : { type: 'message', level: 'error', content: `No active patch with id ${args[1]}.` };
    }
    if (sub === 'approve' && args[1]) {
      return tuner.approve(args[1])
        ? { type: 'message', level: 'success', content: `Patch ${args[1]} approved manually — it is LIVE in the prompt from the next turn. Its experiment records the manual override; live effectiveness accounting still applies.` }
        : { type: 'message', level: 'error', content: `No staged patch with id ${args[1]} (only staged patches can be approved).` };
    }
    if (sub === 'reject' && args[1]) {
      return tuner.rejectStaged(args[1])
        ? { type: 'message', level: 'success', content: `Staged patch ${args[1]} rejected — it will not be re-mined for this signature.` }
        : { type: 'message', level: 'error', content: `No staged patch with id ${args[1]}.` };
    }
    if (sub === 'rollback' && args[1]) {
      return tuner.rollback(args[1])
        ? { type: 'message', level: 'success', content: `Patch ${args[1]} rolled back — removed from the live prompt; its experiment is closed as rolled_back.` }
        : { type: 'message', level: 'error', content: `No active patch with id ${args[1]}.` };
    }

    if (sub === 'lab') {
      const store = tuner.labStore();
      const verb = (args[1] || '').toLowerCase();
      const findExp = (key: string) => store.get(key)
        || store.list().find(e => e.candidate.patchId === key) || null;

      if (verb === 'run' && args[2]) {
        // Force = the user explicitly asked — re-evaluate even on an unchanged cohort.
        const key = args[2];
        const exp = findExp(key);
        const patchId = exp?.candidate.patchId || key;
        const r = await tuner.labPass({ force: true, only: patchId });
        if (r.evaluated === 0 && r.activated === 0 && r.rejected === 0) {
          return { type: 'message', level: 'error', content: `Nothing evaluated for "${key}" — it must reference a STAGED patch (or its experiment). ${r.skipped ? 'A concurrent evaluation holds the lab lock.' : 'Terminal/active experiments are not re-run.'}` };
        }
        const after = findExp(key);
        return { type: 'message', level: 'success', content: `Evaluation complete — verdict: **${after?.evaluations[after.evaluations.length - 1]?.verdict || 'unknown'}** (experiment ${after?.id}, status ${after?.status}). \`/harness lab explain ${after?.id}\` for the evidence.` };
      }
      if ((verb === 'show' || verb === 'explain') && args[2]) {
        const exp = findExp(args[2]);
        if (!exp) return { type: 'message', level: 'error', content: `No experiment "${args[2]}" (try /harness lab for the list).` };
        if (verb === 'explain') return { type: 'message', level: 'info', content: explainExperiment(exp) };
        const ev = exp.evaluations[exp.evaluations.length - 1];
        const lines = [
          `## Experiment \`${exp.id}\``,
          `- candidate: **${exp.candidate.tool} × ${exp.candidate.errorClass}** (patch \`${exp.candidate.patchId}\`, block ${exp.candidate.promptBlock.length} chars, hash ${exp.candidate.blockHash.slice(0, 12)})`,
          `- baseline: ${exp.baseline.description}`,
          `- status: **${exp.status}**${exp.statusReason ? ` — ${exp.statusReason}` : ''}`,
          `- evaluations: ${exp.evaluations.length}${ev ? ` · latest \`${ev.id}\` → ${ev.verdict} (${ev.confidence}) on cohort \`${ev.cohort.cohortHash.slice(0, 12)}\` (${ev.aggregate.episodesUsable}/${ev.aggregate.episodesSelected} usable)` : ''}`,
          `- transitions: ${exp.transitions.map(t => `${t.from ?? '·'}→${t.to}(${t.by})`).join(' ')}`,
        ];
        if (ev) {
          lines.push(`- gates: ${ev.gates.map(g => `${g.pass ? '✓' : '✗'}${g.gate}`).join(' ')}`);
          if (ev.cohort.skipped.length) lines.push(`- skipped episodes: ${ev.cohort.skipped.map(s => `${s.id}(${s.reason})`).slice(0, 8).join(', ')}${ev.cohort.skipped.length > 8 ? '…' : ''}`);
        }
        lines.push('', `_\`/harness lab explain ${exp.id}\` renders the full measured-vs-inferred verdict._`);
        return { type: 'message', level: 'info', content: lines.join('\n') };
      }

      const exps = store.list();
      if (exps.length === 0) {
        return { type: 'message', level: 'info', content: '## Counterfactual lab\n\nNo experiments yet — they appear when the tuner stages a freshly mined patch. `/harness mine` forces the full pipeline.' };
      }
      const lines = ['## Counterfactual lab — offline A/B validation of harness patches', ''];
      for (const e of exps) {
        const ev = e.evaluations[e.evaluations.length - 1];
        lines.push(`- \`${e.id}\` **${e.candidate.tool} × ${e.candidate.errorClass}** · ${e.status}${ev ? ` · ${ev.verdict} (${ev.confidence}, ${ev.aggregate.episodesUsable} usable ep)` : ' · not evaluated'} · patch \`${e.candidate.patchId}\``);
      }
      lines.push('', '_`/harness lab show|explain <exp>` · `/harness lab run <exp|patch>` re-evaluates · `/harness approve|reject|rollback <patch>`_');
      return { type: 'message', level: 'info', content: lines.join('\n') };
    }

    const patches = tuner.all();
    if (patches.length === 0) {
      return { type: 'message', level: 'info', content: '## Harness patches\n\nNone yet — patches appear once a failure signature recurs ≥4× in the recent ledger. Force a pass with `/harness mine`.' };
    }
    const lines = ['## Harness patches — self-tuned steering (Self-Harness pattern)', ''];
    for (const p of patches) {
      const glyph = p.status === 'active' ? '◍' : p.status === 'staged' ? '◌' : '✗';
      const eff = p.samplesSince > 0
        ? ` · since: ${p.failuresSince}/${p.samplesSince} failures (baseline ${(p.baselineRate * 100).toFixed(0)}%)`
        : '';
      const lab = p.status === 'staged'
        ? ` · STAGED awaiting lab verdict${p.labExperimentId ? ` (\`${p.labExperimentId}\`)` : ''}`
        : p.activatedBy ? ` · live via ${p.activatedBy}` : '';
      lines.push(`${glyph} \`${p.id}\` **${p.tool} × ${p.errorClass}** — ${p.evidenceCount} failures mined${eff}${lab}${p.status === 'retired' ? ` · retired: ${p.retiredReason}` : ''}`);
      lines.push(`   ${p.rule}`);
    }
    const staged = patches.filter(p => p.status === 'staged').length;
    if (staged > 0 && !labEnabled()) lines.push('', `_⚠ ${staged} staged patch(es) while the lab is disabled — the next mining pass activates them (legacy mode)._`);
    lines.push('', '_`/harness retire|approve|reject|rollback <id>` · `/harness mine` re-mines + runs the lab · `/harness lab` for experiments_');
    return { type: 'message', level: 'info', content: lines.join('\n') };
  },
});
