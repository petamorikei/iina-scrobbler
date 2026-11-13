// Last.fm (AudioScrobbler 2.0 API) scrobbler.
// Verified on a real IINA: docs/research.md §8.5, §8.5.1.
import type { HttpFn, HttpMethod } from "../http.ts";
import type { AuthPoll, PendingAuth, ScrobbleEntry, Scrobbler, SendResult, Track } from "../types.ts";
import { buildParams, type Credentials } from "./signature.ts";

export const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
export const LASTFM_AUTH_URL = "https://www.last.fm/api/auth/";

/** Error codes: https://www.last.fm/api/errorcodes */
export const LastFmError = {
  InvalidService: 2,
  InvalidMethod: 3,
  AuthenticationFailed: 4,
  InvalidFormat: 5,
  InvalidParameters: 6,
  InvalidResource: 7,
  OperationFailed: 8,
  InvalidSessionKey: 9,
  InvalidApiKey: 10,
  ServiceOffline: 11,
  InvalidSignature: 13,
  UnauthorizedToken: 14,
  TokenExpired: 15,
  TemporaryError: 16,
  SuspendedApiKey: 26,
  RateLimitExceeded: 29,
} as const;

const RETRYABLE_ERRORS = new Set<number>([
  LastFmError.OperationFailed,
  LastFmError.ServiceOffline,
  LastFmError.TemporaryError,
  LastFmError.RateLimitExceeded,
  // Key problems are on our side; keep scrobbles until a fixed build is installed.
  LastFmError.InvalidApiKey,
  LastFmError.SuspendedApiKey,
]);

/** ignoredMessage codes. 5 = daily scrobble limit exceeded, which clears the next day. */
const IGNORED_DAILY_LIMIT = "5";

export type CallResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { kind: "api"; code: number; message: string } }
  | { ok: false; error: { kind: "http"; statusCode: number } }
  | { ok: false; error: { kind: "network"; message: string } };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Maps a failed call to a per-track send status. */
export function classifyFailure(error: Extract<CallResult, { ok: false }>["error"]): SendResult {
  switch (error.kind) {
    case "network":
      return { status: "retry", message: error.message };
    case "http":
      return error.statusCode >= 500 || error.statusCode === 429
        ? { status: "retry", code: error.statusCode }
        : { status: "drop", code: error.statusCode };
    case "api":
      if (error.code === LastFmError.InvalidSessionKey)
        return { status: "auth-error", code: error.code, message: error.message };
      if (RETRYABLE_ERRORS.has(error.code)) return { status: "retry", code: error.code, message: error.message };
      return { status: "drop", code: error.code, message: error.message };
  }
}

/** Reads `ignoredMessage` from a nowplaying / scrobble item. */
export function classifyItem(item: unknown): SendResult {
  const ignored = isRecord(item) ? item.ignoredMessage : undefined;
  const code = isRecord(ignored) ? String(ignored.code ?? "0") : "0";
  if (code === "0") return { status: "ok" };
  const message = isRecord(ignored) && typeof ignored["#text"] === "string" ? ignored["#text"] : undefined;
  return { status: code === IGNORED_DAILY_LIMIT ? "retry" : "ignored", code, message };
}

export class LastFm implements Scrobbler {
  readonly id = "lastfm";
  readonly displayName = "Last.fm";
  readonly maxBatch = 50;
  session: string | null = null;
  private readonly http: HttpFn;
  private readonly creds: Credentials;

  constructor(http: HttpFn, creds: Credentials) {
    this.http = http;
    this.creds = creds;
  }

  /** Low-level call. Last.fm errors arrive either as 4xx (rejected by iina.http) or as 200 with `error`. */
  async call(
    method: string,
    params: Record<string, string | number | undefined>,
    opts: { signed: boolean; httpMethod: HttpMethod },
  ): Promise<CallResult> {
    const p = buildParams(method, params, this.creds, opts.signed);
    const res = await this.http(opts.httpMethod, LASTFM_API_URL, p);
    if (res.kind === "network") return { ok: false, error: { kind: "network", message: res.message } };
    const data = res.data;
    if (isRecord(data) && typeof data.error === "number") {
      return { ok: false, error: { kind: "api", code: data.error, message: String(data.message ?? "") } };
    }
    if (res.statusCode >= 400 || !isRecord(data)) {
      return { ok: false, error: { kind: "http", statusCode: res.statusCode } };
    }
    return { ok: true, data };
  }

  async beginAuth(): Promise<PendingAuth> {
    const r = await this.call("auth.getToken", {}, { signed: true, httpMethod: "GET" });
    if (!r.ok) throw new Error(`auth.getToken failed: ${describe(r.error)}`);
    const token = r.data.token;
    if (typeof token !== "string" || token === "") throw new Error("auth.getToken returned no token");
    const url = `${LASTFM_AUTH_URL}?api_key=${encodeURIComponent(this.creds.apiKey)}&token=${encodeURIComponent(token)}`;
    return { url, token };
  }

  async pollAuth(token: string): Promise<AuthPoll> {
    const r = await this.call("auth.getSession", { token }, { signed: true, httpMethod: "GET" });
    if (r.ok) {
      const s = r.data.session;
      if (isRecord(s) && typeof s.key === "string" && typeof s.name === "string") {
        return { status: "approved", sessionKey: s.key, userName: s.name };
      }
      return { status: "failed", message: "auth.getSession returned no session", retryable: false };
    }
    if (r.error.kind === "api" && r.error.code === LastFmError.UnauthorizedToken) return { status: "waiting" };
    const retryable = r.error.kind === "network" || classifyFailure(r.error).status === "retry";
    return { status: "failed", message: describe(r.error), retryable };
  }

  async nowPlaying(t: Track): Promise<SendResult> {
    if (!this.session) return { status: "auth-error", message: "not connected" };
    const r = await this.call(
      "track.updateNowPlaying",
      {
        artist: t.artist,
        track: t.track,
        album: t.album,
        albumArtist: t.albumArtist,
        duration: roundDuration(t.duration),
        sk: this.session,
      },
      { signed: true, httpMethod: "POST" },
    );
    if (!r.ok) return classifyFailure(r.error);
    return classifyItem(r.data.nowplaying);
  }

  async scrobble(entries: ScrobbleEntry[]): Promise<SendResult[]> {
    if (entries.length === 0) return [];
    if (entries.length > this.maxBatch) throw new Error(`at most ${this.maxBatch} entries per call`);
    if (!this.session) return entries.map(() => ({ status: "auth-error", message: "not connected" }));
    const params: Record<string, string | number | undefined> = { sk: this.session };
    entries.forEach((e, i) => {
      params[`artist[${i}]`] = e.artist;
      params[`track[${i}]`] = e.track;
      params[`timestamp[${i}]`] = Math.floor(e.timestamp);
      params[`album[${i}]`] = e.album;
      params[`albumArtist[${i}]`] = e.albumArtist;
      params[`duration[${i}]`] = roundDuration(e.duration);
    });
    const r = await this.call("track.scrobble", params, { signed: true, httpMethod: "POST" });
    if (!r.ok) {
      const res = classifyFailure(r.error);
      return entries.map(() => res);
    }
    return parseScrobbleResponse(r.data, entries.length);
  }
}

/**
 * `{scrobbles: {"@attr": {accepted, ignored}, scrobble: item | item[]}}`.
 * A single scrobble comes back as an object, several as an array.
 */
export function parseScrobbleResponse(data: Record<string, unknown>, count: number): SendResult[] {
  const scrobbles = data.scrobbles;
  const raw = isRecord(scrobbles) ? scrobbles.scrobble : undefined;
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (items.length === count) return items.map(classifyItem);
  // Unexpected shape: the request itself succeeded, so do not resend.
  return Array.from({ length: count }, () => ({ status: "ok" as const }));
}

function roundDuration(d: number | undefined): number | undefined {
  return d !== undefined && Number.isFinite(d) && d > 0 ? Math.round(d) : undefined;
}

function describe(e: Extract<CallResult, { ok: false }>["error"]): string {
  switch (e.kind) {
    case "api":
      return `error ${e.code}: ${e.message}`;
    case "http":
      return `HTTP ${e.statusCode}`;
    case "network":
      return `network: ${e.message}`;
  }
}
