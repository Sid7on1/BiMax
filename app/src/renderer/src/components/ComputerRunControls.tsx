import React, { useEffect, useRef, useState } from 'react';
import type { ComputerControl, ComputerRunState } from '../../../shared/computer';

/** The host owns progress, candidates and revisions; the view cannot declare success. */
export function ComputerRunControls({ threadId, onReuse }: { threadId?: string; onReuse(text: string): void }): React.ReactElement | null {
  const [state, setState] = useState<ComputerRunState | null>(null), [error, setError] = useState('');
  const [name, setName] = useState('My computer workflow');
  const generation = useRef(0);
  useEffect(() => {
    const own = ++generation.current; let received = false;
    setState(null); setError('');
    if (!threadId || !window.bimax.computer?.state) return;
    const dispose = window.bimax.computer.onState(event => {
      if (generation.current === own && event.id === threadId) { received = true; setState(event.state); setError(''); }
    });
    void window.bimax.computer.state(threadId).then(value => { if (generation.current === own && !received) setState(value); }).catch(() => {});
    return () => { generation.current++; dispose(); };
  }, [threadId]);
  if (!state || !threadId) return null;
  const terminal = ['complete', 'failed', 'stopped'].includes(state.phase);
  const paused = ['paused', 'takeover'].includes(state.phase);
  async function control(action: ComputerControl, candidate?: number) {
    const own = generation.current;
    try { const ok = await window.bimax.computer!.control(threadId!, state!.revision, action, candidate); if (!ok && own === generation.current) setError('The task changed. Use the current controls.'); }
    catch { if (own === generation.current) setError('Could not change Computer Use. Try again.'); }
  }
  const phaseLabel = { approval: 'Needs permission', running: 'Working', paused: 'Paused', takeover: 'You’re in control', 'waiting-user': 'Your turn', verification: 'Check result', complete: 'Done', stopped: 'Stopped', failed: 'Needs attention' }[state.phase];
  return <section className="computer-run" aria-label="Computer Use progress" data-computer-phase={state.phase}>
    <div className="computer-run-title"><strong>@CU <span className="computer-run-target">{state.target}</span></strong><span role="status">{phaseLabel}{state.progress ? ` · ${state.progress}` : ''}</span></div>
    {state.step && <p>{state.step}</p>}
    {state.reason && <p>{state.reason}</p>}
    {state.expected && <details><summary>Expected result</summary><p>{state.expected}</p></details>}
    {state.phase === 'approval' && state.approval && <div className="computer-approval"><strong>Allow once in {state.approval.application}?</strong><p>{state.approval.operation.split('\n')[0].startsWith('Read this app') ? 'Read this app for this task' : state.step || state.approval.operation.split(': {')[0]}</p><details><summary>Action details</summary><pre>{state.approval.operation}</pre></details><button onClick={() => void control('deny')}>Cancel this action</button><button onClick={() => void control('allow')}>Allow once</button></div>}
    <div className="computer-run-actions">
      {!terminal && (paused ? <button onClick={() => void control('resume')} aria-label="Resume Computer Use">Resume</button> : <><button onClick={() => void control('pause')} aria-label="Pause Computer Use">Pause</button><details className="computer-more"><summary aria-label="More Computer Use controls">More</summary><button onClick={() => void control('takeover')}>Take over</button></details></>)}
      {!terminal && <button onClick={() => void control('stop')} aria-label="Stop Computer Use">Stop</button>}
      {state.phase === 'waiting-user' && <button onClick={() => void control('check')}>Check step</button>}
    </div>
    {state.phase === 'verification' && <div className="computer-verification"><p>Only choose a status that proves the requested result:</p>{state.candidates?.map((candidate, i) => <button key={i} onClick={() => void control('correct', i)}>Check exact status: {candidate.value}</button>)}</div>}
    {state.phase === 'complete' && state.recipe && <details><summary>Review reusable workflow</summary><p>Literal values are saved. Review the message before running it again. Bimax will find the app and ask for fresh permission.</p><pre>{state.recipe}</pre><label>Workflow name <input aria-label="Computer workflow name" maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label><button disabled={!!state.saved || !name.trim()} onClick={() => { const own = generation.current; void window.bimax.computer!.save(threadId, state.revision, name).then(ok => { if (!ok && own === generation.current) setError('Workflow was not saved. Review and try again.'); }); }}>Save verified workflow</button><button onClick={() => onReuse(state.recipe!)}>Review as new @CU message</button>{state.saved && <p role="status">Saved: {state.saved}</p>}</details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
