// Building a Track from what the player knows (docs/design.md §4).
import type { Track } from "../services/types.ts";
import type { Source } from "../shared/messages.ts";
import { clean, parseFileName, stripExtension, stripTrackNumber } from "./title-parser.ts";
import { trackFromVideoTitle, trackFromYtdlp, type YtdlpInfo } from "./youtube.ts";

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
  /** yt-dlp metadata for yt-dlp sources: an object, or null when unavailable / turned off. */
  ytdlp?: YtdlpInfo | null;
}

export type MetadataResult = { ok: true; track: Track; from: string } | { ok: false; reason: string; live?: boolean };

export function buildTrack(input: MetadataInput): MetadataResult {
  const tagArtist = clean(input.tags.artist);
  const tagTitle = clean(input.tags.title);
  const duration = input.duration && input.duration > 0 ? input.duration : undefined;
  const extra = {
    album: clean(input.tags.album) || undefined,
    albumArtist: clean(input.tags.albumArtist) || undefined,
    duration,
  };

  if (tagArtist && tagTitle) return { ok: true, track: { artist: tagArtist, track: tagTitle, ...extra }, from: "tags" };

  if (input.source === "ytdlp") {
    const r = input.ytdlp ? trackFromYtdlp(input.ytdlp) : trackFromVideoTitle(clean(input.mediaTitle));
    if (!r.ok) return r;
    // mpv's duration is what is actually playing; yt-dlp's is the fallback.
    return { ok: true, track: { ...r.track, duration: duration ?? r.track.duration }, from: r.from };
  }

  // Local / network files without full tags. Video files are only scrobbled with real
  // artist and title tags: "Show Name - S01E01.mkv" must not become a song.
  if (input.isVideo) return { ok: false, reason: "video without artist/title tags" };

  const split = parseFileName(input.fileName);
  const artist = tagArtist || split?.artist || "";
  const title =
    tagTitle || split?.title || (tagArtist ? stripTrackNumber(clean(stripExtension(clean(input.fileName)))) : "");
  if (artist && title) return { ok: true, track: { artist, track: title, ...extra }, from: "filename" };
  return { ok: false, reason: "no artist/title tags and the file name has no separator" };
}
