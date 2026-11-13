// Preference keys and typed access. Defaults live in Info.json (preferenceDefaults).
// There is no change event: read at the moment the value is needed.

export const PrefKey = {
  SessionKey: "session_key",
  SessionName: "session_name",
  ScrobbleLocal: "scrobble_local",
  ScrobbleYtdlp: "scrobble_ytdlp",
  ScrobbleNetwork: "scrobble_network",
  YtdlpMetadata: "ytdlp_metadata",
  YtdlpPath: "ytdlp_path",
  ShowOsd: "show_osd",
  DebugLog: "debug_log",
} as const;

export const getString = (key: string): string => {
  const v = iina.preferences.get(key);
  return typeof v === "string" ? v : "";
};

export const getBool = (key: string, fallback: boolean): boolean => {
  const v = iina.preferences.get(key);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return fallback;
};

/** Sets several values and writes them to disk (set() alone is not persisted). */
export const setAndSync = (values: Record<string, string | boolean>): void => {
  for (const [k, v] of Object.entries(values)) iina.preferences.set(k, v);
  iina.preferences.sync();
};
