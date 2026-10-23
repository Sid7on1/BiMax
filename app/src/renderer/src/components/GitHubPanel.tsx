import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitBranch, RefreshCw, TriangleAlert,
} from 'lucide-react';
import { cn } from '../lib/cn';

export interface GitRemoteInfo {
  isRepo: boolean;
  branch: string;
  remoteUrl: string;
  remoteName: string;
  slug: string;
  hasUpstream: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastFetch: string;
}

/**
 * The GitHub lane: where this branch stands against its remote, and the three verbs that change it.
 *
 * Two rules shape it.
 *
 * *It states position before it offers an action.* "Push" on its own is a button with no subject —
 * the thing a person needs first is what would be sent and where. Ahead/behind, the branch, the
 * upstream and the dirty count all read before any control, so a click is never a guess.
 *
 * *Every verb reports git's own words.* No spinner that resolves into silence and no invented
 * success text: the raw output goes on screen, because "Everything up-to-date", "authentication
 * required" and "diverged" are the three answers that actually tell you what to do next, and
 * paraphrasing any of them loses the instruction.
 */
export function GitHubPanel(): React.ReactElement {
  const [info, setInfo] = useState<GitRemoteInfo | null>(null);
  const [busy, setBusy] = useState<'' | 'fetch' | 'pull' | 'push'>('');
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setInfo((await window.bimax.git.remote()) as GitRemoteInfo | null); } catch { setInfo(null); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (verb: 'fetch' | 'pull' | 'push') => {
    setBusy(verb);
    setLog(null);
    try {
      const api = window.bimax.git;
      const res = verb === 'fetch' ? await api.fetch()
        : verb === 'pull' ? await api.pull()
        : await api.push(info ? !info.hasUpstream : false);
      setLog({ ok: res.ok, text: res.output });
      await load();
    } catch (e) {
      setLog({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }, [info, load]);

  if (!info || !info.isRepo) {
    return <div className="inspector-empty"><GitBranch size={17} /><div>This folder is not a git repository.</div></div>;
  }

  const noRemote = !info.remoteUrl;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      {/* --- Where this branch stands ------------------------------------------------------- */}
      <section className="rounded-xl border border-line bg-raise/60 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={14} className="shrink-0 text-dim" />
          <span className="truncate text-[12.5px] font-semibold text-ink">{info.branch || 'HEAD'}</span>
          <button
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh remote state"
            className="ml-auto shrink-0 cursor-pointer rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <div className="mt-1 truncate text-[10.5px] text-faint">
          {noRemote ? 'No remote configured' : info.slug || info.remoteUrl}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Stat label="ahead" value={info.ahead} tone={info.ahead > 0 ? 'ok' : 'flat'} />
          <Stat label="behind" value={info.behind} tone={info.behind > 0 ? 'warn' : 'flat'} />
          <Stat label="uncommitted" value={info.dirty} tone={info.dirty > 0 ? 'warn' : 'flat'} />
        </div>

        {!info.hasUpstream && !noRemote && (
          <p className="mt-2 text-[10.5px] text-amber">
            This branch has no upstream yet — Push will publish it and set one.
          </p>
        )}
        {noRemote && (
          <p className="mt-2 text-[10.5px] text-dim">
            Add one with <code className="text-ink">git remote add origin &lt;url&gt;</code>, then refresh.
          </p>
        )}
      </section>

      {/* --- The three verbs ---------------------------------------------------------------- */}
      <div className="flex flex-wrap gap-1.5">
        <Verb icon={<RefreshCw size={12} />} label="Fetch" busy={busy === 'fetch'} disabled={!!busy || noRemote} onClick={() => void run('fetch')} />
        <Verb
          icon={<ArrowDownToLine size={12} />}
          label={info.behind > 0 ? `Pull (${info.behind})` : 'Pull'}
          busy={busy === 'pull'}
          disabled={!!busy || noRemote || !info.hasUpstream}
          onClick={() => void run('pull')}
        />
        <Verb
          icon={<ArrowUpFromLine size={12} />}
          label={info.ahead > 0 ? `Push (${info.ahead})` : 'Push'}
          primary
          busy={busy === 'push'}
          disabled={!!busy || noRemote}
          onClick={() => void run('push')}
        />
        {info.slug && (
          <a
            href={info.remoteUrl}
            target="_blank"
            rel="noreferrer"
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-raise px-2.5 py-1.5 text-[11px] text-dim hover:bg-hover hover:text-ink"
          >
            <ExternalLink size={12} />Open on GitHub
          </a>
        )}
      </div>

      {info.dirty > 0 && info.behind > 0 && (
        <p className="flex items-start gap-1.5 text-[10.5px] text-amber">
          <TriangleAlert size={12} className="mt-px shrink-0" />
          You have uncommitted work and the remote has moved. Commit or stash before pulling.
        </p>
      )}

      {/* --- git's own words ---------------------------------------------------------------- */}
      {log && (
        <pre
          className={cn(
            'max-h-56 shrink-0 overflow-auto rounded-lg border p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap',
            log.ok ? 'border-line bg-raise/60 text-dim' : 'border-rust/30 bg-rust/8 text-rust',
          )}
        >
          {log.text}
        </pre>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'flat' }): React.ReactElement {
  return (
    <span
      className={cn(
        'rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums',
        tone === 'ok' ? 'border-moss/30 bg-moss/10 text-moss'
          : tone === 'warn' ? 'border-amber/30 bg-amber/10 text-amber'
            : 'border-line bg-raise text-faint',
      )}
    >
      {value} {label}
    </span>
  );
}

function Verb({ icon, label, onClick, busy, disabled, primary = false }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45',
        primary ? 'bg-ink text-bg hover:bg-white' : 'border border-line bg-raise text-dim hover:bg-hover hover:text-ink',
      )}
    >
      <span className={cn(busy && 'animate-spin')}>{icon}</span>
      {busy ? 'Working…' : label}
    </button>
  );
}
