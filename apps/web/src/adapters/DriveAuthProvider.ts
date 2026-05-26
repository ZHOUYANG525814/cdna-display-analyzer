// Google OAuth via the implicit grant + REDIRECT flow. After the user clicks
// sign-in, the whole tab navigates to accounts.google.com, the user consents,
// and Google redirects back to our origin with the access token in the URL
// fragment. We parse the fragment on app mount, cache the token in
// sessionStorage, and clean the URL.
//
// Why not the popup flow? Modern browsers' Cross-Origin-Opener-Policy and
// popup blockers make the popup unreliable — works on some browsers/configs,
// silently fails on others. The redirect flow has no such fragility: it's
// just two HTTP navigations, the same way every classic OAuth flow has worked
// for 15 years.
//
// Setup required in Google Cloud Console (one-time, OAuth Client ID page):
//   - Authorized JavaScript origins: https://your-domain
//   - Authorized redirect URIs:      https://your-domain/   (with trailing /)
//
// Trade-off: a brief full-page reload when signing in. Local-file pickers
// (drag/drop) are unaffected — they don't go through OAuth.

import type { IAuthProvider } from "@cdna/types";

interface TokenCache {
  token: string;
  expiresAt: number; // ms since epoch
}

const TOKEN_KEY = "cdna_drive_token";
const PENDING_KEY = "cdna_drive_pending_action";

/** Marker the caller writes before triggering a redirect; we read it after the
 *  return navigation to decide what to auto-resume (e.g. open the Picker). */
export type PendingAction = "open_picker" | null;

export interface DriveAuthOptions {
  clientId: string;
  /** OAuth scope; default `drive.file` (per-file consent, no app verification). */
  scope?: string;
}

export class DriveAuthProvider implements IAuthProvider {
  private readonly clientId: string;
  private readonly scope: string;
  private cache: TokenCache | null = null;

  constructor(opts: DriveAuthOptions) {
    this.clientId = opts.clientId;
    this.scope = opts.scope ?? "https://www.googleapis.com/auth/drive.file";
    // Order matters: URL fragment wins over stale sessionStorage values.
    this.restoreFromUrl();
    this.restoreFromSession();
  }

  /** Parse `#access_token=...` from the URL fragment if we just returned from
   *  Google's OAuth redirect, and clean the URL. */
  private restoreFromUrl(): void {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || !hash.includes("access_token=")) return;

    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const token = params.get("access_token");
    if (!token) return;

    const expiresIn = parseInt(params.get("expires_in") ?? "3600", 10);
    this.cache = {
      token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(this.cache));
    // Strip the hash so a refresh doesn't try to re-parse it.
    window.history.replaceState(
      {},
      document.title,
      window.location.pathname + window.location.search,
    );
    console.log("[auth] token captured from OAuth redirect; URL cleaned");
  }

  /** Restore a previously-issued token from sessionStorage if still valid. */
  private restoreFromSession(): void {
    if (this.cache) return;
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as TokenCache;
      if (parsed && typeof parsed.token === "string" && parsed.expiresAt > Date.now()) {
        this.cache = parsed;
        console.log("[auth] token restored from sessionStorage (still valid)");
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
      }
    } catch {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  }

  async signIn(): Promise<void> {
    await this.getToken();
  }

  async signOut(): Promise<void> {
    this.cache = null;
    sessionStorage.removeItem(TOKEN_KEY);
  }

  /** Return a valid access token. If we don't have one, navigate the tab to
   *  Google's OAuth page — *this method never resolves in that case*; the
   *  page reloads and the caller's `await` is discarded. */
  async getToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.token;
    }
    this.redirectToOAuth();
    // The browser is navigating away; this promise will never settle, but
    // the JS context is about to be torn down anyway.
    return new Promise(() => {});
  }

  /** Build the implicit-grant OAuth URL and navigate to it. */
  private redirectToOAuth(): void {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: window.location.origin + window.location.pathname,
      response_type: "token",
      scope: this.scope,
      include_granted_scopes: "true",
      // Always re-prompt so a fresh consent is shown after sign-out.
      prompt: "consent",
    });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    console.log("[auth] redirecting to Google OAuth:", url);
    window.location.href = url;
  }

  isSignedIn(): boolean {
    return !!this.cache && this.cache.expiresAt > Date.now();
  }

  /** Caller writes a marker BEFORE calling getToken() so that after the
   *  redirect returns, the UI knows to resume the action automatically. */
  static setPendingAction(action: PendingAction): void {
    if (action === null) {
      sessionStorage.removeItem(PENDING_KEY);
    } else {
      sessionStorage.setItem(PENDING_KEY, action);
    }
  }

  /** Read-and-clear the post-redirect resume marker. */
  static consumePendingAction(): PendingAction {
    const v = sessionStorage.getItem(PENDING_KEY) as PendingAction;
    sessionStorage.removeItem(PENDING_KEY);
    return v;
  }
}
