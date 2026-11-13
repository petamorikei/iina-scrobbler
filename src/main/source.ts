// Where the current file comes from (docs/design.md §3, research.md §8.4, §8.5.2).
import type { Source } from "../shared/messages.ts";

export interface SourceInput {
  /** mpv `path`: the file path or the URL that was opened. */
  path: string;
  /** mpv `stream-open-filename` at iina.file-loaded (yt-dlp replaces it with the media URL). */
  streamOpenFilename: string;
  /** Keys of mpv `metadata`. */
  metadataKeys: readonly string[];
}

export interface SourceInfo {
  source: Source;
  /** Internet radio (ICY). Not scrobbled in v1 (D3). */
  radio: boolean;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function classifySource(input: SourceInput): SourceInfo {
  const { path, streamOpenFilename } = input;
  const radio = input.metadataKeys.some((k) => k.toLowerCase().startsWith("icy-"));
  if (!URL_SCHEME.test(path) || /^file:\/\//i.test(path)) return { source: "local", radio: false };
  if (/^https?:\/\//i.test(path) && streamOpenFilename !== "" && streamOpenFilename !== path) {
    return { source: "ytdlp", radio };
  }
  return { source: "network", radio };
}

export interface TrackInfo {
  type: string;
  albumart?: boolean;
  image?: boolean;
}

/** True when the file has a real video track (cover art embedded in audio files does not count). */
export function hasVideo(tracks: readonly TrackInfo[]): boolean {
  return tracks.some((t) => t.type === "video" && !t.albumart && !t.image);
}
