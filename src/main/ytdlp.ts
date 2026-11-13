// Runs yt-dlp to get metadata for the URL being played (docs/design.md §4.2).
//
// utils.exec resolves a bare command name only to binaries bundled with IINA, so
// system installs need absolute paths (research.md §8.4). IINA's bundled
// "youtube-dl" is in fact a yt-dlp build and is the last resort.
import { getString, PrefKey } from "../shared/prefs.ts";
import { isPlaceholderInfo, type YtdlpInfo } from "./youtube.ts";

const CANDIDATES = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "youtube-dl"];
const TIMEOUT_MS = 30_000;

/** The binary that worked last time in this player instance. */
let knownGood: string | null = null;

export type YtdlpResult = { ok: true; info: YtdlpInfo; bin: string; ms: number } | { ok: false; error: string };

const candidates = (): string[] => {
  const configured = getString(PrefKey.YtdlpPath).trim();
  const list = [configured, knownGood ?? "", ...CANDIDATES].filter(Boolean);
  return list.filter((c, i) => list.indexOf(c) === i);
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
};

export const fetchYtdlpInfo = async (url: string): Promise<YtdlpResult> => {
  const errors: string[] = [];
  for (const bin of candidates()) {
    const t0 = Date.now();
    let res: { status: number; stdout: string; stderr: string };
    try {
      res = await withTimeout(
        iina.utils.exec(bin, [
          "-J",
          "--no-playlist",
          "--skip-download",
          "--no-warnings",
          "--ignore-no-formats-error",
          url,
        ]),
        TIMEOUT_MS,
      );
    } catch (e) {
      // -1: binary not found. Try the next candidate.
      errors.push(`${bin}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res.status !== 0) {
      // The binary exists but failed for this URL; another binary will not do better.
      return { ok: false, error: `${bin} exited with ${res.status}: ${String(res.stderr).trim().slice(0, 300)}` };
    }
    let info: YtdlpInfo;
    try {
      info = JSON.parse(res.stdout) as YtdlpInfo;
    } catch {
      return { ok: false, error: `${bin} printed no JSON` };
    }
    knownGood = bin;
    if (isPlaceholderInfo(info)) return { ok: false, error: `${bin} returned no metadata for this URL` };
    return { ok: true, info, bin, ms: Date.now() - t0 };
  }
  return { ok: false, error: `yt-dlp not found (${errors.join("; ")})` };
};
