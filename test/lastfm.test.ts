import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpFn, HttpOutcome } from "../src/services/http.ts";
import { LASTFM_API_URL, LastFm, parseScrobbleResponse } from "../src/services/lastfm/lastfm.ts";
import { apiSignature } from "../src/services/lastfm/signature.ts";
import { decode, encode } from "../src/shared/messages.ts";

const creds = { apiKey: "KEY", apiSecret: "SECRET" };

interface Call {
  method: string;
  url: string;
  params: Record<string, string>;
}

function fake(...outcomes: HttpOutcome[]): { http: HttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpFn = async (method, url, params) => {
    calls.push({ method, url, params });
    const next = outcomes.shift();
    if (!next) throw new Error("unexpected HTTP call");
    return next;
  };
  return { http, calls };
}

const ok = (data: unknown): HttpOutcome => ({ kind: "response", statusCode: 200, data });
const apiError = (statusCode: number, error: number, message = "msg"): HttpOutcome => ({
  kind: "response",
  statusCode,
  data: { error, message },
});

function assertSigned(params: Record<string, string>) {
  const { api_sig, ...rest } = params;
  assert.equal(api_sig, apiSignature(rest, creds.apiSecret));
}

// ---- auth ----

test("beginAuth: signed GET auth.getToken, returns the approval URL", async () => {
  const { http, calls } = fake(ok({ token: "TOK/EN" }));
  const r = await new LastFm(http, creds).beginAuth();
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, LASTFM_API_URL);
  assert.equal(calls[0]!.params.method, "auth.getToken");
  assertSigned(calls[0]!.params);
  assert.equal(r.token, "TOK/EN");
  assert.equal(r.url, "https://www.last.fm/api/auth/?api_key=KEY&token=TOK%2FEN");
});

test("pollAuth: error 14 (as observed: HTTP 403) means waiting", async () => {
  const { http } = fake(apiError(403, 14, "Unauthorized Token - This token has not been authorized"));
  assert.deepEqual(await new LastFm(http, creds).pollAuth("t"), { status: "waiting" });
});

test("pollAuth: session is returned on approval", async () => {
  const { http, calls } = fake(ok({ session: { name: "user", key: "SK", subscriber: 0 } }));
  const r = await new LastFm(http, creds).pollAuth("t");
  assert.deepEqual(r, { status: "approved", sessionKey: "SK", userName: "user" });
  assert.equal(calls[0]!.params.token, "t");
  assertSigned(calls[0]!.params);
});

test("pollAuth: expired token fails for good, network errors are retryable", async () => {
  const lf = new LastFm(fake(apiError(403, 15), { kind: "network", message: "offline" }).http, creds);
  const expired = await lf.pollAuth("t");
  assert.equal(expired.status, "failed");
  assert.equal(expired.status === "failed" && expired.retryable, false);
  const offline = await lf.pollAuth("t");
  assert.equal(offline.status === "failed" && offline.retryable, true);
});

// ---- nowPlaying ----

test("nowPlaying: signed POST with sk, ok when ignoredMessage code is 0", async () => {
  const { http, calls } = fake(ok({ nowplaying: { ignoredMessage: { code: "0", "#text": "" } } }));
  const lf = new LastFm(http, creds);
  lf.session = "SK";
  const r = await lf.nowPlaying({ artist: "A", track: "T", album: "", duration: 199.6 });
  assert.deepEqual(r, { status: "ok" });
  const p = calls[0]!.params;
  assert.equal(calls[0]!.method, "POST");
  assert.equal(p.method, "track.updateNowPlaying");
  assert.equal(p.sk, "SK");
  assert.equal(p.duration, "200");
  assert.equal("album" in p, false);
  assertSigned(p);
});

test("nowPlaying without a session does not call the API", async () => {
  const { http, calls } = fake();
  const r = await new LastFm(http, creds).nowPlaying({ artist: "A", track: "T" });
  assert.equal(r.status, "auth-error");
  assert.equal(r.code, undefined);
  assert.equal(calls.length, 0);
});

// ---- scrobble ----

test("scrobble: indexed params, one result per entry", async () => {
  const { http, calls } = fake(
    ok({
      scrobbles: {
        "@attr": { accepted: 1, ignored: 1 },
        scrobble: [
          { ignoredMessage: { code: "0", "#text": "" } },
          { ignoredMessage: { code: "1", "#text": "Artist was ignored" } },
        ],
      },
    }),
  );
  const lf = new LastFm(http, creds);
  lf.session = "SK";
  const r = await lf.scrobble([
    { artist: "A", track: "T", timestamp: 1700000000.9, album: "Al", albumArtist: "AA", duration: 240 },
    { artist: "B", track: "U", timestamp: 1700000300 },
  ]);
  assert.deepEqual(r, [{ status: "ok" }, { status: "ignored", code: "1", message: "Artist was ignored" }]);
  const p = calls[0]!.params;
  assert.equal(p.method, "track.scrobble");
  assert.equal(p["artist[0]"], "A");
  assert.equal(p["timestamp[0]"], "1700000000");
  assert.equal(p["albumArtist[0]"], "AA");
  assert.equal(p["duration[0]"], "240");
  assert.equal(p["track[1]"], "U");
  assert.equal("album[1]" in p, false);
  assertSigned(p);
});

test("scrobble: a single result comes back as an object, not an array", () => {
  const r = parseScrobbleResponse({ scrobbles: { scrobble: { ignoredMessage: { code: "0" } } } }, 1);
  assert.deepEqual(r, [{ status: "ok" }]);
});

test("scrobble: daily limit (ignored code 5) is retried, not dropped", () => {
  const r = parseScrobbleResponse({ scrobbles: { scrobble: { ignoredMessage: { code: "5", "#text": "Daily limit" } } } }, 1);
  assert.equal(r[0]!.status, "retry");
});

test("scrobble: error classification", async () => {
  const cases: [HttpOutcome, string][] = [
    [apiError(403, 9), "auth-error"],
    [apiError(503, 11), "retry"],
    [apiError(200, 16), "retry"],
    [apiError(429, 29), "retry"],
    [apiError(403, 10), "retry"],
    [apiError(400, 6), "drop"],
    [apiError(403, 13), "drop"],
    [{ kind: "response", statusCode: 502, data: null }, "retry"],
    [{ kind: "response", statusCode: 404, data: null }, "drop"],
    [{ kind: "network", message: "offline" }, "retry"],
  ];
  for (const [outcome, want] of cases) {
    const lf = new LastFm(fake(outcome).http, creds);
    lf.session = "SK";
    const r = await lf.scrobble([
      { artist: "A", track: "T", timestamp: 1 },
      { artist: "B", track: "U", timestamp: 2 },
    ]);
    assert.deepEqual(
      r.map((x) => x.status),
      [want, want],
      JSON.stringify(outcome),
    );
  }
});

test("scrobble rejects more than 50 entries", async () => {
  const lf = new LastFm(fake().http, creds);
  lf.session = "SK";
  const many = Array.from({ length: 51 }, (_, i) => ({ artist: "A", track: "T", timestamp: i }));
  await assert.rejects(lf.scrobble(many));
});

// ---- messages ----

test("messages round-trip as JSON strings and reject malformed input", () => {
  const raw = encode("scrobble", { entry: { artist: "A", track: "T", timestamp: 1 }, source: "local" });
  assert.equal(typeof raw, "string");
  assert.deepEqual(decode("scrobble", raw), { entry: { artist: "A", track: "T", timestamp: 1 }, source: "local" });
  assert.equal(decode("scrobble", { entry: { artist: "A", track: "T", timestamp: 1 } }), null);
  assert.equal(decode("scrobble", JSON.stringify({ entry: { artist: "A", track: "T" } })), null);
  assert.equal(decode("nowplaying", JSON.stringify({ track: { artist: "", track: "T" } })), null);
  assert.equal(decode("nowplaying", "{"), null);
});
