// Splitting a one-line title ("Artist - Title") and cleaning up field values.
//
// The separator list and the first-match split are ported from web-scrobbler
// (src/core/content/util.ts: defaultSeparators, findSeparator, splitString).
// web-scrobbler: Copyright (c) 2010-2023 David Šabata & Web Scrobbler Team, MIT License.

export const DEFAULT_SEPARATORS = [
  " -- ",
  "--",
  " ~ ",
  " - ",
  " – ",
  " — ",
  " // ",
  " -",
  " –",
  " —",
  "- ",
  "– ",
  "— ",
  ":",
  "|",
  "///",
  "/",
  "~",
] as const;

/**
 * Separators for file names. ":" and "/" cannot appear in macOS file names as typed,
 * and "~" / "|" are too often part of a plain title there.
 */
export const FILENAME_SEPARATORS = DEFAULT_SEPARATORS.filter((s) => s.trim() !== "" && !/^[:/|~]+$/.test(s));

export interface ArtistTitle {
  artist: string;
  title: string;
}

/** Splits at the first separator (in list order) that occurs. Both halves must be non-empty. */
export function splitArtistTitle(str: string, separators: readonly string[] = DEFAULT_SEPARATORS): ArtistTitle | null {
  for (const sep of separators) {
    const i = str.indexOf(sep);
    if (i > -1) {
      const artist = clean(str.slice(0, i));
      const title = clean(str.slice(i + sep.length));
      return artist && title ? { artist, title } : null;
    }
  }
  return null;
}

/** trim, NBSP → space, collapse runs of whitespace, Unicode NFC. */
export function clean(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
}

const MEDIA_EXTENSION =
  /\.(mp3|m4a|m4b|aac|flac|alac|ogg|oga|opus|wav|aiff?|wma|ape|wv|dsf|dff|mka|mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m2ts)$/i;

/** Removes a known media file extension. */
export function stripExtension(name: string): string {
  return name.replace(MEDIA_EXTENSION, "");
}

/**
 * Removes a leading track number written with punctuation ("01 - ", "01. ", "1_", "03)").
 * A bare number followed by a space is kept ("2 Unlimited", "10cc").
 */
export function stripTrackNumber(name: string): string {
  const stripped = name.replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, "");
  return stripped === "" ? name : stripped;
}

/** "05-Artist - Title.mp3" → { artist: "Artist", title: "Title" } */
export function parseFileName(fileName: string): ArtistTitle | null {
  const base = stripTrackNumber(clean(stripExtension(clean(fileName))));
  return splitArtistTitle(base, FILENAME_SEPARATORS);
}
