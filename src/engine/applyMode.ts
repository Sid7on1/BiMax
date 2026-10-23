import { engineEvents } from './events';
import { AgentMode, setAgentMode, setExploreEngagedGate, didExploreEngageGate } from './agentMode';

// Single source of truth for switching the agent's behavioral mode, shared by the /mode command,
// the TUI's Shift+Tab cycle, and ModeTool (the agent switching ITSELF). Centralizing it means the
// governor gating (read-only for explore/sketch, writes for code/beast/general) and the mode_change
// event (which drives the footer chip) can never drift between the three entry points.

// When entering explore/sketch we flip the governor to its read-only 'plan' gate. We remember the
// PRIOR governor mode so leaving restores exactly what was there (interactive OR bypass) — instead
// of guessing — and we only restore if WE engaged the gate (never cancel a user's own `/plan on`).
let _priorGovernorMode: string | null = null;

export function applyAgentMode(mode: AgentMode, governor: any): void {
  setAgentMode(mode);

  if (mode === 'explore' || mode === 'sketch') {
    if (governor && governor.mode !== 'plan') {
      _priorGovernorMode = governor.mode;
      governor.mode = 'plan'; // reuse the proven write-gate for read-only enforcement
      setExploreEngagedGate(true);
    }
    engineEvents.emit('mode_change', mode === 'sketch' ? 'SKETCH' : 'EXPLORE');
    return;
  }

  // Leaving a read-only mode: restore writes ONLY if we were the ones who engaged the gate.
  if (governor && governor.mode === 'plan' && didExploreEngageGate()) {
    governor.mode = _priorGovernorMode || 'interactive';
  }
  setExploreEngagedGate(false);
  _priorGovernorMode = null;
  engineEvents.emit('mode_change', mode === 'code' ? 'CODE' : mode === 'beast' ? 'BEAST' : '');
}
