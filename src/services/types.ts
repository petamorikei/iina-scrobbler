// Service-neutral types shared by every scrobbling service (Last.fm now; Libre.fm,
// ListenBrainz, ... later). See docs/design.md §9.

export interface Track {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  /** Seconds. */
  duration?: number;
}

export interface ScrobbleEntry extends Track {
  /** Unix time (seconds) when playback of this track started. */
  timestamp: number;
}

/**
 * Outcome of one send, per track.
 * - ok: accepted
 * - ignored: the service accepted the request but chose not to record it (do not resend)
 * - auth-error: the session is invalid; the user has to reconnect (keep for resend)
 * - retry: temporary failure (network, server, rate limit); resend later
 * - drop: will never succeed as is (bad parameters etc.); discard
 */
export type SendStatus = "ok" | "ignored" | "auth-error" | "retry" | "drop";

export interface SendResult {
  status: SendStatus;
  /** Service-specific error / ignore code, for logs. */
  code?: number | string;
  message?: string;
}

/** A desktop-style auth flow: open a URL in the browser, then poll until approved. */
export interface PendingAuth {
  url: string;
  token: string;
}

export type AuthPoll =
  | { status: "approved"; sessionKey: string; userName: string }
  | { status: "waiting" }
  | { status: "failed"; message: string; retryable: boolean };

/**
 * Whether the service knows a track (web-scrobbler's "recognized" check).
 * - found / not-found: a definite answer
 * - unknown: no answer (offline, key or rate-limit problems...); never a reason to drop
 */
export type LookupResult = "found" | "not-found" | "unknown";

export interface Scrobbler {
  readonly id: string;
  readonly displayName: string;
  /** Session key, or null when not connected. */
  session: string | null;
  beginAuth(): Promise<PendingAuth>;
  pollAuth(token: string): Promise<AuthPoll>;
  nowPlaying(track: Track): Promise<SendResult>;
  /** Sends up to `maxBatch` entries; returns one result per entry, in order. */
  scrobble(entries: ScrobbleEntry[]): Promise<SendResult[]>;
  readonly maxBatch: number;
  /** Optional track lookup. Services without one treat every track as found. */
  lookup?(track: Track): Promise<LookupResult>;
}
