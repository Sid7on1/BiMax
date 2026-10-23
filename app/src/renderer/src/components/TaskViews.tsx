import React, { useState } from 'react';

/**
 * Disposable tools inside a task (backlog FL8): the three views a task can open with TaskViewTool — a contact sheet,
 * a matching table and a name editor. The view arrives as the JSON body of an ordinary question; what the person
 * chooses goes back as JSON, and "Cancel" as the word itself (the tool tells the task nothing was chosen).
 */
export type TaskView =
  | { view: 'photos'; title: string; files: string[]; pick: 'some' | 'one' }
  | { view: 'match'; title: string; left: string[]; right: string[]; pairs: Array<{ left: number; right: number | null }> }
  | { view: 'names'; title: string; items: Array<{ path: string; name: string }> };

/** The view a question carries, or null for an ordinary question. */
export function taskView(body: string | undefined): TaskView | null {
  if (!body || !body.startsWith('{"bimaxView"')) return null;
  try {
    const view = (JSON.parse(body) as { bimaxView?: TaskView }).bimaxView;
    return view && ['photos', 'match', 'names'].includes(view.view) ? view : null;
  } catch {
    return null;
  }
}

/** A local picture as an image URL: every path segment encoded, so "#" or "?" in a name does not cut it short. */
export const fileUrl = (file: string): string => `file://${file.split('/').map(encodeURIComponent).join('/')}`;
const base = (file: string): string => file.split('/').pop() ?? file;

export function TaskViewCard({ view, onReply }: { view: TaskView; onReply: (value: string) => void }): React.ReactElement {
  const cancel = <button type="button" className="quick-choice" onClick={() => onReply('Cancel')}>Cancel</button>;
  if (view.view === 'photos') return <ContactSheet view={view} onReply={onReply} cancel={cancel} />;
  if (view.view === 'match') return <MatchTable view={view} onReply={onReply} cancel={cancel} />;
  return <NameEditor view={view} onReply={onReply} cancel={cancel} />;
}

function ContactSheet({ view, onReply, cancel }: { view: Extract<TaskView, { view: 'photos' }>; onReply: (v: string) => void; cancel: React.ReactNode }): React.ReactElement {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (file: string): void => setPicked((current) => (view.pick === 'one' ? [file] : current.includes(file) ? current.filter((f) => f !== file) : [...current, file]));
  return (
    <section className="quick-request" aria-label={view.title}>
      <p className="quick-request-question">{view.title}</p>
      <div className="grid grid-cols-4 gap-1.5" role="listbox" aria-multiselectable={view.pick !== 'one'}>
        {view.files.map((file) => (
          <button key={file} type="button" role="option" aria-selected={picked.includes(file)} title={base(file)} onClick={() => toggle(file)}
            className={`relative overflow-hidden rounded-md border ${picked.includes(file) ? 'border-ember ring-2 ring-ember/60' : 'border-line'}`}>
            <img src={fileUrl(file)} alt={base(file)} loading="lazy" className="aspect-square w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-[10px] text-white">{base(file)}</span>
          </button>
        ))}
      </div>
      <div className="quick-request-options">
        <button type="button" className="quick-choice quick-choice-primary" disabled={!picked.length} onClick={() => onReply(JSON.stringify({ picked }))}>
          {view.pick === 'one' ? 'Use this one' : `Use ${picked.length} picked`}
        </button>
        {cancel}
      </div>
    </section>
  );
}

function MatchTable({ view, onReply, cancel }: { view: Extract<TaskView, { view: 'match' }>; onReply: (v: string) => void; cancel: React.ReactNode }): React.ReactElement {
  const [pairs, setPairs] = useState<Array<number | null>>(() => view.left.map((_, i) => view.pairs.find((p) => p.left === i)?.right ?? null));
  return (
    <section className="quick-request" aria-label={view.title}>
      <p className="quick-request-question">{view.title}</p>
      <table className="w-full text-[12px]">
        <tbody>
          {view.left.map((label, i) => (
            <tr key={i}>
              <td className="py-0.5 pr-2">{label}</td>
              <td className="py-0.5">
                <select aria-label={`Match for ${label}`} value={pairs[i] === null ? '' : String(pairs[i])} className="w-full rounded border border-line bg-raise px-1"
                  onChange={(e) => setPairs((current) => current.map((p, j) => (j === i ? (e.target.value === '' ? null : Number(e.target.value)) : p)))}>
                  <option value="">(no match)</option>
                  {view.right.map((option, j) => <option key={j} value={j}>{option}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="quick-request-options">
        <button type="button" className="quick-choice quick-choice-primary" onClick={() => onReply(JSON.stringify({ pairs: pairs.map((right, left) => ({ left, right })) }))}>Confirm matches</button>
        {cancel}
      </div>
    </section>
  );
}

function NameEditor({ view, onReply, cancel }: { view: Extract<TaskView, { view: 'names' }>; onReply: (v: string) => void; cancel: React.ReactNode }): React.ReactElement {
  const [names, setNames] = useState(() => view.items.map((item) => item.name));
  const bad = names.some((name) => !name.trim() || name.includes('/'));
  return (
    <section className="quick-request" aria-label={view.title}>
      <p className="quick-request-question">{view.title}</p>
      <table className="w-full text-[12px]">
        <tbody>
          {view.items.map((item, i) => (
            <tr key={item.path}>
              <td className="py-0.5 pr-2 text-dim" title={item.path}>{base(item.path)}</td>
              <td className="py-0.5">
                <input aria-label={`New name for ${base(item.path)}`} value={names[i]} className="w-full rounded border border-line bg-raise px-1"
                  onChange={(e) => setNames((current) => current.map((n, j) => (j === i ? e.target.value : n)))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bad ? <p className="quick-error">A name cannot be empty or contain “/”.</p> : null}
      <div className="quick-request-options">
        <button type="button" className="quick-choice quick-choice-primary" disabled={bad} onClick={() => onReply(JSON.stringify({ names: view.items.map((item, i) => ({ path: item.path, name: names[i]!.trim() })) }))}>Use these names</button>
        {cancel}
      </div>
    </section>
  );
}
