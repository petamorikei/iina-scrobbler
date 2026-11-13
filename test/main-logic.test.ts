import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTrack, type MetadataInput } from "../src/main/metadata.ts";
import { PlaybackSession, scrobbleThreshold, type PlayerSample } from "../src/main/playback.ts";
import { classifySource, hasVideo } from "../src/main/source.ts";
import { clean, parseFileName, splitArtistTitle, stripTrackNumber } from "../src/main/title-parser.ts";

// ---- title parser ----

test("splitArtistTitle uses the first separator in list order", () => {
  assert.deepEqual(splitArtistTitle("Artist - Title"), { artist: "Artist", title: "Title" });
  assert.deepEqual(splitArtistTitle("A -- B - C"), { artist: "A", title: "B - C" });
  assert.deepEqual(splitArtistTitle("Artist – Title"), { artist: "Artist", title: "Title" });
  assert.equal(splitArtistTitle("No separator"), null);
  assert.equal(splitArtistTitle(" - Title"), null);
});

test("clean trims, replaces NBSP, collapses spaces, NFC-normalises", () => {
  assert.equal(clean("  A  B  "), "A B");
  assert.equal(clean("é"), "é");
  assert.equal(clean("ガ"), "ガ");
});

test("stripTrackNumber only removes numbers followed by punctuation", () => {
  assert.equal(stripTrackNumber("05-Artist - Title"), "Artist - Title");
  assert.equal(stripTrackNumber("01. Artist - Title"), "Artist - Title");
  assert.equal(stripTrackNumber("03) Song"), "Song");
  assert.equal(stripTrackNumber("2 Unlimited - No Limit"), "2 Unlimited - No Limit");
  assert.equal(stripTrackNumber("10cc - Rubber Bullets"), "10cc - Rubber Bullets");
});

test("parseFileName handles the probe's untagged file and Japanese names", () => {
  assert.deepEqual(parseFileName("05-Untagged Artist - Untagged Song.mp3"), {
    artist: "Untagged Artist",
    title: "Untagged Song",
  });
  assert.deepEqual(parseFileName("アーティスト - 曲名.flac"), { artist: "アーティスト", title: "曲名" });
  assert.equal(parseFileName("SoundHelix-Song-1.mp3"), null);
  assert.equal(parseFileName("Track 01.mp3"), null);
});

// ---- source ----

test("classifySource", () => {
  const c = (path: string, sof: string, keys: string[] = []) => classifySource({ path, streamOpenFilename: sof, metadataKeys: keys });
  assert.deepEqual(c("/Users/me/Music/a.mp3", "/Users/me/Music/a.mp3"), { source: "local", radio: false });
  assert.deepEqual(c("file:///Users/me/a.mp3", "file:///Users/me/a.mp3"), { source: "local", radio: false });
  const yt = "https://www.youtube.com/watch?v=x";
  assert.deepEqual(c(yt, "https://manifest.googlevideo.com/api/manifest/hls_playlist/e"), { source: "ytdlp", radio: false });
  const mp3 = "https://example.com/a.mp3";
  assert.deepEqual(c(mp3, mp3), { source: "network", radio: false });
  const radio = "https://ice2.somafm.com/groovesalad-128-mp3";
  assert.deepEqual(c(radio, radio, ["icy-title", "icy-genre"]), { source: "network", radio: true });
});

test("hasVideo ignores embedded cover art", () => {
  assert.equal(hasVideo([{ type: "audio" }, { type: "video", albumart: true }]), false);
  assert.equal(hasVideo([{ type: "video", albumart: false, image: false }, { type: "audio" }]), true);
});

// ---- metadata ----

const meta = (over: Partial<MetadataInput>): MetadataInput => ({
  source: "local",
  tags: {},
  fileName: "",
  mediaTitle: "",
  isVideo: false,
  ...over,
});

test("tags win when artist and title are present", () => {
  const r = buildTrack(meta({ tags: { artist: " テスト・アーティスト ", title: "曲名", album: "アルバム", albumArtist: "" }, duration: 40 }));
  assert.deepEqual(r, { ok: true, from: "tags", track: { artist: "テスト・アーティスト", track: "曲名", album: "アルバム", albumArtist: undefined, duration: 40 } });
});

test("untagged audio falls back to the file name", () => {
  const r = buildTrack(meta({ fileName: "05-Untagged Artist - Untagged Song.mp3", mediaTitle: "05-Untagged Artist - Untagged Song.mp3" }));
  assert.equal(r.ok && r.from, "filename");
  assert.equal(r.ok && r.track.artist, "Untagged Artist");
});

test("artist tag only: the title comes from the file name", () => {
  const r = buildTrack(meta({ tags: { artist: "SoundHelix" }, fileName: "SoundHelix-Song-1.mp3", source: "network" }));
  assert.equal(r.ok && r.track.track, "SoundHelix-Song-1");
});

test("title tag only: the artist comes from the file name, the title stays", () => {
  const r = buildTrack(meta({ tags: { title: "Song - Live" }, fileName: "Band - Song.mp3", mediaTitle: "Song - Live" }));
  assert.deepEqual(r.ok && [r.track.artist, r.track.track], ["Band", "Song - Live"]);
});

test("video files need real tags", () => {
  const r = buildTrack(meta({ isVideo: true, fileName: "07-Show Name - S01E01.mkv", mediaTitle: "07-Show Name - S01E01.mkv" }));
  assert.equal(r.ok, false);
  const tagged = buildTrack(meta({ isVideo: true, tags: { artist: "A", title: "T" } }));
  assert.equal(tagged.ok, true);
});

test("yt-dlp sources are not scrobbled until yt-dlp metadata exists (step 5)", () => {
  assert.equal(buildTrack(meta({ source: "ytdlp", mediaTitle: "Artist - Song (Official Video)" })).ok, false);
  // ...unless the stream itself carries real tags
  assert.equal(buildTrack(meta({ source: "ytdlp", tags: { artist: "A", title: "T" } })).ok, true);
});

// ---- threshold ----

test("scrobbleThreshold follows web-scrobbler", () => {
  assert.equal(scrobbleThreshold(29, "local"), null);
  assert.equal(scrobbleThreshold(40, "local"), 20);
  assert.equal(scrobbleThreshold(600, "local"), 240);
  assert.equal(scrobbleThreshold(undefined, "local"), 30);
  assert.equal(scrobbleThreshold(undefined, "network"), null);
  assert.equal(scrobbleThreshold(0, "ytdlp"), null);
});

// ---- playback session ----

const T = { artist: "A", track: "T" };
const sample = (over: Partial<PlayerSample> = {}): PlayerSample => ({
  paused: false,
  idle: false,
  position: 0,
  duration: 200,
  loopFile: false,
  speed: 1,
  ...over,
});

/** Drives a session with one tick per second (position advancing 1 s/s unless overridden). */
function run(s: PlaybackSession, start: number, seconds: number, f: (i: number) => Partial<PlayerSample> = () => ({})) {
  const out: { at: number; type: string }[] = [];
  for (let i = 0; i <= seconds; i++) {
    for (const a of s.tick(start + i * 1000, sample({ position: i, ...f(i) }))) out.push({ at: i, type: a.type });
  }
  return out;
}

test("nothing happens before playback-restart", () => {
  const s = new PlaybackSession(T, "local");
  assert.deepEqual(run(s, 0, 5), []);
});

test("nowplaying at start, scrobble after half the length, timestamp = start", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(1_700_000_000_000);
  const actions: { at: number; type: string; timestamp?: number }[] = [];
  for (let i = 0; i <= 120; i++) {
    for (const a of s.tick(1_700_000_000_000 + i * 1000, sample({ position: i }))) {
      actions.push({ at: i, type: a.type, ...(a.type === "scrobble" ? { timestamp: a.timestamp } : {}) });
    }
  }
  assert.deepEqual(actions, [
    { at: 0, type: "nowplaying" },
    { at: 100, type: "scrobble", timestamp: 1_700_000_000 },
  ]);
});

test("paused time is not counted; nowplaying waits for unpause", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  // paused for the first 50 s (position frozen at 0), then playing
  const actions = run(s, 0, 160, (i) => ({ paused: i < 50, position: Math.max(0, i - 50) }));
  assert.deepEqual(actions, [
    { at: 50, type: "nowplaying" },
    { at: 150, type: "scrobble" },
  ]);
});

test("seeking does not add played time (wall clock only)", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  const actions = run(s, 0, 60, (i) => ({ position: i < 10 ? i : 180 + i }));
  assert.equal(actions.some((a) => a.type === "scrobble"), false);
});

test("a delayed tick counts in full when the position moved on (timer throttling)", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  s.tick(0, sample({ position: 0 }));
  s.tick(10_000, sample({ position: 10 }));
  assert.equal(s.playedSeconds, 10);
});

test("system sleep counts nothing (position did not move)", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  s.tick(0, sample({ position: 5 }));
  s.tick(3_600_000, sample({ position: 5.1 }));
  assert.ok(s.playedSeconds < 0.5);
});

test("without a position, a gap counts at most 2 s", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  s.tick(0, sample({ position: null }));
  s.tick(3_600_000, sample({ position: null }));
  assert.equal(s.playedSeconds, 2);
});

test("slow and fast playback count wall-clock time", () => {
  const slow = new PlaybackSession(T, "local");
  slow.onPlaybackRestart(0);
  slow.tick(0, sample({ position: 0, speed: 0.5 }));
  slow.tick(10_000, sample({ position: 5, speed: 0.5 }));
  assert.equal(slow.playedSeconds, 10);
  const fast = new PlaybackSession(T, "local");
  fast.onPlaybackRestart(0);
  fast.tick(0, sample({ position: 0, speed: 2 }));
  fast.tick(10_000, sample({ position: 20, speed: 2 }));
  assert.equal(fast.playedSeconds, 10);
});

test("seeking backwards counts nothing for that interval", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  s.tick(0, sample({ position: 100 }));
  s.tick(1000, sample({ position: 10 }));
  assert.equal(s.playedSeconds, 0);
});

test("too short files are skipped once", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  assert.deepEqual(run(s, 0, 5, () => ({ duration: 20 })), [{ at: 0, type: "skip" }]);
});

test("loop-file wrap starts a new play and scrobbles again", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  // 40 s file looping: position = i mod 40
  const actions = run(s, 0, 100, (i) => ({ duration: 40, position: i % 40, loopFile: true }));
  assert.deepEqual(actions, [
    { at: 0, type: "nowplaying" },
    { at: 20, type: "scrobble" },
    { at: 40, type: "nowplaying" },
    { at: 60, type: "scrobble" },
    { at: 80, type: "nowplaying" },
    { at: 100, type: "scrobble" },
  ]);
});

test("seeking back to the start without loop-file is not a new play", () => {
  const s = new PlaybackSession(T, "local");
  s.onPlaybackRestart(0);
  const actions = run(s, 0, 60, (i) => ({ duration: 40, position: i < 39 ? i : 0 }));
  assert.deepEqual(actions, [
    { at: 0, type: "nowplaying" },
    { at: 20, type: "scrobble" },
  ]);
});

test("network media with a growing duration is treated as live and skipped", () => {
  const s = new PlaybackSession(T, "network");
  s.onPlaybackRestart(0);
  const actions = run(s, 0, 10, (i) => ({ duration: 40 + i * 5 }));
  assert.equal(actions[actions.length - 1]?.type, "skip");
  assert.equal(actions.some((a) => a.type === "scrobble"), false);
});

test("network media waits for the duration before nowplaying", () => {
  const s = new PlaybackSession(T, "network");
  s.onPlaybackRestart(0);
  const actions = run(s, 0, 5, (i) => ({ duration: i < 3 ? null : 300 }));
  assert.deepEqual(actions, [{ at: 3, type: "nowplaying" }]);
});
