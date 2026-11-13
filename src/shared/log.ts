// Logging to IINA's log viewer. Never pass tokens, session keys or secrets.
//
// With the `debug_log` preference on, each entry instance also keeps its recent lines
// in @data/debug-<scope>-<id>.log (the plugin's data folder), for bug reports and for
// checking behaviour without the IINA log viewer.
import { getBool, PrefKey } from "./prefs.ts";

const MAX_LINES = 500;

export function createLogger(scope: string) {
  const prefix = `[scrobbler:${scope}]`;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const path = `@data/debug-${scope}-${id}.log`;
  const lines: string[] = [];

  function toFile(level: string, msg: string): void {
    if (!getBool(PrefKey.DebugLog, false)) return;
    lines.push(`${new Date().toISOString()} ${level} ${msg}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    try {
      iina.file.write(path, `${lines.join("\n")}\n`);
    } catch {
      // Logging must never break playback.
    }
  }

  return {
    info: (msg: string) => {
      iina.console.log(`${prefix} ${msg}`);
      toFile("INFO", msg);
    },
    warn: (msg: string) => {
      iina.console.warn(`${prefix} ${msg}`);
      toFile("WARN", msg);
    },
    error: (msg: string) => {
      iina.console.error(`${prefix} ${msg}`);
      toFile("ERROR", msg);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
