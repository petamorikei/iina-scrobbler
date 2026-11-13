// Building a Track for local files and plain network media (docs/design.md §4.1).
// yt-dlp sources are handled in step 5; until then they fall back to the title split.
import type { Track } from "../services/types.ts";
import type { Source } from "../shared/messages.ts";
import { clean, parseFileName, stripExtension, stripTrackNumber } from "./title-parser.ts";

export interface MetadataInput {
  source: Source;
  /** Values of metadata/by-key/<key> (mpv/ffmpeg normalise key names). */
  tags: { artist?: string; title?: string; album?: string; albumArtist?: string };
  /** mpv `filename` (last path / URL component). */
  fileName: string;
  /** mpv `media-title`: the title tag, the video title (Online Media), or the file name. */
  mediaTitle: string;
  /** The file has a real video track. */
  isVideo: boolean;
  duration?: number;
}

export type MetadataResult =
  | { ok: true; track: Track; from: "tags" | "filename" | "title" }
  | { ok: false; reason: string };

export function buildTrack(input: MetadataInput): MetadataResult {
  const tagArtist = clean(input.tags.artist);
  const tagTitle = clean(input.tags.title);
  const extra = {
    album: clean(input.tags.album) || undefined,
    albumArtist: clean(input.tags.albumArtist) || undefined,
    duration: input.duration && input.duration > 0 ? input.duration : undefined,
  };

  if (tagArtist && tagTitle) return { ok: true, track: { artist: tagArtist, track: tagTitle, ...extra }, from: "tags" };

  if (input.source === "ytdlp") {
    // Not yet: splitting an arbitrary video title on ":" / "|" / "-" would scrobble
    // ordinary videos as music. yt-dlp metadata (design §4.2) comes in step 5.
    return { ok: false, reason: "yt-dlp sources are not supported yet" };
  }

  // Local / network files without full tags. Video files are only scrobbled with real
  // artist and title tags: "Show Name - S01E01.mkv" must not become a song.
  if (input.isVideo) return { ok: false, reason: "video without artist/title tags" };

  const split = parseFileName(input.fileName);
  const artist = tagArtist || split?.artist || "";
  const title = tagTitle || split?.title || (tagArtist ? stripTrackNumber(clean(stripExtension(clean(input.fileName)))) : "");
  if (artist && title) return { ok: true, track: { artist, track: title, ...extra }, from: "filename" };
  return { ok: false, reason: "no artist/title tags and the file name has no separator" };
}
