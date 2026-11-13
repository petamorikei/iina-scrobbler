// Desktop auth flow (docs/design.md §2): get a token, open the approval page in the
// browser, then poll every 5 s until the user approves (Last.fm answers error 14 while
// waiting). Gives up after 10 minutes or on a non-retryable error.
import type { Scrobbler } from "../services/types.ts";
import type { Logger } from "../shared/log.ts";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

export type AuthState =
  | { kind: "idle"; lastError?: string }
  | { kind: "starting" }
  | { kind: "waiting"; url: string; token: string; startedAt: number };

export interface AuthCallbacks {
  /** Called with the new session after approval. */
  onApproved(sessionKey: string, userName: string): void;
  /** Called on every state change (to refresh menus). */
  onStateChange(state: AuthState): void;
}

export class AuthController {
  private state: AuthState = { kind: "idle" };
  private timer: string | null = null;
  private polling = false;
  private readonly service: Scrobbler;
  private readonly log: Logger;
  private readonly cb: AuthCallbacks;

  constructor(service: Scrobbler, log: Logger, cb: AuthCallbacks) {
    this.service = service;
    this.log = log;
    this.cb = cb;
  }

  get current(): AuthState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.kind === "waiting") {
      iina.utils.open(this.state.url);
      return;
    }
    if (this.state.kind === "starting") return;
    this.setState({ kind: "starting" });
    try {
      const { url, token } = await this.service.beginAuth();
      this.setState({ kind: "waiting", url, token, startedAt: Date.now() });
      this.log.info(`${this.service.displayName}: opening the approval page`);
      iina.utils.open(url);
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    } catch (e) {
      this.fail(String(e instanceof Error ? e.message : e));
    }
  }

  cancel(): void {
    this.stopTimer();
    this.setState({ kind: "idle" });
  }

  private async poll(): Promise<void> {
    const s = this.state;
    if (s.kind !== "waiting" || this.polling) return;
    if (Date.now() - s.startedAt > POLL_TIMEOUT_MS) {
      this.fail("timed out waiting for approval");
      return;
    }
    this.polling = true;
    try {
      const r = await this.service.pollAuth(s.token);
      if (this.state !== s) return; // cancelled or restarted meanwhile
      if (r.status === "approved") {
        this.stopTimer();
        this.setState({ kind: "idle" });
        this.log.info(`${this.service.displayName}: connected as ${r.userName}`);
        this.cb.onApproved(r.sessionKey, r.userName);
      } else if (r.status === "failed") {
        if (r.retryable) this.log.warn(`${this.service.displayName}: auth poll failed, will retry (${r.message})`);
        else this.fail(r.message);
      }
    } finally {
      this.polling = false;
    }
  }

  private fail(message: string): void {
    this.stopTimer();
    this.log.error(`${this.service.displayName}: auth failed (${message})`);
    this.setState({ kind: "idle", lastError: message });
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private setState(s: AuthState): void {
    this.state = s;
    this.cb.onStateChange(s);
  }
}
