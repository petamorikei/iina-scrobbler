// Main entry: one instance per player (PlayerCore, reused across files and windows).
// Reads the track at iina.file-loaded (running yt-dlp for yt-dlp sources), checks with
// Last.fm that it knows the track, counts played time once a second, and sends
// nowplaying / scrobble to the global entry (main → global only; research.md §8.1).
// Internet radio is followed song by song through `icy-title`.
import { LastFm } from "../services/lastfm/lastfm.ts";
import type { LookupResult, Track } from "../services/types.ts";
import { LASTFM_API_KEY, LASTFM_API_SECRET } from "../shared/build-config.ts";
import { iinaHttp } from "../shared/iina-http.ts";
import { createLogger } from "../shared/log.ts";
import { encode, type MessageMap, type MessageName, type Source } from "../shared/messages.ts";
import { getBool, getString, PrefKey } from "../shared/prefs.ts";
import { buildTrack, type MetadataInput } from "./metadata.ts";
import { PlaybackSession, type SessionOptions } from "./playback.ts";
import { IcyTitleTracker, trackKey } from "./radio.ts";
import { classifySource, hasVideo, type TrackInfo } from "./source.ts";
import { fetchYtdlpInfo } from "./ytdlp.ts";

const { core, mpv, event, global } = iina;
const log = createLogger("main");

// Only used for the "does Last.fm know this track" check (track.getInfo, unsigned).
const lastfm = new LastFm(iinaHttp, { apiKey: LASTFM_API_KEY, apiSecret: LASTFM_API_SECRET });

const SOURCE_PREF: Record<Source, string> = {
  local: PrefKey.ScrobbleLocal,
  ytdlp: PrefKey.ScrobbleYtdlp,
  network: PrefKey.ScrobbleNetwork,
};

/** The file currently loaded. `seq` guards async file work (yt-dlp) against file changes. */
let file: { seq: number; startedAt: number | null } = { seq: 0, startedAt: null };
/** Bumped whenever the current track ends; guards the async recognition check. */
let trackSeq = 0;
/** The track being counted. */
let current: { session: PlaybackSession; verified: boolean; radioKey?: string } | null = null;
/** Set while playing internet radio (ICY). */
let radio: IcyTitleTracker | null = null;

/** Last.fm answers per artist/track, for this player instance ("unknown" is not kept). */
const recognized = new Map<string, LookupResult>();
/** Tracks already announced on screen as unknown to Last.fm. */
const announcedUnknown = new Set<string>();

const str = (prop: string): string => {
  const v = mpv.getString(prop);
  return typeof v === "string" ? v : "";
};

const post = <N extends MessageName>(name: N, payload: MessageMap[N]): void => {
  global.postMessage(name, encode(name, payload));
};

const osd = (text: string): void => {
  if (getBool(PrefKey.ShowOsd, true)) core.osd(text);
};

const label = (t: Track): string => `${t.artist} - ${t.track}`;

/**
 * web-scrobbler's default: scrobble only tracks Last.fm knows. "unknown" (offline, key or
 * rate-limit problems) never drops a track; it is checked again before sending.
 */
const recognize = async (track: Track): Promise<LookupResult> => {
  if (getBool(PrefKey.ScrobbleUnrecognized, false)) return "found";
  const key = trackKey({ artist: track.artist, title: track.track });
  const cached = recognized.get(key);
  if (cached) return cached;
  const r = await lastfm.lookup(track);
  if (r !== "unknown") recognized.set(key, r);
  return r;
};

interface BeginOptions extends SessionOptions {
  /**
   * Wall-clock ms the track started (radio: when its title appeared). null: the track is
   * the file itself, so the file's first playback-restart is used, read when the check
   * answers: playback usually starts while the check is still running.
   */
  startedAt: number | null;
  radioKey?: string;
}

const beginTrack = (track: Track, source: Source, from: string, opts: BeginOptions): void => {
  const seq = trackSeq;
  recognize(track)
    .then((r) => {
      if (seq !== trackSeq) return; // the track ended or changed meanwhile
      if (r === "not-found") {
        log.info(`${source}: not scrobbled, Last.fm does not know ${label(track)} (from ${from})`);
        const key = trackKey({ artist: track.artist, title: track.track });
        if (!opts.radioKey && !announcedUnknown.has(key)) {
          announcedUnknown.add(key);
          osd(`Not scrobbled: Last.fm does not know “${label(track)}”`);
        }
        return;
      }
      const session = new PlaybackSession(track, source, opts);
      // yt-dlp metadata and the check arrive after playback started: count from the start.
      const startedAt = opts.startedAt ?? file.startedAt;
      if (startedAt !== null) session.onPlaybackRestart(startedAt);
      current = { session, verified: r === "found", radioKey: opts.radioKey };
      log.info(
        `${source}: ${label(track)} (from ${from}${opts.live ? ", live" : ""}${r === "unknown" ? ", not checked yet" : ""})`,
      );
    })
    .catch((e: unknown) => log.error(`recognition check failed: ${e instanceof Error ? e.message : String(e)}`));
};

/** Ends the current track (radio title change, end of file...). */
const endTrack = (why: string): void => {
  trackSeq++;
  if (!current) return;
  log.info(`${why}: ${label(current.session.track)} (${current.session.describe()})`);
  current = null;
};

const endFile = (why: string): void => {
  endTrack(why);
  file = { seq: file.seq + 1, startedAt: null };
  radio = null;
};

const onFileLoaded = (): void => {
  endTrack("next file");
  radio = null;
  file = { seq: file.seq + 1, startedAt: null };
  const seq = file.seq;

  const path = str("path");
  const metadata = mpv.getNative<Record<string, unknown> | null>("metadata");
  const { source, radio: isRadio } = classifySource({
    path,
    streamOpenFilename: str("stream-open-filename"),
    metadataKeys: metadata ? Object.keys(metadata) : [],
  });

  // Turning a source off also skips running yt-dlp (design §3.2).
  if (!getBool(SOURCE_PREF[source], true)) {
    log.info(`${source}: scrobbling turned off for this source`);
    return;
  }
  if (isRadio) {
    // Songs are picked up from icy-title in tick(), one track each (design §5.5).
    radio = new IcyTitleTracker();
    log.info(`${source}: internet radio, following icy-title`);
    return;
  }

  const input: MetadataInput = {
    source,
    tags: {
      artist: str("metadata/by-key/artist"),
      title: str("metadata/by-key/title"),
      album: str("metadata/by-key/album"),
      albumArtist: str("metadata/by-key/album_artist"),
    },
    fileName: str("filename"),
    mediaTitle: str("media-title"),
    isVideo: hasVideo(mpv.getNative<TrackInfo[] | null>("track-list") ?? []),
    duration: core.status.duration ?? undefined,
  };

  const finish = (inp: MetadataInput) => {
    if (seq !== file.seq) return; // another file was loaded meanwhile
    const result = buildTrack(inp);
    if (result.ok) beginTrack(result.track, source, result.from, { startedAt: null, live: result.live });
    else log.info(`${source}: not scrobbled (${result.reason})`);
  };

  const needsYtdlp = source === "ytdlp" && !(input.tags.artist && input.tags.title);
  if (!needsYtdlp || !getBool(PrefKey.YtdlpMetadata, true)) {
    finish(input);
    return;
  }

  fetchYtdlpInfo(path)
    .then((r) => {
      if (r.ok) log.info(`yt-dlp: metadata in ${r.ms} ms (${r.bin})`);
      else log.warn(`yt-dlp: ${r.error}; falling back to the video title`);
      finish({ ...input, ytdlp: r.ok ? r.info : null, duration: core.status.duration ?? input.duration });
    })
    .catch((e: unknown) => log.error(`yt-dlp: ${e instanceof Error ? e.message : String(e)}`));
};

/** Radio: start a track for each new song in icy-title; a non-song title ends it. */
const followRadio = (now: number): void => {
  if (!radio || file.startedAt === null) return;
  const u = radio.update(str("metadata/by-key/icy-title"), now);
  if (u.type === "new") {
    endTrack("radio: next song");
    const track: Track = { artist: u.track.artist, track: u.track.title };
    beginTrack(track, "network", "icy-title", {
      startedAt: now,
      live: true,
      alreadyScrobbled: u.alreadyScrobbled,
      radioKey: u.key,
    });
  } else if (u.type === "end") {
    endTrack("radio: title no longer names a song");
  }
};

const tick = (): void => {
  const now = Date.now();
  followRadio(now);
  const c = current;
  if (!c) return;
  const st = core.status;
  const actions = c.session.tick(now, {
    paused: st.paused,
    idle: st.idle,
    position: st.position ?? null,
    duration: st.duration ?? null,
    loopFile: str("loop-file") !== "no",
    speed: st.speed || 1,
  });
  for (const a of actions) {
    switch (a.type) {
      case "nowplaying":
        post("nowplaying", { track: a.track, source: c.session.source });
        break;
      case "scrobble":
        post("scrobble", {
          entry: { ...a.track, timestamp: a.timestamp },
          source: c.session.source,
          verified: c.verified,
        });
        if (c.radioKey) radio?.markScrobbled(c.radioKey, now);
        log.info(`scrobble: ${label(a.track)}`);
        // The global entry does the actual send and cannot reply (research.md §8.1), so
        // this only reflects whether the track qualified while connected. Not connected
        // (never, or the session was revoked): the scrobble waits in the queue.
        if (getString(PrefKey.SessionKey)) osd(`Scrobbled: ${label(a.track)}`);
        else osd("Scrobble saved. Connect to Last.fm from the Plugin menu to send it.");
        break;
      case "skip":
        log.info(`not scrobbled (${a.reason})`);
        break;
      case "note":
        log.info(a.message);
        break;
    }
  }
};

event.on("iina.file-loaded", () => onFileLoaded());
event.on("mpv.playback-restart", () => {
  if (file.startedAt === null) file.startedAt = Date.now();
  current?.session.onPlaybackRestart(Date.now());
});
// End of this file (next file, stop, close). A new track starts at the next file-loaded.
event.on("mpv.end-file", () => endFile("end-file"));
event.on("mpv.idle", () => endFile("idle"));
event.on("iina.window-will-close", () => endFile("window-will-close"));

setInterval(tick, 1000);
