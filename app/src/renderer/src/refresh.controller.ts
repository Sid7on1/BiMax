/**
 * Single-flight, generation-fenced background refresh.
 *
 * The git-status poller fires on a 4-second interval AND on every filesystem-change broadcast, and
 * a `git checkout` or a branch switch produces a burst of both. Before this, each of those went
 * straight to `git.status()`, so a burst started as many overlapping `git status` + two
 * `git diff --numstat` processes as it had events — on a large repository they queue behind each
 * other and the last answer is the only one anybody wanted. Worse, `then(setStatus)` accepted
 * whatever came back: switch projects while a slow read is in flight and the OLD project's status
 * lands on the NEW project's screen, showing a branch and a file list that belong to somewhere else.
 *
 * Two mechanisms, both here so they can be tested without a renderer:
 *
 *  - **Single flight with a dirty flag.** One request is in flight at a time. Anything asked for
 *    while it runs sets a dirty bit; when the in-flight request settles, exactly ONE follow-up runs.
 *    A hundred events during one slow read produce two reads, not a hundred, and the final state is
 *    still current because the follow-up happens after the last event.
 *  - **A monotonic project generation.** Main stamps every reply with the project it was computed
 *    against and the generation of that project's session, captured before it started reading. A
 *    reply for a different project, or for a generation older than the newest one seen, is dropped
 *    and counted. The fence floor only ever rises, so a project reopened later cannot be confused
 *    with the earlier visit to it.
 *
 * The 4-second poll stays: it is the slow reconciliation path for changes the watcher cannot see
 * (commits made in the embedded terminal, `.git` metadata, another worktree).
 */

export interface ProjectStamp {
  project: string;
  generation: number;
}

export type DropReason =
  | 'different-project'
  | 'retired-generation'
  | 'issued-before-current-generation'
  | 'disposed';

/**
 * Tracks the newest project generation this renderer has heard about. The floor only rises, so a
 * late reply can never re-open a retired project's state.
 */
export class GenerationFence {
  private floor = -1;

  get generation(): number { return this.floor; }

  /** Raise the floor. Ignores anything that is not a finite number, or that would lower it. */
  raiseTo(generation: unknown): boolean {
    if (typeof generation !== 'number' || !Number.isFinite(generation)) return false;
    if (generation <= this.floor) return false;
    this.floor = generation;
    return true;
  }

  /**
   * Decide whether a reply may be delivered.
   *
   * `stamp` is what main said the reply describes; `issuedAtGeneration` is the fence value when the
   * request went out, which is the only thing available when a reply carries no stamp (a `null`
   * status from a directory that is not a git repository, for instance).
   */
  deliverable(
    stamp: ProjectStamp | null,
    expectedProject: string,
    issuedAtGeneration: number,
  ): { ok: true } | { ok: false; reason: DropReason } {
    if (stamp) {
      if (stamp.project !== expectedProject) return { ok: false, reason: 'different-project' };
      if (stamp.generation < this.floor) return { ok: false, reason: 'retired-generation' };
      this.raiseTo(stamp.generation);
      return { ok: true };
    }
    // Unstamped: all we can check is that nothing has moved since the request was issued.
    if (issuedAtGeneration !== this.floor) return { ok: false, reason: 'issued-before-current-generation' };
    return { ok: true };
  }
}

export interface RefreshStats {
  /** Every call to `request()`, whatever happened to it. */
  requested: number;
  /** Requests that actually reached the fetch function. */
  issued: number;
  /** Requests folded into an in-flight one by the dirty flag. */
  coalesced: number;
  /** Replies that arrived for a retired project or generation. */
  droppedStale: number;
  /** Fetches that threw. */
  failed: number;
  inFlight: boolean;
  dirty: boolean;
  /** Drop reasons, most recent last, bounded. */
  drops: DropReason[];
}

export interface SingleFlightRefreshOptions<T> {
  /** The project this controller belongs to. A reply stamped with anything else is dropped. */
  expectedProject: string;
  fetch: () => Promise<T | null>;
  /** Pull the stamp out of a reply, or null when the reply carries none. */
  stampOf: (value: T) => ProjectStamp | null;
  /** Called only with results that survived the fence. */
  onResult: (value: T | null) => void;
  /** Optional observer for a failed fetch; the controller still delivers null. */
  onError?: (error: unknown) => void;
}

const MAX_RECORDED_DROPS = 20;

export class SingleFlightRefresh<T> {
  private readonly options: SingleFlightRefreshOptions<T>;
  private readonly fence = new GenerationFence();
  private running = false;
  private dirty = false;
  private disposed = false;
  private stats: RefreshStats = {
    requested: 0, issued: 0, coalesced: 0, droppedStale: 0, failed: 0,
    inFlight: false, dirty: false, drops: [],
  };

  constructor(options: SingleFlightRefreshOptions<T>) {
    this.options = options;
  }

  /** Tell the controller which generation is live now (from `app:project` or a change broadcast). */
  setGeneration(generation: unknown): void {
    this.fence.raiseTo(generation);
  }

  get generation(): number { return this.fence.generation; }

  /**
   * Ask for a refresh. Returns true when this call started a fetch, false when it was folded into
   * one already running (or the controller is disposed).
   */
  request(): boolean {
    if (this.disposed) return false;
    this.stats.requested++;
    if (this.running) {
      // One dirty bit, not a queue: however many events arrive during a slow read, exactly one
      // follow-up runs afterwards, and it runs after the last of them.
      this.dirty = true;
      this.stats.coalesced++;
      this.snapshotFlags();
      return false;
    }
    void this.run();
    return true;
  }

  private async run(): Promise<void> {
    this.running = true;
    this.stats.issued++;
    this.snapshotFlags();
    const issuedAtGeneration = this.fence.generation;
    try {
      const value = await this.options.fetch();
      this.deliver(value, issuedAtGeneration);
    } catch (error) {
      this.stats.failed++;
      this.options.onError?.(error);
      // A failure is still an answer about THIS project; deliver it under the same fence so a
      // failed read of the old project cannot blank the new project's status.
      this.deliver(null, issuedAtGeneration);
    } finally {
      this.running = false;
      if (this.dirty && !this.disposed) {
        this.dirty = false;
        this.snapshotFlags();
        void this.run();
      } else {
        this.snapshotFlags();
      }
    }
  }

  private deliver(value: T | null, issuedAtGeneration: number): void {
    if (this.disposed) { this.recordDrop('disposed'); return; }
    const stamp = value === null ? null : this.options.stampOf(value);
    const verdict = this.fence.deliverable(stamp, this.options.expectedProject, issuedAtGeneration);
    if (!verdict.ok) { this.recordDrop(verdict.reason); return; }
    this.options.onResult(value);
  }

  private recordDrop(reason: DropReason): void {
    this.stats.droppedStale++;
    this.stats.drops.push(reason);
    if (this.stats.drops.length > MAX_RECORDED_DROPS) this.stats.drops.shift();
  }

  private snapshotFlags(): void {
    this.stats.inFlight = this.running;
    this.stats.dirty = this.dirty;
  }

  /** Stop delivering. An in-flight fetch is allowed to settle; its result is dropped. */
  dispose(): void {
    this.disposed = true;
    this.dirty = false;
    this.snapshotFlags();
  }

  snapshot(): RefreshStats {
    return { ...this.stats, drops: [...this.stats.drops] };
  }
}
