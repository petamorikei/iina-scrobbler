// Main entry: one instance per player (PlayerCore, reused across files and windows).
// Reads the track at iina.file-loaded, counts played time once a second, and sends
// nowplaying / scrobble to the global entry (main → global only; see research.md §8.1).
import { createLogger } from "../shared/log.ts";
import { encode, type MessageMap, type MessageName, type Source } from "../shared/messages.ts";
import { getBool, getString, PrefKey } from "../shared/prefs.ts";
import { buildTrack } from "./metadata.ts";
import { PlaybackSession } from "./playback.ts";
import { classifySource, hasVideo, type TrackInfo } from "./source.ts";

const { core, mpv, event, global } = iina;
const log = createLogger("main");

const SOURCE_PREF: Record<Source, string> = {
  local: PrefKey.ScrobbleLocal,
  ytdlp: PrefKey.ScrobbleYtdlp,
  network: PrefKey.ScrobbleNetwork,
};

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

function onFileLoaded(): void {
  session = null;
  const path = str("path");
  const metadata = mpv.getNative<Record<string, unknown> | null>("metadata");
  const { source, radio } = classifySource({
    path,
    streamOpenFilename: str("stream-open-filename"),
    metadataKeys: metadata ? Object.keys(metadata) : [],
  });

  if (!getBool(SOURCE_PREF[source], true)) return log.info(`${source}: scrobbling turned off for this source`);
  if (radio) return log.info(`${source}: internet radio is not scrobbled`);

  const tracks = mpv.getNative<TrackInfo[] | null>("track-list") ?? [];
  const result = buildTrack({
    source,
    tags: {
      artist: str("metadata/by-key/artist"),
      title: str("metadata/by-key/title"),
      album: str("metadata/by-key/album"),
      albumArtist: str("metadata/by-key/album_artist"),
    },
    fileName: str("filename"),
    mediaTitle: str("media-title"),
    isVideo: hasVideo(tracks),
    duration: core.status.duration ?? undefined,
  });
  if (!result.ok) return log.info(`${source}: not scrobbled (${result.reason})`);

  session = new PlaybackSession(result.track, source);
  log.info(`${source}: ${result.track.artist} - ${result.track.track} (from ${result.from})`);
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
        // this only reflects that the track qualified while connected.
        if (getString(PrefKey.SessionKey)) osd(`Scrobbled: ${a.track.artist} - ${a.track.track}`);
        break;
      case "skip":
        log.info(`not scrobbled (${a.reason})`);
        break;
    }
  }
}

event.on("iina.file-loaded", () => onFileLoaded());
event.on("mpv.playback-restart", () => session?.onPlaybackRestart(Date.now()));
// End of this file (next file, stop, close). A new session starts at the next file-loaded.
function endSession(why: string): void {
  if (!session) return;
  log.info(`${why}: ${session.track.artist} - ${session.track.track} (${session.describe()})`);
  session = null;
}
event.on("mpv.end-file", () => endSession("end-file"));
event.on("mpv.idle", () => endSession("idle"));
event.on("iina.window-will-close", () => endSession("window-will-close"));

setInterval(tick, 1000);
