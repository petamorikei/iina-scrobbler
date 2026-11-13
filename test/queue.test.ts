import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_AGE_MS, MAX_ITEMS, ScrobbleQueue, type Storage, serializeQueue } from "../src/global/queue.ts";
import { RETRY_MAX_MS, RETRY_MIN_MS, Sender, type SenderDeps } from "../src/global/sender.ts";
import type { ScrobbleEntry, Scrobbler, SendResult } from "../src/services/types.ts";

// ---- helpers ----

function memoryStorage(initial: string | null = null) {
  const s = { content: initial, backups: [] as string[] };
  const storage: Storage = {
    read: () => s.content,
    write: (c) => {
      s.content = c;
    },
    backupCorrupt: (c) => {
      s.backups.push(c);
    },
  };
  return { s, storage };
}

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const entry = (track: string, minutesAgo = 10): ScrobbleEntry => ({
  artist: "A",
  track,
  timestamp: Math.floor((NOW - minutesAgo * 60_000) / 1000),
});

class FakeService implements Scrobbler {
  readonly id = "lastfm";
  readonly displayName = "Fake";
  readonly maxBatch = 2;
  session: string | null = "SK";
  calls: string[][] = [];
  /** One responder per call; default: everything ok. */
  responders: ((entries: ScrobbleEntry[]) => SendResult[])[] = [];
  async beginAuth(): Promise<never> {
    throw new Error("unused");
  }
  async pollAuth(): Promise<never> {
    throw new Error("unused");
  }
  async nowPlaying(): Promise<SendResult> {
    return { status: "ok" };
  }
  async scrobble(entries: ScrobbleEntry[]): Promise<SendResult[]> {
    this.calls.push(entries.map((e) => e.track));
    const r = this.responders.shift();
    return r ? r(entries) : entries.map(() => ({ status: "ok" as const }));
  }
}

function fakeDeps() {
  const timers: { fn: () => void; ms: number }[] = [];
  const authErrors: string[] = [];
  const deps: SenderDeps = {
    now: () => NOW,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
    log: { info: () => {}, warn: () => {} },
    onAuthError: (d) => {
      authErrors.push(d);
    },
    onQueueChange: () => {},
  };
  return { deps, timers, authErrors };
}

// ---- queue ----

test("add / load keeps items ordered by playback time and survives a round trip", () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("late", 1), NOW);
  q.add("lastfm", entry("early", 30), NOW);
  assert.deepEqual(
    new ScrobbleQueue(storage).load().map((i) => i.entry.track),
    ["early", "late"],
  );
});

test("every change re-reads storage, so another process's items are kept", () => {
  const { s, storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  const mine = q.add("lastfm", entry("mine"), NOW);
  // Another IINA process appends directly to the same file.
  const other = new ScrobbleQueue(storage).add("lastfm", entry("theirs"), NOW);
  q.apply({ remove: [mine.id], keep: [] });
  assert.deepEqual(
    new ScrobbleQueue(storage).load().map((i) => i.id),
    [other.id],
  );
  assert.ok(s.content);
});

test("apply removes and records failures", () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  const a = q.add("lastfm", entry("a"), NOW);
  const b = q.add("lastfm", entry("b"), NOW);
  q.apply({ remove: [a.id], keep: [{ id: b.id, error: "code 11" }] });
  const items = q.load();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.attempts, 1);
  assert.equal(items[0]!.lastError, "code 11");
});

test("pruneExpired drops items played more than 14 days ago", () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("old", MAX_AGE_MS / 60_000 + 1), NOW);
  q.add("lastfm", entry("fresh"), NOW);
  const removed = q.pruneExpired(NOW);
  assert.deepEqual(
    removed.map((i) => i.entry.track),
    ["old"],
  );
  assert.deepEqual(
    q.load().map((i) => i.entry.track),
    ["fresh"],
  );
});

test("the queue is capped, keeping the newest items", () => {
  const items = Array.from({ length: MAX_ITEMS }, (_, n) => ({
    id: `id${n}`,
    service: "lastfm",
    entry: { artist: "A", track: `t${n}`, timestamp: 1_000 + n },
    queuedAt: NOW,
    attempts: 0,
  }));
  const { storage } = memoryStorage(serializeQueue(items));
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", { artist: "A", track: "newest", timestamp: 999_999 }, NOW);
  const after = q.load();
  assert.equal(after.length, MAX_ITEMS);
  assert.equal(after[0]!.entry.track, "t1");
  assert.equal(after[after.length - 1]!.entry.track, "newest");
});

test("an unreadable file is backed up and replaced by an empty queue", () => {
  const { s, storage } = memoryStorage("{not json");
  const q = new ScrobbleQueue(storage);
  assert.deepEqual(q.load(), []);
  assert.deepEqual(s.backups, ["{not json"]);
  q.add("lastfm", entry("x"), NOW);
  assert.equal(q.count(), 1);
});

test("malformed items inside a valid file are skipped", () => {
  const { storage } = memoryStorage(JSON.stringify({ version: 1, items: [{ id: "x" }, null] }));
  assert.deepEqual(new ScrobbleQueue(storage).load(), []);
});

// ---- sender ----

test("flush sends in batches of maxBatch and empties the queue", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  for (const t of ["a", "b", "c"]) q.add("lastfm", entry(t), NOW);
  const svc = new FakeService();
  const { deps, timers } = fakeDeps();
  await new Sender(svc, q, deps).flush();
  assert.deepEqual(svc.calls, [["a", "b"], ["c"]]);
  assert.equal(q.count(), 0);
  assert.equal(timers.length, 0);
});

test("ignored and dropped items are removed, retry items stay and schedule a backoff", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  for (const t of ["ok", "ign"]) q.add("lastfm", entry(t), NOW);
  const svc = new FakeService();
  svc.responders.push(() => [{ status: "ok" }, { status: "ignored", code: "1" }]);
  const { deps } = fakeDeps();
  await new Sender(svc, q, deps).flush();
  assert.equal(q.count(), 0);

  q.add("lastfm", entry("net"), NOW);
  svc.responders.push(() => [{ status: "retry", message: "offline" }]);
  const { deps: d2, timers } = fakeDeps();
  const sender = new Sender(svc, q, d2);
  await sender.flush();
  assert.equal(q.count(), 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, RETRY_MIN_MS);
  assert.equal(sender.retryAt, NOW + RETRY_MIN_MS);
});

test("backoff doubles up to one hour, and resets after a success", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("x"), NOW);
  const svc = new FakeService();
  const { deps, timers } = fakeDeps();
  const sender = new Sender(svc, q, deps);
  const delays: number[] = [];
  for (let n = 0; n < 9; n++) {
    svc.responders.push((es) => es.map(() => ({ status: "retry" as const })));
    if (n === 0) await sender.flush();
    else {
      const t = timers.shift()!;
      t.fn();
      await new Promise((r) => setImmediate(r));
    }
    delays.push(timers[0]!.ms);
  }
  assert.deepEqual(delays.slice(0, 4), [RETRY_MIN_MS, RETRY_MIN_MS * 2, RETRY_MIN_MS * 4, RETRY_MIN_MS * 8]);
  assert.equal(delays[delays.length - 1], RETRY_MAX_MS);
  // success resets
  timers.shift()!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(q.count(), 0);
  q.add("lastfm", entry("y"), NOW);
  svc.responders.push((es) => es.map(() => ({ status: "retry" as const })));
  await sender.flush();
  assert.equal(timers[0]!.ms, RETRY_MIN_MS);
});

test("a rejected session keeps the items and reports once", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("x"), NOW);
  const svc = new FakeService();
  svc.responders.push(() => [{ status: "auth-error", code: 9, message: "Invalid session key" }]);
  const { deps, authErrors, timers } = fakeDeps();
  await new Sender(svc, q, deps).flush();
  assert.equal(q.count(), 1);
  assert.equal(authErrors.length, 1);
  assert.equal(timers.length, 0);
});

test("nothing is sent while not connected; retryNow sends after connecting", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("x"), NOW);
  const svc = new FakeService();
  svc.session = null;
  const { deps } = fakeDeps();
  const sender = new Sender(svc, q, deps);
  await sender.flush();
  assert.equal(svc.calls.length, 0);
  assert.equal(q.count(), 1);
  svc.session = "SK";
  await sender.retryNow();
  assert.equal(q.count(), 0);
});

test("a flush requested during a flush runs once more afterwards", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("first"), NOW);
  const svc = new FakeService();
  const { deps } = fakeDeps();
  const sender = new Sender(svc, q, deps);
  svc.responders.push((es) => {
    // a new scrobble arrives while the first request is in flight
    q.add("lastfm", entry("second", 1), NOW);
    void sender.flush();
    return es.map(() => ({ status: "ok" as const }));
  });
  await sender.flush();
  assert.deepEqual(svc.calls, [["first"], ["second"]]);
  assert.equal(q.count(), 0);
});

test("items older than 14 days are pruned before sending", async () => {
  const { storage } = memoryStorage();
  const q = new ScrobbleQueue(storage);
  q.add("lastfm", entry("old", MAX_AGE_MS / 60_000 + 5), NOW);
  const svc = new FakeService();
  const { deps } = fakeDeps();
  await new Sender(svc, q, deps).flush();
  assert.equal(svc.calls.length, 0);
  assert.equal(q.count(), 0);
});
