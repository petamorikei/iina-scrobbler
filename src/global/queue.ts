// Persistent scrobble queue (docs/design.md §7), stored as JSON in @data/queue.json.
//
// Every change re-reads the file right before writing it (read-modify-write), so two
// IINA processes sharing @data do not lose each other's items. They can still send the
// same item twice if both flush at the same moment; that is a known limitation.
import type { ScrobbleEntry } from "../services/types.ts";

export interface QueueItem {
  /** Unique id (time + random). */
  id: string;
  /** Scrobbler id, e.g. "lastfm". */
  service: string;
  entry: ScrobbleEntry;
  /** Unix ms when queued. */
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface Storage {
  /** Returns null when there is nothing stored yet. */
  read(): string | null;
  write(content: string): void;
  /** Keeps a copy of unreadable content so it is not silently lost. */
  backupCorrupt(content: string): void;
}

/** Last.fm ignores scrobbles older than 14 days (ignoredMessage code 3). */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Upper bound so a long offline period cannot grow the file without limit. */
export const MAX_ITEMS = 5000;

const VERSION = 1;

interface QueueFile {
  version: number;
  items: QueueItem[];
}

function isItem(v: unknown): v is QueueItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const e = o.entry as Record<string, unknown> | undefined;
  return (
    typeof o.id === "string" &&
    typeof o.service === "string" &&
    typeof o.queuedAt === "number" &&
    typeof o.attempts === "number" &&
    !!e &&
    typeof e.artist === "string" &&
    typeof e.track === "string" &&
    typeof e.timestamp === "number"
  );
}

export function parseQueue(content: string): QueueItem[] | null {
  try {
    const data = JSON.parse(content) as Partial<QueueFile>;
    if (!Array.isArray(data.items)) return null;
    return data.items.filter(isItem);
  } catch {
    return null;
  }
}

export function serializeQueue(items: readonly QueueItem[]): string {
  const file: QueueFile = { version: VERSION, items: [...items] };
  return JSON.stringify(file);
}

export function newId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface Outcome {
  /** Remove from the queue (sent, ignored by the service, or permanently failed). */
  remove: string[];
  /** Keep and remember the failure. */
  keep: { id: string; error: string }[];
}

export class ScrobbleQueue {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Current items, oldest playback first. Unreadable content is backed up and reset. */
  load(): QueueItem[] {
    const raw = this.storage.read();
    if (raw === null || raw.trim() === "") return [];
    const items = parseQueue(raw);
    if (items === null) {
      this.storage.backupCorrupt(raw);
      this.storage.write(serializeQueue([]));
      return [];
    }
    return items.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
  }

  add(service: string, entry: ScrobbleEntry, now: number): QueueItem {
    const item: QueueItem = { id: newId(now), service, entry, queuedAt: now, attempts: 0 };
    this.update((items) => {
      items.push(item);
      // Keep the newest MAX_ITEMS by playback time.
      items.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
      return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
    });
    return item;
  }

  /** Removes items played more than MAX_AGE_MS ago. Returns the removed items. */
  pruneExpired(now: number): QueueItem[] {
    let removed: QueueItem[] = [];
    this.update((items) => {
      removed = items.filter((i) => now - i.entry.timestamp * 1000 > MAX_AGE_MS);
      return removed.length ? items.filter((i) => !removed.includes(i)) : items;
    });
    return removed;
  }

  /** Applies send results to the stored queue (re-read first, by id). */
  apply(outcome: Outcome): void {
    const remove = new Set(outcome.remove);
    const errors = new Map(outcome.keep.map((k) => [k.id, k.error]));
    this.update((items) =>
      items
        .filter((i) => !remove.has(i.id))
        .map((i) => (errors.has(i.id) ? { ...i, attempts: i.attempts + 1, lastError: errors.get(i.id) } : i)),
    );
  }

  count(service?: string): number {
    const items = this.load();
    return service === undefined ? items.length : items.filter((i) => i.service === service).length;
  }

  private update(fn: (items: QueueItem[]) => QueueItem[]): void {
    const before = this.load();
    const after = fn(before.slice());
    this.storage.write(serializeQueue(after));
  }
}
