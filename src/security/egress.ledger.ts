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
 * write costs the last line and not the file.
 *
 * Each entry also carries the digest of the entry before it. That is what makes "append-only" a
 * property a READER can check rather than a description of how we happen to write: editing a line,
 * deleting one, or inserting one breaks every digest after it, and {@link verifyLedger} names the
 * first position that failed. Without the chain the file was tamper-evident in name only — the
 * lines were independent, so removing the one that recorded a leak left a file that still parsed
 * and still verified against nothing.
 *
 * It is tamper-EVIDENT, not tamper-PROOF, and the distinction is not pedantry. Anything with write
 * access can rewrite the whole file and recompute every digest, and that forgery verifies clean.
 * The chain raises the cost from "edit one line" to "rewrite the entire history consistently"; the
 * only thing that closes the rest of the gap is the head digest recorded somewhere this process
 * cannot reach, which is why {@link ledgerHead} is printed by `/sovereign verify` for an evaluator
 * to write down. Making the file genuinely append-only is the operating system's job (`chattr +a`,
 * a log shipper, an audit mount), and the deployment guide is where that belongs.
 *
 * The file lives beside the existing logs (`.breakglass/` in the workspace, per `utils/logger.ts`)
 * and is created 0600 inside a 0700 directory, because it records hostnames and purposes from
 * confidential work.
 */

import { stateDir } from '../utils/state.dir';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Destination } from './sovereign';
import { canonicalJson } from '../evidence/schema';

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
  /**
   * The digest of the entry before this one — `null` at the head of a chain.
   *
   * This is what makes the file's "append-only" claim checkable. Without it, deleting the one line
   * that records a leak, or rewriting a host, leaves no trace: the remaining lines are individually
   * well-formed and the file still parses. Linking each entry to its predecessor means any edit,
   * deletion or insertion breaks every digest after it, and {@link verifyLedger} names the first
   * position that failed.
   */
  prev?: string | null;
  /** sha256 over this entry's canonical form excluding `digest` itself. */
  digest?: string;
}

/** The bytes an entry's digest is computed over: the entry without its own `digest`. */
function digestPayload(entry: EgressEntry): string {
  const { digest: _ignored, ...rest } = entry;
  return canonicalJson(rest);
}

export function entryDigest(entry: EgressEntry): string {
  return createHash('sha256').update(digestPayload(entry)).digest('hex');
}

/** In-memory mirror of what this process appended, so `/sovereign` can report without re-reading. */
const session: EgressEntry[] = [];

/** Bounded: a long autonomous run must not turn the report into a memory leak. */
const SESSION_CAP = 5_000;

export function ledgerPath(): string {
  const override = process.env.BIMAX_EGRESS_LEDGER;
  if (override) return override;
  return path.join(stateDir('.breakglass'), 'egress.ledger');
}

/**
 * Append one attempt. Never throws: a ledger that can crash the turn it is auditing would be a
 * reason to switch auditing off, and an unwritable disk is not evidence about the network. A write
 * failure degrades to the in-memory mirror, and {@link ledgerWriteFailures} reports the count so
 * the CLI can say the file is incomplete instead of implying it is complete.
 */
let writeFailures = 0;

/**
 * The digest of the last entry appended, which the next one links to.
 *
 * `undefined` means "not yet established": the first write of a process reads the tail of the file
 * so a restart continues the existing chain instead of starting a second one. `null` means the
 * chain genuinely starts here (no file, or a file whose entries predate chaining).
 */
let head: string | null | undefined = undefined;

function seedHead(): void {
  const { entries } = readLedger();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].digest) { head = entries[i].digest as string; return; }
  }
  head = null;
}

/** The current chain head — the value an evaluator records to detect a later wholesale rewrite. */
export function ledgerHead(): string | null {
  if (head === undefined) seedHead();
  return head ?? null;
}

export function recordEgress(entry: EgressEntry): void {
  if (head === undefined) seedHead();
  // Any prev/digest a caller supplied is discarded: the chain is this module's to compute, and
  // accepting one from outside would let a caller forge a link.
  const { prev: _p, digest: _d, ...clean } = entry;
  const linked: EgressEntry = { ...clean, prev: head ?? null };
  linked.digest = entryDigest(linked);
  head = linked.digest;

  session.push(linked);
  if (session.length > SESSION_CAP) session.splice(0, session.length - SESSION_CAP);
  try {
    const file = ledgerPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(linked)}\n`, { mode: 0o600 });
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
  // Forget the head too, so the next write re-seeds from whatever file is now in play. Without
  // this a test that repoints BIMAX_EGRESS_LEDGER would chain the new file's first entry onto the
  // old file's last digest, and the new chain would verify as broken at position 0.
  head = undefined;
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

export interface ChainVerification {
  /** True when every chained entry recomputes and links to the one before it. */
  intact: boolean;
  /** Entries carrying no digest because they predate chaining. Not a failure — an unproven prefix. */
  unchained: number;
  /** How many entries were actually checked. `0 checked` is not a pass; the report must say so. */
  checked: number;
  /** Position of the first entry that failed, as an index into `entries`. */
  brokenAt?: number;
  /** What specifically failed, in the terms an operator can act on. */
  reason?: string;
  /** Digest of the last verified entry. Compare against a head recorded elsewhere. */
  head: string | null;
}

/**
 * Walk the chain and report the first break.
 *
 * What this catches: editing an entry (its digest stops matching its content), deleting one (the
 * next entry's `prev` no longer names its predecessor), inserting one, and truncating the middle.
 *
 * What it does NOT catch, and the report must never imply otherwise: someone who rewrites the whole
 * file can recompute every digest, and the result verifies perfectly. The chain reduces tampering
 * from "edit one line" to "rewrite the entire file consistently", and the only thing that closes
 * the remaining gap is a head digest recorded somewhere this process cannot reach — which is why
 * {@link ledgerHead} is surfaced for an evaluator to write down.
 */
export function verifyLedger(entries: EgressEntry[] = readLedger().entries): ChainVerification {
  let unchained = 0;
  let checked = 0;
  let expectedPrev: string | null = null;
  let started = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!entry.digest) {
      // A digest-less entry is only innocent while it is still the unchained prefix. Once chaining
      // has begun, one appearing again means a digest was stripped or raw lines were appended.
      if (started) {
        return {
          intact: false, unchained, checked, brokenAt: i, head: expectedPrev,
          reason: `has no digest, but the chain had already started — a digest was `
            + 'stripped, or unchained lines were appended by something other than this process',
        };
      }
      unchained += 1;
      continue;
    }

    if (entryDigest(entry) !== entry.digest) {
      return {
        intact: false, unchained, checked, brokenAt: i, head: expectedPrev,
        reason: `does not match its own digest — its contents were changed after it `
          + 'was written',
      };
    }
    if ((entry.prev ?? null) !== expectedPrev) {
      return {
        intact: false, unchained, checked, brokenAt: i, head: expectedPrev,
        reason: `links to ${entry.prev ?? 'nothing'}, but the entry before it digests to `
          + `${expectedPrev ?? 'nothing'} — an entry was removed or inserted here`,
      };
    }

    started = true;
    checked += 1;
    expectedPrev = entry.digest;
  }

  return { intact: true, unchained, checked, head: expectedPrev };
}
