// Scrobbler Probe - global entry.
// Runs environment checks at startup and provides Last.fm auth/HTTP probes via the Plugin menu.
// Everything is logged to @data/global.jsonl (and to the IINA log viewer).

const { console, menu, http, utils, preferences, file, global } = iina;

const LOG_PATH = `@data/global-${Date.now().toString(36)}.jsonl`;
const API = "https://ws.audioscrobbler.com/2.0/";
const AUTH_PAGE = "https://www.last.fm/api/auth/";
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

function mask(s) {
  if (!s) return s;
  return `${String(s).slice(0, 4)}…(len ${String(s).length})`;
}

log("global-start", { iinaKeys: Object.keys(iina) });

// ---- 1. JS environment ----
log("env", {
  typeof: {
    fetch: typeof fetch,
    crypto: typeof crypto,
    TextEncoder: typeof TextEncoder,
    URLSearchParams: typeof URLSearchParams,
    atob: typeof atob,
    setTimeout: typeof setTimeout,
    setInterval: typeof setInterval,
    require: typeof require,
    unescape: typeof unescape,
    encodeURIComponent: typeof encodeURIComponent,
    Promise: typeof Promise,
    localStorage: typeof localStorage,
  },
  syntax: (() => {
    const o = { a: { b: 1 } };
    return { optionalChaining: o?.a?.b, nullish: null ?? "ok", spread: { ...o.a }.b };
  })(),
});

// ---- 2. MD5 via require ----
let md5 = null;
try {
  md5 = require("./md5.js").md5;
  const vectors = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["日本語のアーティスト", "29772ebcad669e0075d1f52df091889b"],
  ];
  log("md5", vectors.map(([s, want]) => ({ s, got: md5(s), ok: md5(s) === want })));
} catch (e) {
  log("md5-error", { message: String(e) });
}

function sign(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort();
  return md5(keys.map((k) => k + params[k]).join("") + secret);
}

// ---- 3. Last.fm HTTP wrapper capturing both resolve and reject shapes ----
async function lastfm(method, params, { signed, httpMethod, apiKey, apiSecret }) {
  const p = {};
  for (const k of Object.keys(params)) p[k] = String(params[k]);
  p.method = method;
  p.api_key = apiKey;
  if (signed) p.api_sig = sign(p, apiSecret);
  p.format = "json";
  const t0 = Date.now();
  try {
    const res =
      httpMethod === "POST"
        ? await http.post(API, { params: {}, headers: {}, data: p })
        : await http.get(API, { params: p, headers: {}, data: {} });
    return {
      outcome: "resolved",
      ms: Date.now() - t0,
      statusCode: res.statusCode,
      reason: res.reason,
      typeofData: typeof res.data,
      data: res.data,
      text: typeof res.text === "string" ? res.text.slice(0, 500) : res.text,
    };
  } catch (e) {
    return {
      outcome: "rejected",
      ms: Date.now() - t0,
      isError: e instanceof Error,
      keys: e && typeof e === "object" ? Object.keys(e) : null,
      statusCode: e && e.statusCode,
      reason: e && e.reason,
      typeofData: typeof (e && e.data),
      data: e && e.data,
      text: e && typeof e.text === "string" ? e.text.slice(0, 500) : null,
      message: String(e),
    };
  }
}

function creds() {
  return {
    apiKey: String(preferences.get("api_key") || ""),
    apiSecret: String(preferences.get("api_secret") || ""),
  };
}

// ---- 4. utils.exec resolution for yt-dlp ----
async function probeExec() {
  const candidates = ["yt-dlp", "youtube-dl", "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
  for (const c of candidates) {
    const r = { candidate: c };
    try {
      r.fileInPath = utils.fileInPath(c);
    } catch (e) {
      r.fileInPathError = String(e);
    }
    const t0 = Date.now();
    try {
      const res = await utils.exec(c, ["--version"]);
      r.exec = {
        status: res.status,
        stdout: String(res.stdout || "").trim().slice(0, 200),
        stderr: String(res.stderr || "").trim().slice(0, 300),
      };
    } catch (e) {
      r.execError = String(e && e.message ? e.message : e);
    }
    r.ms = Date.now() - t0;
    log("exec", r);
  }
}

async function startupTests() {
  await probeExec();
  // Invalid API key: shows how Last.fm errors come back through iina.http.
  const bogus = { apiKey: "0123456789abcdef0123456789abcdef", apiSecret: "x" };
  log("http-invalid-key-GET", await lastfm("auth.getSession", { token: "probe" }, { signed: true, httpMethod: "GET", ...bogus }));
  log("http-invalid-key-POST", await lastfm("auth.getSession", { token: "probe" }, { signed: true, httpMethod: "POST", ...bogus }));
  const c = creds();
  if (c.apiKey && c.apiSecret) {
    // Valid key but bogus token → expected error (likely 4 / 14 / 15).
    log("http-bogus-token-GET", await lastfm("auth.getSession", { token: "probe-invalid-token" }, { signed: true, httpMethod: "GET", ...c }));
  } else {
    log("note", "api_key/api_secret not set; Last.fm auth probes skipped");
  }
  log("startup-tests-done", {});
}

// ---- 5. Last.fm desktop auth flow (menu driven) ----
let pollTimer = null;

async function authFlow() {
  const c = creds();
  if (!c.apiKey || !c.apiSecret) {
    log("auth", "api_key/api_secret not set (Settings > Plugins > Scrobbler Probe)");
    return;
  }
  if (pollTimer) clearInterval(pollTimer);
  const unsigned = await lastfm("auth.getToken", {}, { signed: false, httpMethod: "GET", ...c });
  log("auth.getToken-unsigned", { ...unsigned, data: unsigned.data && unsigned.data.token ? { token: mask(unsigned.data.token) } : unsigned.data });
  const signed = await lastfm("auth.getToken", {}, { signed: true, httpMethod: "GET", ...c });
  log("auth.getToken-signed", { ...signed, data: signed.data && signed.data.token ? { token: mask(signed.data.token) } : signed.data });
  const token = (signed.data && signed.data.token) || (unsigned.data && unsigned.data.token);
  if (!token) return;

  // Before approval: what does getSession return?
  const before = await lastfm("auth.getSession", { token }, { signed: true, httpMethod: "GET", ...c });
  log("auth.getSession-before-approval", before);

  const url = `${AUTH_PAGE}?api_key=${encodeURIComponent(c.apiKey)}&token=${encodeURIComponent(token)}`;
  log("auth-open", { opened: utils.open(url) });

  let tries = 0;
  pollTimer = setInterval(async () => {
    tries++;
    const r = await lastfm("auth.getSession", { token }, { signed: true, httpMethod: "GET", ...c });
    const err = r.data && r.data.error;
    const session = r.data && r.data.session;
    log("auth.getSession-poll", { tries, outcome: r.outcome, statusCode: r.statusCode, error: err, message: r.data && r.data.message, gotSession: !!session });
    if (session) {
      clearInterval(pollTimer);
      pollTimer = null;
      preferences.set("session_key", session.key);
      preferences.set("session_name", session.name);
      preferences.sync();
      log("auth-success", { name: session.name, key: mask(session.key), subscriber: session.subscriber });
    } else if (tries >= 60 || (err && err !== 14)) {
      clearInterval(pollTimer);
      pollTimer = null;
      log("auth-poll-stopped", { tries, lastError: err });
    }
  }, 5000);
}

async function nowPlayingTest() {
  const c = creds();
  const sk = String(preferences.get("session_key") || "");
  if (!sk) {
    log("nowplaying", "no session_key; run auth first");
    return;
  }
  // Japanese metadata exercises UTF-8 MD5 signing + form encoding end to end.
  const r = await lastfm(
    "track.updateNowPlaying",
    { artist: "署名テスト アーティスト", track: "UTF-8 & 記号 = ? / テスト", album: "Probe", duration: 200, sk },
    { signed: true, httpMethod: "POST", ...c },
  );
  log("track.updateNowPlaying", r);
}

// ---- 6. global <-> main messaging ----
global.onMessage("probe-hello", (data, player) => {
  log("msg-from-main", { data, player, typeofPlayer: typeof player });
  // Bisect switch: false = do not reply to the player (tests main→global only).
  // Synchronous reply from inside this handler corrupted the JSC heap in IINA 1.5.1
  // (crash on GC/quit, ack never delivered). Testing a deferred reply with a JSON string payload.
  const SEND_ACK = true;
  if (!SEND_ACK) return;
  setTimeout(() => {
    try {
      global.postMessage(player, "probe-ack", JSON.stringify({ at: Date.now() }));
      log("msg-ack-sent", { player, deferred: true });
    } catch (e) {
      log("msg-ack-error", { message: String(e) });
    }
  }, 0);
});

menu.addItem(menu.item("Probe: Last.fm auth (getToken → browser → poll getSession)", () => authFlow()));
menu.addItem(menu.item("Probe: Last.fm updateNowPlaying (Japanese)", () => nowPlayingTest()));
menu.addItem(menu.item("Probe: rerun startup tests", () => startupTests()));

// Bisect switch: set to false to skip exec/http probes at startup.
const RUN_STARTUP_TESTS = false;
if (RUN_STARTUP_TESTS) startupTests();
