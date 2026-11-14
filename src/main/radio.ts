// Internet radio (ICY): one track per `icy-title` (docs/design.md §5.5).
//
// web-scrobbler treats every song a radio page shows as its own track, scrobbled after
// 30 s because the length is unknown; a title without artist and track (station IDs,
// ads) ends the current track. mpv fires no event when icy-title changes
// (research.md §8.5.2), so the caller polls it once a second.
//
// Note: the title changes when the new song enters mpv's buffer, a few seconds before
// it is heard. That shifts the start of each track by the buffer length; accepted.
import { type ArtistTitle, clean, splitArtistTitle } from "./title-parser.ts";

/** A song scrobbled this recently is not scrobbled again (e.g. after a station-ID blip). */
export const RADIO_REPEAT_WINDOW_MS = 10 * 60_000;

export type IcyUpdate =
  /** Same song as before (or still nothing). */
  | { type: "same" }
  /** A new song started. */
  | { type: "new"; track: ArtistTitle; key: string; alreadyScrobbled: boolean }
  /** The title no longer names a song: end the current track. */
  | { type: "end" };

export const trackKey = (t: ArtistTitle): string => `${t.artist}\u0000${t.title}`.toLowerCase();

export const parseIcyTitle = (raw: string): ArtistTitle | null => splitArtistTitle(clean(raw));

export class IcyTitleTracker {
  private current: string | null = null;
  private readonly scrobbledAt = new Map<string, number>();

  update(raw: string, now: number): IcyUpdate {
    const parsed = parseIcyTitle(raw);
    if (!parsed) {
      if (this.current === null) return { type: "same" };
      this.current = null;
      return { type: "end" };
    }
    const key = trackKey(parsed);
    if (key === this.current) return { type: "same" };
    this.current = key;
    const last = this.scrobbledAt.get(key);
    return {
      type: "new",
      track: parsed,
      key,
      alreadyScrobbled: last !== undefined && now - last < RADIO_REPEAT_WINDOW_MS,
    };
  }

  markScrobbled(key: string, now: number): void {
    this.scrobbledAt.set(key, now);
    for (const [k, t] of this.scrobbledAt) if (now - t >= RADIO_REPEAT_WINDOW_MS) this.scrobbledAt.delete(k);
  }
}
