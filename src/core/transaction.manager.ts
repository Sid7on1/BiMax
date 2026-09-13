import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Logger } from '../utils/logger';

/**
 * Atomic multi-file edit transactions (`/tx`).
 *
 * The pre-edit state of a path is a THREE-state value, not a string:
 *
 *   - `file`       — the path held these exact bytes. Rollback restores them.
 *   - `absent`     — nothing was there. Rollback deletes what the transaction created.
 *   - `unreadable` — the path exists but its bytes could not be captured (permissions, a
 *                    directory, a file past the snapshot ceiling). Rollback restores NOTHING and
 *                    says so; the transaction never protected that path.
 *
 * The previous implementation collapsed all three onto `originalContent: string` and used `''` to
 * mean "absent", so rollback DELETED an existing zero-byte file and treated an unreadable file as
 * a new one. It also blind-wrote the snapshot back, destroying any edit a human made after the
 * agent's write, and cleared its own records before restoring, so a failed restore lost the only
 * copy of the original bytes. Reproduced 2026-09-07 in
 * `docs/product-reset/competitive/evidence/2026-09-08-plan-recheck/transaction-result.json`.
 *
 * Conflict policy (explicit): rollback only writes over an on-disk state this transaction itself
 * produced — the recorded baseline, or one of the contents a caller declared it was about to
 * write. Anything else means somebody changed the file after we did; that content is KEPT, the
 * path is reported as a conflict, and the pre-transaction bytes are saved under
 * `.breakglass/transactions/<id>/` so the original is still recoverable. `rollback({ force: true })`
 * overrides that deliberately.
 *
 * That check depends on callers declaring what they write, so the default for a caller that does
 * NOT declare is strict: every changed path becomes a conflict and nothing is restored. It is the
 * deliberate trade. Permissive-by-default would mean a forgotten argument silently reintroduces
 * exactly the defect this module was rewritten to remove — an agent rollback erasing somebody's
 * later edit. Strict-by-default degrades instead into "your bytes were kept and here is why",
 * which the receipt says out loud and `trackEdit` warns about at the time of the call. Every
 * in-tree caller (edit, multiedit, symbol-edit, write and delete tools) declares its intent.
 */

/** Bytes are held in memory for the length of a transaction; refuse to snapshot past this. */
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Token for "this path holds nothing", used alongside `sha256:<hex>` content tokens. */
const ABSENT = 'absent';

export type BaselineKind = 'file' | 'absent' | 'unreadable';

export interface Baseline {
  kind: BaselineKind;
  /** Present only for `file`. */
  bytes?: Buffer;
  /** Present only for `file`. */
  sha256?: string;
  /** Present only for `file` — restored with the content so a mode change does not survive. */
  mode?: number;
  size?: number;
  /** True when the path itself is a symlink; restoring writes THROUGH it, never replacing it. */
  viaSymlink?: boolean;
  /** Present only for `unreadable` — why the bytes are not held. */
  error?: string;
  code?: string;
}

/**
 * What the caller is about to leave on disk: the exact content for a write, `null` for a delete,
 * `undefined` when the caller does not say. An undeclared intent cannot be verified at rollback,
 * so the receipt marks that path unverified.
 */
export type MutationIntent = string | Uint8Array | null | undefined;

export interface TrackResult {
  /** False when no transaction is open — the call was a no-op. */
  tracked: boolean;
  baseline: BaselineKind;
  /** False for an `unreadable` baseline: rollback cannot put this path back. */
  protectedByTx: boolean;
  /** Set when `protectedByTx` is false — the reason, for the caller to surface. */
  message?: string;
}

export type RestoreStatus =
  /** Baseline bytes were written back over different content. */
  | 'restored'
  /** Baseline file was gone (the transaction deleted it) and has been re-created. */
  | 'recreated'
  /** Baseline was absent; the file this transaction created has been deleted. */
  | 'removed'
  /** On-disk state already equalled the baseline; nothing was written. */
  | 'unchanged'
  /** On-disk state was not produced by this transaction; it was KEPT, not overwritten. */
  | 'conflict'
  /** Baseline was never captured (unreadable); nothing to restore. */
  | 'unprotected'
  /** Restoration was attempted and failed; the baseline bytes are retained. */
  | 'failed';

export interface RestoreEntry {
  absPath: string;
  status: RestoreStatus;
  /** False when the caller never declared what it was writing, so the state could not be verified. */
  verified: boolean;
  detail?: string;
  /** Where the pre-transaction bytes were retained, for `conflict` and `failed`. */
  recoveryPath?: string;
}

export interface RollbackResult {
  id: string;
  message: string;
  entries: RestoreEntry[];
  /** Entries that can be retried by `recover()`. */
  pending: number;
}

interface EditRecord {
  absPath: string;
  baseline: Baseline;
  /** Every state this transaction declared it would leave: `sha256:<hex>` tokens and/or ABSENT. */
  expected: Set<string>;
  /** False when no caller ever declared an intent for this path. */
  intentDeclared: boolean;
}

interface RetainedRecovery {
  id: string;
  dir: string | null;
  records: EditRecord[];
}

interface TransactionManagerOptions {
  /** Root under which `.breakglass/transactions/<id>/` is written. Defaults to the process cwd. */
  recoveryRoot?: string;
  maxSnapshotBytes?: number;
}

function contentToken(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function toBuffer(intent: string | Uint8Array): Buffer {
  return typeof intent === 'string' ? Buffer.from(intent, 'utf8') : Buffer.from(intent);
}

export class TransactionManager {
  private openTx: { id: string; edits: EditRecord[] } | null = null;
  private rollingBack = false;
  /** Baselines that rollback could not put back, kept so the bytes are not lost with the process. */
  private retained: RetainedRecovery | null = null;

  private readonly recoveryRoot?: string;
  private readonly maxSnapshotBytes: number;

  constructor(options: TransactionManagerOptions = {}) {
    this.recoveryRoot = options.recoveryRoot;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  }

  isOpen(): boolean {
    return this.openTx !== null;
  }

  currentId(): string | null {
    return this.openTx?.id ?? null;
  }

  /** Paths whose pre-transaction bytes are still held after a failed restoration. */
  pendingRecovery(): { id: string; paths: string[]; dir: string | null } | null {
    if (!this.retained || this.retained.records.length === 0) return null;
    return {
      id: this.retained.id,
      paths: this.retained.records.map(r => r.absPath),
      dir: this.retained.dir,
    };
  }

  begin(id: string): string {
    if (this.openTx) {
      return `Transaction ${this.openTx.id} is already open. Commit or rollback it first.`;
    }
    this.openTx = { id, edits: [] };
    Logger.info(`[TX] Opened transaction ${id}`);
    return `Transaction ${id} opened. All file edits until /tx commit are tracked for atomic rollback.`;
  }

  /**
   * Called by the mutating tools BEFORE writing — captures the pre-edit state for rollback.
   *
   * `intent` is what the caller is about to leave on disk (content, or `null` for a delete). It is
   * what makes a later third-party edit detectable at rollback time: a state that is neither the
   * baseline nor something we declared came from somebody else. Omitting it does not break
   * rollback, but that path is then restored unverified and the receipt says so.
   */
  async trackEdit(absPath: string, intent?: MutationIntent): Promise<TrackResult> {
    if (!this.openTx) return { tracked: false, baseline: 'absent', protectedByTx: false };
    const key = path.resolve(absPath);
    // `undefined` means the caller did not say; `null` means "this path will be gone".
    const intentGiven = intent !== undefined;

    const existing = this.openTx.edits.find(e => e.absPath === key);
    if (existing) {
      // Only the FIRST pre-edit snapshot is the baseline, but every declared write counts as a
      // state this transaction produced — otherwise a second edit to the same file would look
      // like somebody else's change at rollback time.
      if (intentGiven) {
        existing.intentDeclared = true;
        existing.expected.add(intent === null ? ABSENT : contentToken(toBuffer(intent)));
      }
      return {
        tracked: true,
        baseline: existing.baseline.kind,
        protectedByTx: existing.baseline.kind !== 'unreadable',
        message: existing.baseline.error,
      };
    }

    const baseline = await this.capture(key);
    const expected = new Set<string>();
    if (intentGiven) {
      expected.add(intent === null ? ABSENT : contentToken(toBuffer(intent)));
    }
    this.openTx.edits.push({ absPath: key, baseline, expected, intentDeclared: intentGiven });

    if (baseline.kind === 'unreadable') {
      Logger.warn(`[TX] ${this.openTx.id}: ${key} is NOT protected — ${baseline.error}`);
      return { tracked: true, baseline: 'unreadable', protectedByTx: false, message: baseline.error };
    }
    if (!intentGiven) {
      // Say it here, where the caller is, rather than only in a rollback receipt nobody may read.
      Logger.warn(
        `[TX] ${this.openTx.id}: ${key} was tracked without a declared write. Rollback cannot tell ` +
        `this transaction's own change from an external one, so it will keep whatever is on disk.`
      );
    }
    return { tracked: true, baseline: baseline.kind, protectedByTx: true };
  }

  commit(): string {
    if (!this.openTx) return 'No open transaction to commit.';
    const id = this.openTx.id;
    const count = this.openTx.edits.length;
    const unprotected = this.openTx.edits.filter(e => e.baseline.kind === 'unreadable');
    this.openTx = null;
    Logger.info(`[TX] Committed ${id} (${count} file(s))`);
    const msg = [`Transaction ${id} committed (${count} file(s) changed).`];
    if (unprotected.length) {
      msg.push(
        `${unprotected.length} path(s) were never protected by this transaction (pre-edit content unreadable): ` +
        unprotected.map(e => `${e.absPath} — ${e.baseline.error}`).join('; ')
      );
    }
    return msg.join('\n');
  }

  async rollback(options: { force?: boolean } = {}): Promise<string> {
    return (await this.rollbackDetailed(options)).message;
  }

  /** Same as `rollback`, with the per-path outcomes the receipt is built from. */
  async rollbackDetailed(options: { force?: boolean } = {}): Promise<RollbackResult> {
    if (this.rollingBack) {
      return { id: '', message: 'A rollback is already in progress.', entries: [], pending: 0 };
    }
    if (!this.openTx) {
      return { id: '', message: 'No open transaction to roll back.', entries: [], pending: 0 };
    }
    const { id, edits } = this.openTx;
    // Stop tracking new edits into a transaction that is being undone, but keep the records: they
    // hold the only copy of the original bytes until every path is actually back.
    this.openTx = null;
    this.rollingBack = true;

    const entries: RestoreEntry[] = [];
    const keep: EditRecord[] = [];
    try {
      for (const record of [...edits].reverse()) {
        const entry = await this.restoreOne(record, options.force === true);
        entries.push(entry);
        if (entry.status === 'failed' || entry.status === 'conflict') keep.push(record);
      }
      const dir = keep.length ? await this.retainBaselines(id, keep, entries) : null;
      this.retained = keep.length ? { id, dir, records: keep } : null;
    } finally {
      this.rollingBack = false;
    }

    return {
      id,
      message: this.receipt(id, entries),
      entries,
      pending: entries.filter(e => e.status === 'failed').length,
    };
  }

  /**
   * Retry the paths a rollback could not restore. Conflicts are NOT retried — they were kept on
   * purpose; their pre-transaction bytes are in the retained directory for a human to apply.
   */
  async recover(): Promise<string> {
    if (!this.retained || this.retained.records.length === 0) return 'Nothing is pending recovery.';
    const { id, records } = this.retained;
    const entries: RestoreEntry[] = [];
    const keep: EditRecord[] = [];
    for (const record of records) {
      const entry = await this.restoreOne(record, false);
      entries.push(entry);
      if (entry.status === 'failed' || entry.status === 'conflict') keep.push(record);
    }
    this.retained = keep.length ? { id, dir: this.retained.dir, records: keep } : null;
    return `Recovery of transaction ${id}: ${this.receipt(id, entries)}`;
  }

  /** Called on a mutating tool's failure while a transaction is open — auto-rollback. */
  async autoRollback(failedPath: string, reason: string): Promise<string> {
    if (!this.openTx) return '';
    const txId = this.openTx.id;
    const rollbackMsg = await this.rollback();
    return `Edit to ${failedPath} failed (${reason}). Auto-rolled back transaction ${txId}.\n${rollbackMsg}`;
  }

  // ---------------------------------------------------------------------------------------------

  /** Read the pre-edit state. Missing, empty and unreadable are three different answers. */
  private async capture(absPath: string): Promise<Baseline> {
    let viaSymlink = false;
    try {
      const link = await fs.lstat(absPath);
      viaSymlink = link.isSymbolicLink();
    } catch {
      /* resolved below by stat */
    }
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        return { kind: 'unreadable', error: `not a regular file (${st.isDirectory() ? 'directory' : 'special file'})`, code: 'ENOTFILE', viaSymlink };
      }
      if (st.size > this.maxSnapshotBytes) {
        return {
          kind: 'unreadable',
          error: `too large to snapshot (${st.size} bytes > ${this.maxSnapshotBytes} byte limit)`,
          code: 'EFBIG',
          size: st.size,
          viaSymlink,
        };
      }
      const bytes = await fs.readFile(absPath);
      return { kind: 'file', bytes, sha256: contentToken(bytes), mode: st.mode & 0o7777, size: bytes.length, viaSymlink };
    } catch (e: any) {
      // ENOENT is the ONLY error that means "nothing was here". Everything else is a file we
      // failed to read, and deleting it on rollback would destroy content we never captured.
      if (e?.code === 'ENOENT') return { kind: 'absent', viaSymlink };
      return { kind: 'unreadable', error: `${e?.code || 'read failed'}: ${e?.message ?? String(e)}`, code: e?.code, viaSymlink };
    }
  }

  private async restoreOne(record: EditRecord, force: boolean): Promise<RestoreEntry> {
    const { absPath, baseline, expected, intentDeclared } = record;
    const verified = intentDeclared;

    if (baseline.kind === 'unreadable') {
      return {
        absPath,
        status: 'unprotected',
        verified,
        detail: `pre-transaction content was never captured (${baseline.error}); nothing was restored`,
      };
    }

    const current = await this.capture(absPath);
    if (current.kind === 'unreadable') {
      // We cannot see what is there now, so we cannot prove it is ours to overwrite.
      return {
        absPath,
        status: force ? await this.forceStatus(record) : 'conflict',
        verified,
        detail: force
          ? `overwrote an unreadable current state (${current.error}) because --force was given`
          : `current content could not be read (${current.error}); it was left alone`,
      };
    }

    const baselineToken = baseline.kind === 'absent' ? ABSENT : baseline.sha256!;
    const currentToken = current.kind === 'absent' ? ABSENT : current.sha256!;

    if (currentToken === baselineToken) {
      return { absPath, status: 'unchanged', verified, detail: 'already matched the pre-transaction state' };
    }

    // Strict by design: we overwrite ONLY a state this transaction declared it would produce.
    // A caller that does not declare its writes gets a conflict rather than a blind overwrite, so
    // dropping the intent argument degrades into "keep the user's bytes", never into losing them.
    // A torn write (the process died mid-write, leaving neither state) also lands here: the file is
    // kept, the original is retained on disk, and `/tx rollback --force` applies it deliberately.
    const producedByUs = expected.has(currentToken);
    if (!producedByUs && !force) {
      return {
        absPath,
        status: 'conflict',
        verified,
        detail: intentDeclared
          ? 'changed after this transaction wrote it; the newer content was kept'
          : 'the caller never declared what it wrote, so this content could not be attributed to this transaction; it was kept',
      };
    }

    try {
      if (baseline.kind === 'absent') {
        await fs.rm(absPath, { force: true });
        const after = await this.capture(absPath);
        if (after.kind !== 'absent') throw new Error('file still present after removal');
        return { absPath, status: 'removed', verified, detail: force && !producedByUs ? 'forced' : undefined };
      }
      await this.writeBack(absPath, baseline);
      const after = await this.capture(absPath);
      if (after.kind !== 'file' || after.sha256 !== baseline.sha256) {
        throw new Error(`read-back mismatch after restoring ${absPath}`);
      }
      return {
        absPath,
        status: current.kind === 'absent' ? 'recreated' : 'restored',
        verified,
        detail: force && !producedByUs ? 'forced over a newer change' : undefined,
      };
    } catch (e: any) {
      Logger.error(`[TX] Rollback failed for ${absPath}: ${e?.message ?? e}`);
      return { absPath, status: 'failed', verified, detail: e?.message ?? String(e) };
    }
  }

  private async forceStatus(record: EditRecord): Promise<RestoreStatus> {
    try {
      if (record.baseline.kind === 'absent') {
        await fs.rm(record.absPath, { force: true });
        return 'removed';
      }
      await this.writeBack(record.absPath, record.baseline);
      return 'restored';
    } catch (e: any) {
      Logger.error(`[TX] Forced rollback failed for ${record.absPath}: ${e?.message ?? e}`);
      return 'failed';
    }
  }

  /**
   * Replace the file's bytes. A same-directory temp file plus rename means a crash mid-restore
   * leaves the old content, never a half-written file — except through a symlink, where a rename
   * would silently replace the LINK with a regular file, so that case writes in place.
   */
  private async writeBack(absPath: string, baseline: Baseline): Promise<void> {
    const bytes = baseline.bytes!;
    let isLink = baseline.viaSymlink === true;
    try {
      isLink = (await fs.lstat(absPath)).isSymbolicLink();
    } catch {
      /* gone; fall back to the captured answer */
    }
    if (isLink) {
      await fs.writeFile(absPath, bytes);
      if (baseline.mode !== undefined) await fs.chmod(absPath, baseline.mode).catch(() => {});
      return;
    }
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(absPath)}.bimax-tx-${randomBytes(6).toString('hex')}`);
    try {
      await fs.writeFile(tmp, bytes);
      if (baseline.mode !== undefined) await fs.chmod(tmp, baseline.mode);
      await fs.rename(tmp, absPath);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Put the still-unrestored baselines somewhere they survive this process, and tell each entry
   * where its copy went. Best-effort: a read-only workspace must not turn into a thrown rollback.
   */
  private async retainBaselines(id: string, keep: EditRecord[], entries: RestoreEntry[]): Promise<string | null> {
    const dir = path.join(this.recoveryRoot ?? process.cwd(), '.breakglass', 'transactions', id);
    try {
      await fs.mkdir(dir, { recursive: true });
      const manifest: object[] = [];
      for (let i = 0; i < keep.length; i++) {
        const record = keep[i];
        const entry = entries.find(e => e.absPath === record.absPath);
        let saved: string | undefined;
        if (record.baseline.kind === 'file') {
          saved = path.join(dir, `${String(i).padStart(3, '0')}-${path.basename(record.absPath)}`);
          await fs.writeFile(saved, record.baseline.bytes!);
          if (entry) entry.recoveryPath = saved;
        }
        manifest.push({
          absPath: record.absPath,
          baseline: record.baseline.kind,
          sha256: record.baseline.sha256 ?? null,
          mode: record.baseline.mode ?? null,
          status: entry?.status ?? 'failed',
          savedAs: saved ?? null,
        });
      }
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ schema: 1, transaction: id, savedAt: new Date().toISOString(), paths: manifest }, null, 2) + '\n'
      );
      return dir;
    } catch (e: any) {
      Logger.error(`[TX] Could not retain rollback baselines for ${id} in ${dir}: ${e?.message ?? e}`);
      return null;
    }
  }

  private receipt(id: string, entries: RestoreEntry[]): string {
    const of = (s: RestoreStatus) => entries.filter(e => e.status === s);
    const restored = [...of('restored'), ...of('recreated')];
    const removed = of('removed');
    const unchanged = of('unchanged');
    const conflicts = of('conflict');
    const unprotected = of('unprotected');
    const failed = of('failed');

    const summary = [
      `${restored.length} restored`,
      `${removed.length} removed`,
      `${unchanged.length} already matched`,
      `${conflicts.length} kept (changed after this transaction)`,
      `${unprotected.length} unprotected`,
      `${failed.length} failed`,
    ].join(', ');
    const msg = [`Transaction ${id} rolled back — ${entries.length} path(s): ${summary}.`];

    const list = (label: string, rows: RestoreEntry[]) => {
      if (!rows.length) return;
      msg.push(`${label}: ${rows.map(r => r.absPath + (r.detail ? ` (${r.detail})` : '')).join('; ')}`);
    };
    list('Restored', restored);
    list('Removed (created by this transaction)', removed);
    list('Unchanged', unchanged);
    list('KEPT — not overwritten', conflicts);
    list('NOT protected — no pre-transaction content was captured', unprotected);
    list('FAILED to restore', failed);

    const unverified = entries.filter(e => !e.verified && e.status !== 'unprotected');
    if (unverified.length) {
      msg.push(
        `Unverified (the caller did not declare what it wrote, so a later external change could not be detected): ` +
        unverified.map(r => r.absPath).join(', ')
      );
    }
    const withCopies = entries.filter(e => e.recoveryPath);
    if (withCopies.length) {
      msg.push(`Pre-transaction content retained at: ${withCopies.map(r => r.recoveryPath).join(', ')}`);
    }
    if (failed.length) msg.push('Run /tx recover to retry the failed paths.');
    return msg.join('\n');
  }
}

export const globalTransactionManager = new TransactionManager();
