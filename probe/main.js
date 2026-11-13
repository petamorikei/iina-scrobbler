// Scrobbler Probe - main entry (one instance per player).
// Logs event order/arguments, metadata snapshots, polled playback state and yt-dlp output
// to @data/player-<instanceId>.jsonl.

const { console, core, mpv, event, file, global, utils } = iina;

// Bisect switches.
const F = {
  counted: true, // high-frequency mpv.*.changed listeners (time-pos etc.)
  logged: true, // low-frequency event listeners
  timers: true, // 1 s sampler, 5 s summary, delayed snapshots
  messaging: true, // global.postMessage / onMessage
  osd: true,
  ytdlp: true,
};

const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const LOG_PATH = `@data/player-${instanceId}.jsonl`;
const lines = [];

function safeJSON(v) {
  try {
    return JSON.parse(JSON.stringify(v === undefined ? null : v));
  } catch (e) {
    return `<unserializable: ${String(v)}>`;
  }
}

function log(tag, data) {
  const entry = { t: new Date().toISOString(), tag, data: safeJSON(data) };
  const line = JSON.stringify(entry);
  lines.push(line);
  console.log(`[probe] ${line.slice(0, 2000)}`);
  try {
    file.write(LOG_PATH, lines.join("\n") + "\n");
  } catch (e) {
    console.error(`[probe] log write failed: ${e}`);
  }
}

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return `<error: ${String(e)}>`;
  }
}

function status() {
  return safe(() => {
    const s = core.status;
    return {
      paused: s.paused,
      idle: s.idle,
      position: s.position,
      duration: s.duration,
      speed: s.speed,
      url: s.url,
      title: s.title,
      isNetworkResource: s.isNetworkResource,
      videoWidth: s.videoWidth,
      videoHeight: s.videoHeight,
    };
  });
}

log("main-start", { instanceId });

// ---- metadata snapshot ----
function snapshot(reason) {
  const str = (p) => safe(() => mpv.getString(p));
  const nat = (p) => safe(() => mpv.getNative(p));
  const tracks = safe(() =>
    (mpv.getNative("track-list") || []).map((t) => ({
      type: t.type,
      id: t.id,
      codec: t.codec,
      albumart: t.albumart,
      image: t.image,
      selected: t.selected,
      title: t.title,
      external: t.external,
    })),
  );
  log("snapshot", {
    reason,
    status: status(),
    path: str("path"),
    filename: str("filename"),
    mediaTitle: str("media-title"),
    streamOpenFilename: str("stream-open-filename"),
    fileFormat: str("file-format"),
    duration: nat("duration"),
    durationViaGetNumber: safe(() => mpv.getNumber("duration")),
    timePos: nat("time-pos"),
    pause: safe(() => mpv.getFlag("pause")),
    metadata: nat("metadata"),
    filteredMetadata: nat("filtered-metadata"),
    byKey: {
      artist: str("metadata/by-key/artist"),
      ARTIST_upper: str("metadata/by-key/ARTIST"),
      title: str("metadata/by-key/title"),
      album: str("metadata/by-key/album"),
      album_artist: str("metadata/by-key/album_artist"),
      albumartist: str("metadata/by-key/albumartist"),
      track: str("metadata/by-key/track"),
      tracknumber: str("metadata/by-key/tracknumber"),
      icyTitle: str("metadata/by-key/icy-title"),
      uploader: str("metadata/by-key/uploader"),
    },
    chapter: nat("chapter"),
    chapterList: nat("chapter-list"),
    chapterMetadata: nat("chapter-metadata"),
    tracks,
    playlistPos: nat("playlist-pos"),
    playlistCount: nat("playlist-count"),
    loopFile: str("loop-file"),
    nonexistent: {
      getNumber: safe(() => mpv.getNumber("probe-nonexistent-prop")),
      getString: safe(() => mpv.getString("probe-nonexistent-prop")),
      getNative: safe(() => mpv.getNative("probe-nonexistent-prop")),
    },
  });
}

// ---- events: low-frequency ones are logged on every fire ----
const LOGGED_EVENTS = [
  "iina.window-loaded",
  "iina.file-started",
  "iina.file-loaded",
  "iina.mpv-initialized",
  "iina.window-will-close",
  "iina.window-did-close",
  "iina.music-mode.changed",
  "mpv.start-file",
  "mpv.file-loaded",
  "mpv.end-file",
  "mpv.seek",
  "mpv.playback-restart",
  "mpv.idle",
  "mpv.shutdown",
  "mpv.audio-reconfig",
  "mpv.video-reconfig",
  "mpv.pause.changed",
  "mpv.metadata.changed",
  "mpv.chapter.changed",
  "mpv.duration.changed",
  "mpv.speed.changed",
  "mpv.playlist-pos.changed",
  "mpv.eof-reached.changed",
  "mpv.idle-active.changed",
];
// High-frequency ones are counted and summarized every 5 s.
const COUNTED_EVENTS = ["mpv.time-pos.changed", "mpv.playback-time.changed", "mpv.percent-pos.changed"];

for (const name of F.logged ? LOGGED_EVENTS : []) {
  const r = safe(() =>
    event.on(name, (...args) => {
      log("event", {
        name,
        args,
        pos: safe(() => core.status.position),
        paused: safe(() => core.status.paused),
        idle: safe(() => core.status.idle),
      });
      if (name === "iina.file-loaded") onFileLoaded(args[0]);
      if (name === "mpv.metadata.changed") snapshot("metadata.changed");
    }),
  );
  log("subscribe", { name, result: r });
}

const counters = {};
for (const name of F.counted ? COUNTED_EVENTS : []) {
  counters[name] = { count: 0, firstArgs: [], lastArg: null };
  const r = safe(() =>
    event.on(name, (...args) => {
      const c = counters[name];
      c.count++;
      c.lastArg = args[0];
      if (c.firstArgs.length < 3) c.firstArgs.push(args);
    }),
  );
  log("subscribe", { name, result: r });
}

// ---- polling sampler: what a 1 s setInterval would see ----
let samples = [];
if (F.timers)
  setInterval(() => {
    const s = safe(() => core.status);
    samples.push(typeof s === "object" ? [Math.round((s.position || 0) * 10) / 10, s.paused, s.idle] : s);
  }, 1000);

if (F.timers)
  setInterval(() => {
    const anyCount = Object.values(counters).some((c) => c.count > 0);
    if (!anyCount && samples.length === 0) return;
    const idle = safe(() => core.status.idle);
    if (idle === true && !anyCount) {
      samples = [];
      return;
    }
    log("window-5s", {
      counters: safeJSON(counters),
      samples,
      mediaTitle: safe(() => mpv.getString("media-title")),
      icyTitle: safe(() => mpv.getString("metadata/by-key/icy-title")),
      duration: safe(() => mpv.getNative("duration")),
      loopFile: safe(() => mpv.getString("loop-file")),
      loopPlaylist: safe(() => mpv.getString("loop-playlist")),
    });
    for (const k of Object.keys(counters)) counters[k] = { count: 0, firstArgs: counters[k].firstArgs, lastArg: null };
    samples = [];
  }, 5000);

// ---- per file ----
let fileSeq = 0;
function onFileLoaded(url) {
  const seq = ++fileSeq;
  snapshot("file-loaded");
  if (F.timers) setTimeout(() => seq === fileSeq && snapshot("file-loaded+3s"), 3000);
  if (F.timers) setTimeout(() => seq === fileSeq && snapshot("file-loaded+15s"), 15000);
  if (F.osd) safe(() => core.osd(`Scrobbler Probe: file loaded #${seq}`));
  if (F.messaging) safe(() => global.postMessage("probe-hello", { instanceId, seq, url }));
  const path = safe(() => mpv.getString("path"));
  if (typeof path === "string" && /^https?:\/\//.test(path)) F.ytdlp && ytdlpProbe(path);
}

if (F.messaging) global.onMessage("probe-ack", (data) => log("msg-ack-received", data));

// ---- yt-dlp metadata (option B) ----
const YTDLP_CANDIDATES = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "youtube-dl"];

async function ytdlpProbe(url) {
  for (const bin of YTDLP_CANDIDATES) {
    const t0 = Date.now();
    try {
      const res = await utils.exec(bin, [
        "-J",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--ignore-no-formats-error",
        url,
      ]);
      const ms = Date.now() - t0;
      if (res.status !== 0) {
        log("ytdlp", { bin, ms, status: res.status, stderr: String(res.stderr || "").slice(0, 800) });
        continue;
      }
      const j = JSON.parse(res.stdout);
      log("ytdlp", {
        bin,
        ms,
        stdoutBytes: res.stdout.length,
        fields: {
          extractor: j.extractor,
          id: j.id,
          title: j.title,
          fulltitle: j.fulltitle,
          uploader: j.uploader,
          uploader_id: j.uploader_id,
          channel: j.channel,
          channel_id: j.channel_id,
          artist: j.artist,
          artists: j.artists,
          creator: j.creator,
          creators: j.creators,
          track: j.track,
          album: j.album,
          album_artist: j.album_artist,
          album_artists: j.album_artists,
          release_year: j.release_year,
          categories: j.categories,
          duration: j.duration,
          is_live: j.is_live,
          was_live: j.was_live,
          webpage_url: j.webpage_url,
          descriptionHead: typeof j.description === "string" ? j.description.slice(0, 400) : j.description,
          chapters: Array.isArray(j.chapters)
            ? { count: j.chapters.length, first: j.chapters.slice(0, 3) }
            : j.chapters,
        },
      });
      return;
    } catch (e) {
      log("ytdlp-error", { bin, ms: Date.now() - t0, message: String(e && e.message ? e.message : e) });
    }
  }
}
