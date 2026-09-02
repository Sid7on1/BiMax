/**
 * The append-only record of every outbound network attempt this product made.
 *
 * ## What it is for
 *
 * PS-grade sovereignty is not a statement, it is an artefact someone else can read. A packet
 * capture proves what crossed the wire during the minutes it was running; this ledger proves what
 * the application *tried*, continuously, with the caller and purpose attached — which is the part a
 * capture cannot tell you. The two are complementary and the demo shows both.
 *
 * ## Why allowed calls are recorded too
 *
 * A ledger of refusals answers "what did we block?" — a question nobody asks at an audit. The
 * question asked is "what did you send, and to whom?", so an allowed loopback call to the local
 * model server is recorded with the same weight as a refused one. The report's headline number is
 * therefore honest by construction: `142 attempts · 142 loopback · 0 external`.
 *
 * ## Append-only, and what that does and does not mean
 *
 * Entries are appended as NDJSON and never rewritten in place: one line per attempt, so a truncated
 * write costs the last line and not the file. This is tamper-EVIDENT at the application level, not
 * tamper-PROOF — anything with write access to the file can edit it, and claiming otherwise would
 * be the same species of overstatement this module exists to prevent. Making it genuinely
 * append-only is the operating system's job (`chattr +a`, a log shipper, an audit mount), and the
 * deployment guide is where that belongs.
 *
 * The file lives beside the existing logs (`.breakglass/` in the workspace, per `utils/logger.ts`)
 * and is created 0600 inside a 0700 directory, because it records hostnames and purposes from
 * confidential work.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Destination } from './sovereign';

export interface EgressEntry {
  /** ISO-8601, UTC. */
  at: string;
  host: string;
  destination: Destination;
  verdict: 'allowed' | 'refused';
  /** Who attempted it — `LlmAdapter`, `WebFetchTool`, `RemoteEmbeddingBackend`, … */
  subsystem: string;
  purpose?: string;
  /** True when sovereign mode was active for this attempt. A verdict is only meaningful with it. */
  sovereign: boolean;
}

/** In-memory mirror of what this process appended, so `/sovereign` can report without re-reading. */
const session: EgressEntry[] = [];

/** Bounded: a long autonomous run must not turn the report into a memory leak. */
const SESSION_CAP = 5_000;

export function ledgerPath(): string {
  const override = process.env.BIMAX_EGRESS_LEDGER;
  if (override) return override;
  return path.join(process.cwd(), '.breakglass', 'egress.ledger');
}

/**
 * Append one attempt. Never throws: a ledger that can crash the turn it is auditing would be a
 * reason to switch auditing off, and an unwritable disk is not evidence about the network. A write
 * failure degrades to the in-memory mirror, and {@link ledgerWriteFailures} reports the count so
 * the CLI can say the file is incomplete instead of implying it is complete.
 */
let writeFailures = 0;

export function recordEgress(entry: EgressEntry): void {
  session.push(entry);
  if (session.length > SESSION_CAP) session.splice(0, session.length - SESSION_CAP);
  try {
    const file = ledgerPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    writeFailures += 1;
  }
}

export function ledgerWriteFailures(): number {
  return writeFailures;
}

/** Everything this process recorded, oldest first. */
export function sessionEgress(): readonly EgressEntry[] {
  return session;
}

/** Test seam and `/reset` hook. Does not touch the file — a session reset is not an audit reset. */
export function resetSessionEgress(): void {
  session.length = 0;
  writeFailures = 0;
}

export interface EgressSummary {
  attempts: number;
  loopback: number;
  privateLan: number;
  allowlisted: number;
  external: number;
  refused: number;
  /** Distinct external hosts, for the line an auditor reads first. */
  externalHosts: string[];
  writeFailures: number;
}

export function summarize(entries: readonly EgressEntry[] = session): EgressSummary {
  const externalHosts = new Set<string>();
  let loopback = 0, privateLan = 0, allow = 0, external = 0, refused = 0;
  for (const e of entries) {
    if (e.destination === 'loopback') loopback += 1;
    else if (e.destination === 'private-lan') privateLan += 1;
    else if (e.destination === 'allowlisted') allow += 1;
    else { external += 1; externalHosts.add(e.host); }
    if (e.verdict === 'refused') refused += 1;
  }
  return {
    attempts: entries.length,
    loopback,
    privateLan,
    allowlisted: allow,
    external,
    refused,
    externalHosts: [...externalHosts].sort(),
    writeFailures,
  };
}

/**
 * Read back what is on disk. Used by `bimax sovereign report` so the proof covers previous runs,
 * not only the current process. A malformed line is skipped and counted rather than aborting the
 * read — a partially written last line must not make the whole ledger unreadable.
 */
export function readLedger(file = ledgerPath()): { entries: EgressEntry[]; skipped: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: EgressEntry[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as EgressEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}
