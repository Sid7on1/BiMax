import { stateDir } from '../utils/state.dir';
import * as fs from 'fs';
import * as path from 'path';

export interface LoopPattern {
  kind: 'loop';
  type: string;
  tool: string;
  argsHash: string;
  severity: 'soft' | 'hard';
  ts: string;
}

export interface VerificationPattern {
  kind: 'verification_fail';
  what: string;
  reason: string;
  ts: string;
}

export interface SpeculatePattern {
  kind: 'speculate_winner';
  task: string;
  approach: string;
  approachIndex: number;
  ts: string;
}

export type GenomePattern = LoopPattern | VerificationPattern | SpeculatePattern;

/**
 * Genome Pattern Store — append-only JSONL log of runtime signals used to
 * guide future self-evolution. Written to <projectRoot>/.bimax/genome-patterns.jsonl.
 * Soft-disabled: writes are silently swallowed if the directory does not exist.
 */
export class GenomePatternStore {
  private logPath: string;

  constructor(projectRoot: string) {
    this.logPath = path.join(stateDir('.bimax', projectRoot), 'genome-patterns.jsonl');
  }

  private write(record: GenomePattern): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch { /* never throw — signal logging is best-effort */ }
  }

  appendLoopSignal(type: string, tool: string, argsHash: string, severity: 'soft' | 'hard'): void {
    this.write({ kind: 'loop', type, tool, argsHash, severity, ts: new Date().toISOString() });
  }

  appendVerificationFail(what: string, reason: string): void {
    this.write({ kind: 'verification_fail', what, reason, ts: new Date().toISOString() });
  }

  appendSpeculateWinner(task: string, approach: string, approachIndex: number): void {
    this.write({ kind: 'speculate_winner', task, approach, approachIndex, ts: new Date().toISOString() });
  }

  getRecentPatterns(n = 50): GenomePattern[] {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }
}

// Module-level singleton set by the container at startup
let _store: GenomePatternStore | null = null;
export function setGlobalPatternStore(s: GenomePatternStore): void { _store = s; }
export function getGlobalPatternStore(): GenomePatternStore | null { return _store; }
