// Sends queued scrobbles in batches and retries with backoff (docs/design.md §7).
// Clock and timers are injected so the logic can be tested on Node.
import type { Scrobbler, SendResult } from "../services/types.ts";
import type { Outcome, ScrobbleQueue } from "./queue.ts";

export const RETRY_MIN_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

export interface SenderDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log: { info(msg: string): void; warn(msg: string): void };
  /** The service rejected the session (Last.fm error 9). */
  onAuthError(detail: string): void;
  /** Queue size may have changed (to refresh the menu). */
  onQueueChange(): void;
}

export class Sender {
  private readonly service: Scrobbler;
  private readonly queue: ScrobbleQueue;
  private readonly deps: SenderDeps;
  private flushing = false;
  private again = false;
  private retryDelay = 0;
  private retryTimer: unknown = null;
  private nextRetryAt: number | null = null;

  constructor(service: Scrobbler, queue: ScrobbleQueue, deps: SenderDeps) {
    this.service = service;
    this.queue = queue;
    this.deps = deps;
  }

  /** When the next automatic retry is due, if one is scheduled. */
  get retryAt(): number | null {
    return this.nextRetryAt;
  }

  /**
   * Sends everything that is queued for this service. Safe to call at any time; a call
   * during a flush makes the running flush go round once more.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.again = false;
        await this.flushOnce();
      } while (this.again && this.retryTimer === null);
    } finally {
      this.flushing = false;
      this.deps.onQueueChange();
    }
  }

  /** Forgets the backoff and sends now (menu "send now", reconnect). */
  async retryNow(): Promise<void> {
    this.cancelRetry();
    this.retryDelay = 0;
    await this.flush();
  }

  private async flushOnce(): Promise<void> {
    const expired = this.queue.pruneExpired(this.deps.now());
    if (expired.length) this.deps.log.warn(`dropped ${expired.length} queued scrobble(s) older than 14 days`);

    while (this.service.session) {
      const batch = this.queue
        .load()
        .filter((i) => i.service === this.service.id)
        .slice(0, this.service.maxBatch);
      if (batch.length === 0) {
        this.retryDelay = 0;
        return;
      }
      const results = await this.service.scrobble(batch.map((i) => i.entry));
      const outcome: Outcome = { remove: [], keep: [] };
      let retry = false;
      let authError: SendResult | null = null;
      batch.forEach((item, n) => {
        const r = results[n] ?? { status: "retry", message: "no result" };
        const what = `${item.entry.artist} - ${item.entry.track}`;
        switch (r.status) {
          case "ok":
            outcome.remove.push(item.id);
            this.deps.log.info(`scrobble ok: ${what}`);
            break;
          case "ignored":
            outcome.remove.push(item.id);
            this.deps.log.warn(`scrobble ignored by ${this.service.displayName}: ${what} (${describe(r)})`);
            break;
          case "drop":
            outcome.remove.push(item.id);
            this.deps.log.warn(`scrobble dropped: ${what} (${describe(r)})`);
            break;
          case "retry":
            retry = true;
            outcome.keep.push({ id: item.id, error: describe(r) });
            break;
          case "auth-error":
            authError = r;
            outcome.keep.push({ id: item.id, error: describe(r) });
            break;
        }
      });
      this.queue.apply(outcome);
      this.deps.onQueueChange();

      if (authError) {
        // "not connected" (no code) just waits; a rejected session must be reconnected.
        const err: SendResult = authError;
        if (err.code !== undefined) this.deps.onAuthError(describe(err));
        return;
      }
      if (retry) {
        this.scheduleRetry(outcome.keep[0]?.error ?? "");
        return;
      }
      this.retryDelay = 0;
    }
  }

  private scheduleRetry(reason: string): void {
    this.retryDelay = this.retryDelay === 0 ? RETRY_MIN_MS : Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.cancelRetry();
    this.nextRetryAt = this.deps.now() + this.retryDelay;
    this.deps.log.warn(`will retry queued scrobbles in ${Math.round(this.retryDelay / 1000)} s (${reason})`);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.flush();
    }, this.retryDelay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }
}

function describe(r: SendResult): string {
  return [r.code !== undefined ? `code ${r.code}` : "", r.message ?? ""].filter(Boolean).join(", ") || r.status;
}
