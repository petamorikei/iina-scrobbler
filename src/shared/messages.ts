// main → global messages. Payloads are always JSON strings: an object handed across
// the entries was involved in the JavaScriptCore heap corruption found in
// docs/research.md §8.1. global → main replies are not used.
import type { ScrobbleEntry, Track } from "../services/types.ts";

export type Source = "local" | "ytdlp" | "network";

export interface MessageMap {
  nowplaying: { track: Track; source: Source };
  /**
   * verified: the track was checked against the service (found), or the user scrobbles
   * unrecognized tracks anyway. false: the check could not run (offline); the sender
   * checks again before sending.
   */
  scrobble: { entry: ScrobbleEntry; source: Source; verified: boolean };
}

export type MessageName = keyof MessageMap;

export const encode = <N extends MessageName>(_name: N, payload: MessageMap[N]): string => {
  return JSON.stringify(payload);
};

/** Returns null for anything that is not a JSON string of the expected shape. */
export const decode = <N extends MessageName>(name: N, raw: unknown): MessageMap[N] | null => {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const key = name === "nowplaying" ? "track" : "entry";
  const t = o[key] as Record<string, unknown> | undefined;
  if (!t || typeof t.artist !== "string" || typeof t.track !== "string" || !t.artist || !t.track) return null;
  if (name === "scrobble" && typeof t.timestamp !== "number") return null;
  return v as MessageMap[N];
};
