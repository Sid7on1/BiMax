import { globalCommandRegistry } from './registry';
import {
  isSovereign, setSovereignMode, sovereignAllowlist, setSovereignAllowlist, classifyDestination, hostOf,
} from '../../security/sovereign';
import {
  sessionEgress, summarize, readLedger, ledgerPath, ledgerWriteFailures, EgressSummary,
} from '../../security/egress.ledger';
import { isEgressPerimeterInstalled, unpatchableEgressSurfaces } from '../../security/egress.perimeter';
import { isSandboxEnabled, sandboxAvailable, sandboxBackend } from '../../sandbox/exec.sandbox';

/**
 * `/sovereign` — the command that turns the sovereignty claim into something someone else can read.
 *
 * The ledger has always held the evidence; nothing surfaced it, so "no external calls were made"
 * was an assertion rather than an artefact. PS 26117 is explicit that the artefact is the
 * deliverable ("through logs or a visible network monitor... that's the actual proof of the
 * sovereign claim, not just a statement of it"), and this is where an evaluator reads it.
 *
 * Two scopes, deliberately distinguished. THIS SESSION answers "what did this run contact?" from
 * the in-memory mirror. ON DISK answers "what has this installation ever contacted?" by re-reading
 * the NDJSON, which is the question an audit actually asks and the one a session-scoped counter
 * cannot answer.
 */

/** `142 attempts · 142 loopback · 0 external` — the line an auditor reads first. */
function headline(s: EgressSummary): string {
  const parts = [`${s.attempts} attempt${s.attempts === 1 ? '' : 's'}`];
  if (s.loopback) parts.push(`${s.loopback} loopback`);
  if (s.privateLan) parts.push(`${s.privateLan} private-lan`);
  if (s.allowlisted) parts.push(`${s.allowlisted} allowlisted`);
  parts.push(`${s.external} external`);
  if (s.refused) parts.push(`${s.refused} refused`);
  return parts.join(' · ');
}

/**
 * The honesty footnote. A ledger that failed to write is INCOMPLETE, and a report that presented an
 * incomplete ledger as a complete one would be the exact overstatement this whole subsystem exists
 * to remove.
 */
function completeness(): string[] {
  const out: string[] = [];
  const failures = ledgerWriteFailures();
  if (failures > 0) {
    out.push(`⚠ ${failures} ledger write${failures === 1 ? '' : 's'} failed — the file on disk is INCOMPLETE.`);
  }
  if (!isEgressPerimeterInstalled()) {
    out.push('⚠ The egress perimeter is NOT installed in this process. Only modules that call the '
      + 'guard explicitly are covered, so this report is not a whole-process claim.');
  }
  const holes = unpatchableEgressSurfaces();
  if (holes.length > 0) {
    out.push(`⚠ The perimeter could not wrap: ${holes.join(', ')}. Traffic through those is unrecorded.`);
  }
  return out;
}

/** How the shell is governed — the half of the claim the in-process perimeter cannot make. */
function shellPosture(): string {
  if (!isSovereign()) {
    return isSandboxEnabled() ? 'sandbox on (network permitted — ordinary profile)' : 'sandbox off';
  }
  if (!sandboxAvailable()) {
    return 'NO OS BACKEND — BashTool is refused rather than run without kernel isolation';
  }
  return `network denied at the kernel (${sandboxBackend()})`;
}

function statusReport(): string {
  const on = isSovereign();
  const allow = sovereignAllowlist();
  const session = summarize(sessionEgress());
  const lines = [
    `Sovereign mode: ${on ? 'ON — external egress fails closed' : 'off — external egress is permitted and recorded'}`,
    `Egress perimeter: ${isEgressPerimeterInstalled() ? 'installed (fetch · http · https · net · tls · dns)' : 'NOT INSTALLED'}`,
    `Shell:            ${shellPosture()}`,
    `Allowlist:        ${allow.length ? allow.join(', ') : '(empty — only loopback and private-LAN are local)'}`,
    '',
    `This session:     ${headline(session)}`,
  ];
  if (session.externalHosts.length > 0) {
    lines.push(`External hosts:   ${session.externalHosts.join(', ')}`);
  }
  lines.push('', `Ledger: ${ledgerPath()}`);
  lines.push(...completeness());
  return lines.join('\n');
}

function fullReport(): string {
  const session = summarize(sessionEgress());
  const { entries, skipped } = readLedger();
  const disk = summarize(entries);
  const lines = [
    'EGRESS REPORT',
    '',
    `This session: ${headline(session)}`,
    `On disk:      ${headline(disk)}${skipped ? ` (${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped)` : ''}`,
    `Ledger file:  ${ledgerPath()}`,
    '',
  ];

  if (disk.external === 0) {
    lines.push('No external destination was ever contacted by this installation.');
  } else {
    lines.push(`External destinations contacted (${disk.externalHosts.length}):`);
    for (const host of disk.externalHosts) {
      const hits = entries.filter(e => e.host === host);
      const refused = hits.filter(e => e.verdict === 'refused').length;
      const by = [...new Set(hits.map(e => e.subsystem))].join(', ');
      lines.push(`  ${host} — ${hits.length} attempt${hits.length === 1 ? '' : 's'}`
        + `, ${refused} refused · from ${by}`);
    }
  }

  const recent = entries.slice(-12);
  if (recent.length > 0) {
    lines.push('', `Last ${recent.length} attempt${recent.length === 1 ? '' : 's'}:`);
    for (const e of recent) {
      lines.push(`  ${e.at}  ${e.verdict === 'refused' ? 'REFUSED' : 'allowed'}  `
        + `${e.destination.padEnd(11)} ${e.host}  (${e.subsystem}${e.purpose ? ` ${e.purpose}` : ''})`);
    }
  }

  lines.push('');
  lines.push('Scope: this records what the APPLICATION attempted. A child process has its own network');
  lines.push('stack and is governed by the sandbox, not by this ledger — see /sovereign status.');
  lines.push(...completeness());
  return lines.join('\n');
}

globalCommandRegistry.register({
  name: '/sovereign',
  aliases: ['/airgap', '/offline'],
  category: 'Configuration',
  description: 'Air-gap mode — fail-closed external egress, and the ledger that proves it',
  execute: async (args, _context) => {
    const sub = (args[0] || 'status').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      setSovereignMode(sub === 'on');
      return {
        type: 'message',
        level: 'success',
        content: sub === 'on'
          ? `Sovereign mode ON.\n\n${statusReport()}`
          : `Sovereign mode off. Egress is still RECORDED — the ledger keeps answering "what did it `
            + `contact?" whether or not the mode is on.\n\n${statusReport()}`,
      };
    }

    if (sub === 'report') {
      return { type: 'message', level: 'info', content: fullReport() };
    }

    if (sub === 'json') {
      const { entries, skipped } = readLedger();
      return {
        type: 'message',
        level: 'info',
        content: JSON.stringify({
          sovereign: isSovereign(),
          perimeterInstalled: isEgressPerimeterInstalled(),
          unpatchableSurfaces: unpatchableEgressSurfaces(),
          shell: shellPosture(),
          allowlist: sovereignAllowlist(),
          ledgerPath: ledgerPath(),
          ledgerWriteFailures: ledgerWriteFailures(),
          unreadableLines: skipped,
          session: summarize(sessionEgress()),
          disk: summarize(entries),
        }, null, 2),
      };
    }

    if (sub === 'allow') {
      const host = (args[1] || '').trim().toLowerCase();
      if (!host) {
        return {
          type: 'message', level: 'error',
          content: 'Usage: /sovereign allow <host>\n\nDeclares an on-premises host that carries an '
            + 'ordinary name (an internal vLLM box at models.corp.mrpl, say). A leading dot covers '
            + 'subdomains. This is an operator decision and it is recorded in the ledger like any '
            + 'other — it does not make the host local, it records that you asserted it is.',
        };
      }
      const next = [...new Set([...sovereignAllowlist(), host])];
      setSovereignAllowlist(next);
      return {
        type: 'message', level: 'success',
        content: `Allowlisted "${host}" (${classifyDestination(host)}).\nAllowlist: ${next.join(', ')}\n\n`
          + 'This is a session override. Persist it with BIMAX_SOVEREIGN_ALLOW to survive a restart.',
      };
    }

    if (sub === 'check') {
      const target = (args[1] || '').trim();
      if (!target) {
        return { type: 'message', level: 'error', content: 'Usage: /sovereign check <url-or-host>' };
      }
      const destination = classifyDestination(target);
      const refused = isSovereign() && destination === 'external';
      return {
        type: 'message',
        level: refused ? 'error' : 'success',
        content: `${target}\n  host:        ${hostOf(target) || '(unparseable)'}\n`
          + `  destination: ${destination}\n  verdict:     ${refused ? 'REFUSED' : 'allowed'}\n\n`
          + 'Classified by name only — resolving it would itself be egress, and the answer could '
          + 'change between the check and the connection.',
      };
    }

    if (sub === 'status') {
      return { type: 'message', level: 'info', content: statusReport() };
    }

    return {
      type: 'message', level: 'error',
      content: 'Usage: /sovereign [status | on | off | report | json | allow <host> | check <host>]',
    };
  },
});
