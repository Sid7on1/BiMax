import React, { useEffect, useRef, useState } from 'react';
import { Monitor, MoreHorizontal, X } from 'lucide-react';
import type { ComputerMode } from '../../../shared/computer';

/** @CU starts directly. Optional modes never require native discovery in the composer. */
export function ComputerUseOptions({ threadId, onRemove, mode = 'do', onMode, onRecipe, disabled = false }: {
  threadId?: string; onRemove(): void; disabled?: boolean; mode?: ComputerMode; onMode?(mode: ComputerMode): void; onRecipe?(text: string): void;
}): React.ReactElement {
  const [open, setOpen] = useState(false), [error, setError] = useState('');
  const [recipes, setRecipes] = useState<Array<{ name: string; text: string }>>([]);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setOpen(false); setRecipes([]); setError(''); return () => { generation.current++; }; }, [threadId]);
  async function toggle() {
    const own = ++generation.current;
    setOpen(!open); setError('');
    if (!open) {
      try { const saved = await window.bimax.computer?.recipes?.(threadId) || []; if (generation.current === own) setRecipes(saved); }
      catch { if (generation.current === own) setError('Could not load saved workflows.'); }
    }
  }
  return <div className="computer-route" data-computer-route="" role="group" aria-label="Computer Use for this message">
    <div className="computer-route-row">
      <span className="computer-route-chip"><Monitor size={13} aria-hidden="true" /> @CU</span>
      <span className="computer-route-hint">{mode === 'guide' ? 'Guide me, one step at a time' : mode === 'teach' ? 'Show me how, then save the steps' : 'Bimax will use your computer'}</span>
      <button type="button" disabled={disabled} onClick={() => void toggle()} aria-expanded={open} aria-label="Computer Use options" className="computer-icon-button"><MoreHorizontal size={16} /></button>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label="Remove Computer Use" className="computer-icon-button"><X size={14} /></button>
    </div>
    {open && <div className="computer-options">
      <label>How to help <select aria-label="Computer Use mode" value={mode} disabled={disabled} onChange={e => onMode?.(e.target.value as ComputerMode)}><option value="do">Do the task</option><option value="guide">Guide me</option><option value="teach">Teach me</option></select></label>
      {recipes.length > 0 && <label>Saved workflow <select aria-label="Saved Computer Use workflow" defaultValue="" disabled={disabled} onChange={e => { const recipe = recipes[Number(e.target.value)]; if (recipe) { onRecipe?.(recipe.text); setOpen(false); } }}><option value="" disabled>Review a workflow…</option>{recipes.map((recipe, i) => <option key={i} value={i}>{recipe.name}</option>)}</select></label>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
