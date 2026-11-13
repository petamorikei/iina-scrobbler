// Main entry: one instance per player (PlayerCore, reused across files and windows).
// Reads the track at iina.file-loaded (running yt-dlp for yt-dlp sources), counts
// played time once a second, and sends nowplaying / scrobble to the global entry
// (main → global only; see research.md §8.1).
import type { Track } from "../services/types.ts";
import { createLogger } from "../shared/log.ts";
import { encode, type MessageMap, type MessageName, type Source } from "../shared/messages.ts";
import { getBool, getString, PrefKey } from "../shared/prefs.ts";
import { buildTrack, type MetadataInput } from "./metadata.ts";
import { PlaybackSession } from "./playback.ts";
import { classifySource, hasVideo, type TrackInfo } from "./source.ts";
import { fetchYtdlpInfo } from "./ytdlp.ts";

const { core, mpv, event, global } = iina;
const log = createLogger("main");

const SOURCE_PREF: Record<Source, string> = {
  local: PrefKey.ScrobbleLocal,
  ytdlp: PrefKey.ScrobbleYtdlp,
  network: PrefKey.ScrobbleNetwork,
};

/** The file currently loaded. `seq` guards async work against file changes. */
let file: { seq: number; startedAt: number | null } = { seq: 0, startedAt: null };
let session: PlaybackSession | null = null;

function str(prop: string): string {
  const v = mpv.getString(prop);
  return typeof v === "string" ? v : "";
}

function post<N extends MessageName>(name: N, payload: MessageMap[N]): void {
  global.postMessage(name, encode(name, payload));
}

function osd(text: string): void {
  if (getBool(PrefKey.ShowOsd, true)) core.osd(text);
}

function startSession(track: Track, source: Source, from: string): void {
  session = new PlaybackSession(track, source);
  // yt-dlp metadata arrives a couple of seconds after playback started.
  if (file.startedAt !== null) session.onPlaybackRestart(file.startedAt);
  log.info(`${source}: ${track.artist} - ${track.track} (from ${from})`);
}

function onFileLoaded(): void {
  session = null;
  file = { seq: file.seq + 1, startedAt: null };
  const seq = file.seq;

  const path = str("path");
  const metadata = mpv.getNative<Record<string, unknown> | null>("metadata");
  const { source, radio } = classifySource({
    path,
    streamOpenFilename: str("stream-open-filename"),
    metadataKeys: metadata ? Object.keys(metadata) : [],
  });

  // Turning a source off also skips running yt-dlp (design §3.2).
  if (!getBool(SOURCE_PREF[source], true)) return log.info(`${source}: scrobbling turned off for this source`);
  if (radio) return log.info(`${source}: internet radio is not scrobbled`);

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
    if (!result.ok) return log.info(`${source}: not scrobbled (${result.reason})`);
    startSession(result.track, source, result.from);
  };

  const needsYtdlp = source === "ytdlp" && !(input.tags.artist && input.tags.title);
  if (!needsYtdlp || !getBool(PrefKey.YtdlpMetadata, true)) return finish(input);

  fetchYtdlpInfo(path)
    .then((r) => {
      if (r.ok) log.info(`yt-dlp: metadata in ${r.ms} ms (${r.bin})`);
      else log.warn(`yt-dlp: ${r.error}; falling back to the video title`);
      finish({ ...input, ytdlp: r.ok ? r.info : null, duration: core.status.duration ?? input.duration });
    })
    .catch((e: unknown) => log.error(`yt-dlp: ${e instanceof Error ? e.message : String(e)}`));
}

function tick(): void {
  const s = session;
  if (!s) return;
  const st = core.status;
  const actions = s.tick(Date.now(), {
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
        post("nowplaying", { track: a.track, source: s.source });
        break;
      case "scrobble":
        post("scrobble", { entry: { ...a.track, timestamp: a.timestamp }, source: s.source });
        log.info(`scrobble: ${a.track.artist} - ${a.track.track}`);
        // The global entry does the actual send and cannot reply (research.md §8.1), so
        // this only reflects whether the track qualified while connected. Not connected
        // (never, or the session was revoked): the scrobble waits in the queue.
        if (getString(PrefKey.SessionKey)) osd(`Scrobbled: ${a.track.artist} - ${a.track.track}`);
        else osd("Scrobble saved. Connect to Last.fm from the Plugin menu to send it.");
        break;
      case "skip":
        log.info(`not scrobbled (${a.reason})`);
        break;
    }
  }
}

// End of this file (next file, stop, close). A new session starts at the next file-loaded.
function endSession(why: string): void {
  file = { seq: file.seq + 1, startedAt: null };
  if (!session) return;
  log.info(`${why}: ${session.track.artist} - ${session.track.track} (${session.describe()})`);
  session = null;
}

event.on("iina.file-loaded", () => onFileLoaded());
event.on("mpv.playback-restart", () => {
  if (file.startedAt === null) file.startedAt = Date.now();
  session?.onPlaybackRestart(Date.now());
});
event.on("mpv.end-file", () => endSession("end-file"));
event.on("mpv.idle", () => endSession("idle"));
event.on("iina.window-will-close", () => endSession("window-will-close"));

setInterval(tick, 1000);
