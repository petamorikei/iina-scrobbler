// Per-file playback session: counts played time and decides when to send nowplaying
// and scrobble (docs/design.md §5). Pure: the caller feeds it time and player state.

import type { Track } from "../services/types.ts";
import type { Source } from "../shared/messages.ts";

/** web-scrobbler's rule: skip < 30 s, scrobble at min(50 %, 4 min); 30 s if the length is unknown. */
export const scrobbleThreshold = (duration: number | undefined, source: Source): number | null => {
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    // Unknown length: a local file is still a file; a stream may be live (D3).
    return source === "local" ? 30 : null;
  }
  if (duration < 30) return null;
  return Math.min(Math.round(duration / 2), 240);
};

export interface PlayerSample {
  paused: boolean;
  idle: boolean;
  /** Seconds, or null when unknown. */
  position: number | null;
  /** Seconds, or null/0 when unknown. */
  duration: number | null;
  /** mpv `loop-file` is not "no". */
  loopFile: boolean;
  /** Playback speed (1 = normal). */
  speed: number;
}

export type SessionAction =
  | { type: "nowplaying"; track: Track }
  | { type: "scrobble"; track: Track; timestamp: number }
  | { type: "skip"; reason: string };

/** Longest gap counted between two ticks when the playback position is unknown. */
const MAX_TICK_GAP_MS = 2_000;
/** Slack between the wall clock and the sampled playback position, in seconds. */
const POSITION_TOLERANCE = 0.25;
/** Loop wrap: the previous sample was within this many seconds of the end... */
const WRAP_END_MARGIN = 3;
/** ...and the new position is within this many seconds of the start. */
const WRAP_START_MARGIN = 3;
/** Network streams whose duration keeps changing are live (radio, live streams). */
const LIVE_DURATION_CHANGES = 3;

export class PlaybackSession {
  readonly track: Track;
  readonly source: Source;
  /** Wall-clock ms when the current play started; null until playback-restart. */
  private startedAt: number | null = null;
  private played = 0;
  private lastTickAt: number | null = null;
  private lastPosition: number | null = null;
  private lastPlaying = false;
  private lastDuration: number | null = null;
  private durationChanges = 0;
  private nowPlayingSent = false;
  private scrobbled = false;
  private skipped = false;

  constructor(track: Track, source: Source) {
    this.track = track;
    this.source = source;
  }

  /** mpv.playback-restart: the first one marks the start of playback. */
  onPlaybackRestart(now: number): void {
    if (this.startedAt === null) this.startedAt = now;
  }

  /** Called about once a second. Returns what to send now. */
  tick(now: number, s: PlayerSample): SessionAction[] {
    const actions: SessionAction[] = [];
    const prevTick = this.lastTickAt;
    this.lastTickAt = now;
    if (this.startedAt === null || this.skipped) return actions;

    const duration = s.duration && s.duration > 0 ? s.duration : null;
    if (this.detectLive(duration)) {
      this.skipped = true;
      return [{ type: "skip", reason: "live stream (duration keeps changing)" }];
    }

    const playing = !s.paused && !s.idle;
    const wasPlaying = this.lastPlaying;
    this.lastPlaying = playing;

    if (this.detectLoopWrap(s, duration)) {
      this.startedAt = now;
      this.played = 0;
      this.nowPlayingSent = false;
      this.scrobbled = false;
    } else if (playing && wasPlaying && prevTick !== null) {
      this.played += this.countedSeconds(now - prevTick, s.position, s.speed);
    }
    this.lastPosition = s.position;

    const threshold = scrobbleThreshold(duration ?? undefined, this.source);
    if (threshold === null) {
      // Wait until the length is known for network media; give up when it is too short.
      if (duration !== null) {
        this.skipped = true;
        actions.push({ type: "skip", reason: `too short (${Math.round(duration)} s)` });
      }
      return actions;
    }

    const track: Track = duration ? { ...this.track, duration } : this.track;
    if (playing && !this.nowPlayingSent) {
      this.nowPlayingSent = true;
      actions.push({ type: "nowplaying", track });
    }
    if (!this.scrobbled && this.played >= threshold) {
      this.scrobbled = true;
      actions.push({ type: "scrobble", track, timestamp: Math.floor(this.startedAt / 1000) });
    }
    return actions;
  }

  get playedSeconds(): number {
    return this.played;
  }

  /** One-line state for logs when the file ends. */
  describe(): string {
    const d = this.lastDuration ?? undefined;
    return (
      `played ${this.played.toFixed(1)} s, duration ${d === undefined ? "?" : d.toFixed(1)} s, ` +
      `threshold ${scrobbleThreshold(d, this.source) ?? "-"}, started ${this.startedAt !== null}, ` +
      `nowplaying ${this.nowPlayingSent}, scrobbled ${this.scrobbled}, skipped ${this.skipped}`
    );
  }

  /**
   * Seconds to count for one interval in which the player was playing at both ends.
   * Wall-clock time, but never more than the playback position advanced: a seek adds
   * nothing beyond the wall-clock gap, and system sleep adds nothing. Ticks that the
   * OS delays (timer throttling) still count in full, because the position moved on.
   * The position advance is divided by the playback speed, so 0.5x playback still
   * counts wall-clock time (design §5.1). Without a position, a gap counts at most
   * MAX_TICK_GAP_MS.
   */
  private countedSeconds(wallMs: number, position: number | null, speed: number): number {
    const wall = Math.max(wallMs, 0) / 1000;
    if (position === null || this.lastPosition === null) return Math.min(wall, MAX_TICK_GAP_MS / 1000);
    const advanced = (position - this.lastPosition) / (speed > 0 ? speed : 1);
    // Allow for the position being sampled slightly later than the tick time.
    return Math.max(0, Math.min(wall, advanced + POSITION_TOLERANCE));
  }

  private detectLoopWrap(s: PlayerSample, duration: number | null): boolean {
    if (!s.loopFile || duration === null || s.position === null || this.lastPosition === null) return false;
    return this.lastPosition >= duration - WRAP_END_MARGIN && s.position < WRAP_START_MARGIN;
  }

  private detectLive(duration: number | null): boolean {
    const changed = duration !== null && this.lastDuration !== null && Math.abs(duration - this.lastDuration) > 0.5;
    this.lastDuration = duration;
    if (this.source === "local") return false;
    if (changed) this.durationChanges++;
    return this.durationChanges >= LIVE_DURATION_CHANGES;
  }
}
