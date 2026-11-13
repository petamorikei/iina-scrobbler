import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { apiSignature, buildParams } from "../src/services/lastfm/signature.ts";

const nodeMd5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const creds = { apiKey: "KEY", apiSecret: "SECRET" };

test("signature sorts keys, concatenates key+value, appends secret", () => {
  const sig = apiSignature({ token: "T", method: "auth.getSession", api_key: "KEY" }, "SECRET");
  assert.equal(sig, nodeMd5("api_keyKEYmethodauth.getSessiontokenTSECRET"));
});

test("format and callback are excluded from the signature", () => {
  const base = { method: "m", api_key: "KEY" };
  assert.equal(apiSignature({ ...base, format: "json", callback: "cb" }, "S"), apiSignature(base, "S"));
});

test("batch scrobble keys sort by code unit (albumArtist[0] before album[0])", () => {
  const params = { "album[0]": "B", "albumArtist[0]": "A", "artist[0]": "C" };
  assert.equal(apiSignature(params, "S"), nodeMd5("albumArtist[0]Aalbum[0]Bartist[0]CS"));
});

test("buildParams stringifies, drops empty values, signs, then adds format", () => {
  const p = buildParams(
    "track.updateNowPlaying",
    { artist: "署名テスト アーティスト", track: "UTF-8 & 記号 = ? / テスト", album: "", duration: 200, sk: "SK" },
    creds,
    true,
  );
  assert.equal(p.duration, "200");
  assert.equal("album" in p, false);
  assert.equal(p.format, "json");
  assert.equal(p.method, "track.updateNowPlaying");
  assert.equal(p.api_key, "KEY");
  const expected = nodeMd5(
    "api_keyKEY" +
      "artist署名テスト アーティスト" +
      "duration200" +
      "methodtrack.updateNowPlaying" +
      "skSK" +
      "trackUTF-8 & 記号 = ? / テスト" +
      "SECRET",
  );
  assert.equal(p.api_sig, expected);
  for (const v of Object.values(p)) assert.equal(typeof v, "string");
});

test("unsigned calls carry no api_sig", () => {
  const p = buildParams("auth.getToken", {}, creds, false);
  assert.equal("api_sig" in p, false);
  assert.deepEqual(p, { method: "auth.getToken", api_key: "KEY", format: "json" });
});
