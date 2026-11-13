// Global entry: one instance per IINA process. Owns the Last.fm session, the Plugin
// menu, the scrobble queue and sending. Receives nowplaying / scrobble messages from
// the main entries (main → global only; research.md §8.1).
import { LastFm } from "../services/lastfm/lastfm.ts";
import type { SendResult } from "../services/types.ts";
import { HAS_LASTFM_CREDENTIALS, LASTFM_API_KEY, LASTFM_API_SECRET } from "../shared/build-config.ts";
import { createLogger } from "../shared/log.ts";
import { decode } from "../shared/messages.ts";
import { getString, PrefKey, setAndSync } from "../shared/prefs.ts";
import { AuthController } from "./auth.ts";
import { iinaHttp } from "./iina-http.ts";
import { ScrobbleQueue, type Storage } from "./queue.ts";
import { Sender } from "./sender.ts";

const { menu, global, file } = iina;
const log = createLogger("global");

const QUEUE_PATH = "@data/queue.json";

const lastfm = new LastFm(iinaHttp, { apiKey: LASTFM_API_KEY, apiSecret: LASTFM_API_SECRET });
lastfm.session = getString(PrefKey.SessionKey) || null;

// ---- queue and sending ----

const storage: Storage = {
  read: () => (file.exists(QUEUE_PATH) ? (file.read(QUEUE_PATH, {}) ?? null) : null),
  write: (content) => file.write(QUEUE_PATH, content),
  backupCorrupt(content) {
    const path = `@data/queue.corrupt-${Date.now()}.json`;
    file.write(path, content);
    log.error(`queue file was unreadable; kept a copy as ${path} and started a new queue`);
  },
};

const queue = new ScrobbleQueue(storage);

const sender = new Sender(lastfm, queue, {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as string),
  log,
  onAuthError: (detail) => disconnect(`session rejected, ${detail}`),
  onQueueChange: () => rebuildMenu(),
});

/** Runs a sender operation without letting a rejection go unnoticed. */
function send(op: () => Promise<void>): void {
  op().catch((e: unknown) => log.error(`sending failed: ${e instanceof Error ? e.message : String(e)}`));
}

// ---- auth ----

const auth = new AuthController(lastfm, log, {
  onApproved(sessionKey, userName) {
    lastfm.session = sessionKey;
    setAndSync({ [PrefKey.SessionKey]: sessionKey, [PrefKey.SessionName]: userName });
    rebuildMenu();
    send(() => sender.retryNow());
  },
  onStateChange: () => rebuildMenu(),
});

function disconnect(reason: string): void {
  lastfm.session = null;
  setAndSync({ [PrefKey.SessionKey]: "", [PrefKey.SessionName]: "" });
  log.info(`Last.fm: disconnected (${reason})`);
  rebuildMenu();
}

// ---- menu ----

/** A disabled, informational menu item. IINA treats a null action as "no action"
 * (JavascriptAPIMenu.swift); the type definition wrongly disallows null. */
function label(title: string): IINA.MenuItem {
  return menu.item(title, null as unknown as undefined, { enabled: false });
}

/**
 * Rebuilds the Plugin menu items.
 *
 * `refresh` calls menu.forceUpdate(), which must NOT happen while this script is
 * first being evaluated: forceUpdate() reads PlayerCore.active, which creates the
 * first player and its plugin instance before IINA has stored this global instance
 * (JavascriptPlugin.plugin.globalInstance). That player is then bound to no global
 * entry and every postMessage from it is silently dropped (research.md §8.5.3).
 */
function rebuildMenu(refresh = true): void {
  menu.removeAllItems();
  addMenuItems();
  if (refresh) menu.forceUpdate();
}

function addMenuItems(): void {
  if (!HAS_LASTFM_CREDENTIALS) {
    menu.addItem(label("Last.fm: API key missing in this build"));
    return;
  }
  const state = auth.current;
  if (lastfm.session) {
    const name = getString(PrefKey.SessionName) || "(unknown user)";
    menu.addItem(label(`Last.fm: connected as ${name}`));
  } else if (state.kind === "waiting" || state.kind === "starting") {
    menu.addItem(label("Last.fm: waiting for approval in the browser…"));
    menu.addItem(menu.item("Open the Last.fm approval page again", () => void auth.start()));
    menu.addItem(menu.item("Cancel connecting to Last.fm", () => auth.cancel()));
  } else {
    if (state.lastError) menu.addItem(label(`Last.fm: connection failed (${state.lastError})`));
    menu.addItem(menu.item("Connect to Last.fm…", () => void auth.start()));
  }

  const pending = safeCount();
  if (pending > 0) {
    const retryAt = sender.retryAt;
    const when = retryAt ? `, retrying in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))} min` : "";
    menu.addItem(label(`Pending scrobbles: ${pending}${lastfm.session ? when : " (connect to send)"}`));
    if (lastfm.session) menu.addItem(menu.item("Send pending scrobbles now", () => send(() => sender.retryNow())));
  }

  if (lastfm.session) menu.addItem(menu.item("Disconnect from Last.fm", () => disconnect("by user")));
}

function safeCount(): number {
  try {
    return queue.count(lastfm.id);
  } catch {
    return 0;
  }
}

// ---- messages from main entries ----

/**
 * Registers a message handler that runs outside the cross-context call from the main
 * entry (setTimeout), and logs instead of losing exceptions as unhandled rejections.
 */
function onMessage(name: string, handler: (raw: unknown) => Promise<void>): void {
  global.onMessage(name, (raw) => {
    setTimeout(() => {
      handler(raw).catch((e: unknown) => log.error(`${name} handler failed: ${e instanceof Error ? e.message : String(e)}`));
    }, 0);
  });
}

function logNowPlaying(what: string, r: SendResult): void {
  const detail = [r.code !== undefined ? `code ${r.code}` : "", r.message ?? ""].filter(Boolean).join(", ");
  const line = `nowplaying ${r.status}: ${what}${detail ? ` (${detail})` : ""}`;
  if (r.status === "ok") log.info(line);
  else log.warn(line);
  // Error 9: the session was revoked on last.fm. "not connected" carries no code.
  if (r.status === "auth-error" && r.code !== undefined) disconnect(`session rejected, ${detail}`);
}

onMessage("nowplaying", async (raw) => {
  const msg = decode("nowplaying", raw);
  if (!msg) return log.warn("ignored a malformed nowplaying message");
  if (!lastfm.session) return;
  // Not queued: a late "now playing" is meaningless.
  logNowPlaying(`${msg.track.artist} - ${msg.track.track}`, await lastfm.nowPlaying(msg.track));
});

onMessage("scrobble", async (raw) => {
  const msg = decode("scrobble", raw);
  if (!msg) return log.warn("ignored a malformed scrobble message");
  queue.add(lastfm.id, msg.entry, Date.now());
  log.info(`queued scrobble: ${msg.entry.artist} - ${msg.entry.track}`);
  await sender.flush();
});

// ---- startup ----

rebuildMenu(false); // no forceUpdate during load; see rebuildMenu
log.info(`loaded (Last.fm ${lastfm.session ? "connected" : "not connected"}, ${safeCount()} queued)`);
// Send what an earlier run left behind. Deferred: flushing refreshes the menu, which
// must not happen during load.
setTimeout(() => send(() => sender.flush()), 3_000);
