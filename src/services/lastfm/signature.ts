// Last.fm (AudioScrobbler 2.0) request signing.
// https://www.last.fm/api/authspec#_8-signing-calls
import { md5 } from "../md5.ts";

export type Params = Record<string, string>;

/** Parameters that are never part of api_sig. */
const UNSIGNED = new Set(["format", "callback"]);

/**
 * api_sig = md5( concat(sorted(key + value)) + secret ), over UTF-8 bytes.
 * Keys are sorted by UTF-16 code unit (Array.prototype.sort), as web-scrobbler does;
 * for the ASCII parameter names Last.fm uses this equals byte order
 * (e.g. "albumArtist[0]" < "album[0]" because "A" < "[").
 */
export const apiSignature = (params: Params, secret: string): string => {
  const keys = Object.keys(params)
    .filter((k) => !UNSIGNED.has(k))
    .sort();
  let s = "";
  for (const k of keys) s += k + params[k];
  return md5(s + secret);
};

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * Builds the full parameter set for a Last.fm call: adds method and api_key, signs
 * when requested, and asks for JSON. All values are strings because iina.http drops
 * the whole dictionary if any value is not a string.
 */
export const buildParams = (
  method: string,
  params: Record<string, string | number | undefined>,
  creds: Credentials,
  signed: boolean,
): Params => {
  const p: Params = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    p[k] = String(v);
  }
  p.method = method;
  p.api_key = creds.apiKey;
  if (signed) p.api_sig = apiSignature(p, creds.apiSecret);
  p.format = "json";
  return p;
};
