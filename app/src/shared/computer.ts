/** A picker receipt is metadata, never an app read grant or native input approval. */
export interface ComputerTarget { token: string; label: string }
export type ComputerMode = 'do' | 'guide' | 'teach';
export interface ComputerRoute { kind: 'computer-use'; target?: ComputerTarget; mode?: ComputerMode; request?: string }
export interface ComputerApp { pid: number; name: string; bundle_id: string }
export interface ComputerWindow { id: number; title: string; target: ComputerTarget }
export type ComputerTargets = { ok: boolean; apps?: ComputerApp[]; windows?: ComputerWindow[]; error?: string };

/** Only an explicit leading token selects the lane. Quoted, embedded and path mentions stay prose. */
export function computerRequest(text: string): string | null {
  const match = /^@cu(?:[ \t\r\n]+|$)/i.exec(text);
  return match ? text.slice(match[0].length).trim() : null;
}
export function computerCompletion(text: string, caret: number): boolean {
  return /^@(?:c|cu)?$/i.test(text.slice(0, caret)) && !/^\w/.test(text.slice(caret));
}
export function isComputerRoute(value: unknown): value is ComputerRoute {
  const v = value as ComputerRoute | null;
  return !!v && (v.mode === undefined || ['do', 'guide', 'teach'].includes(v.mode)) && v.kind === 'computer-use'
    && (v.request === undefined || (typeof v.request === 'string' && /^[a-f\d-]{36}$/.test(v.request)))
    && !(v.request && v.target)
    && (v.target === undefined || (typeof v.target?.token === 'string' && /^[a-f\d-]{36}$/.test(v.target.token)
      && typeof v.target.label === 'string' && v.target.label.length <= 500));
}

export interface ComputerRunState {
  revision: string; mode: ComputerMode; phase: 'approval' | 'running' | 'paused' | 'takeover' | 'waiting-user' | 'verification' | 'complete' | 'stopped' | 'failed';
  target: string; step?: string; progress?: string; expected?: string;
  candidates?: Array<{ role: string; value: string }>;
  approval?: { application: string; operation: string };
  recipe?: string; saved?: string; reason?: string;
}
export type ComputerControl = 'pause' | 'takeover' | 'resume' | 'check' | 'correct' | 'stop' | 'allow' | 'deny';
