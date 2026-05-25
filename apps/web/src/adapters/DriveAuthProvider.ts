// Google Identity Services wrapper. Implements IAuthProvider so the rest of
// the pipeline never imports `google.*` directly — easy to swap for a
// server-issued JWT later. GIS is loaded lazily on first use (script tag
// injection) so the cost is amortized to actual sign-in time, not page load.

import type { IAuthProvider } from "@cdna/types";

const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// Global declarations for window.google / window.gapi live in
// ./google-globals.d.ts — a single source of truth shared with DrivePicker.

let scriptLoadPromise: Promise<void> | null = null;
function loadGisScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${GIS_SCRIPT_SRC}`));
    document.head.appendChild(s);
  });
  return scriptLoadPromise;
}

export interface DriveAuthOptions {
  clientId: string;
  /** OAuth scope; default `drive.file` (per-file consent, no app verification). */
  scope?: string;
}

interface TokenCache {
  token: string;
  expiresAt: number; // ms since epoch
}

export class DriveAuthProvider implements IAuthProvider {
  private readonly clientId: string;
  private readonly scope: string;
  private tokenClient: GisTokenClient | null = null;
  private cache: TokenCache | null = null;
  // Most recent in-flight token request; resolves with the access token.
  private inflight: { resolve: (t: string) => void; reject: (e: unknown) => void } | null = null;

  constructor(opts: DriveAuthOptions) {
    this.clientId = opts.clientId;
    this.scope = opts.scope ?? "https://www.googleapis.com/auth/drive.file";
  }

  private async ensureClient(): Promise<GisTokenClient> {
    if (this.tokenClient) return this.tokenClient;
    await loadGisScript();
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) throw new Error("Google Identity Services failed to initialize.");
    this.tokenClient = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: this.scope,
      callback: (resp) => {
        if (resp.error) {
          this.inflight?.reject(new Error(`${resp.error}: ${resp.error_description ?? ""}`));
        } else {
          // GIS returns expires_in in seconds; we subtract a safety margin so a
          // long-running request doesn't race the expiry.
          this.cache = {
            token: resp.access_token,
            expiresAt: Date.now() + (resp.expires_in - 60) * 1000,
          };
          this.inflight?.resolve(resp.access_token);
        }
        this.inflight = null;
      },
      error_callback: (err) => {
        this.inflight?.reject(new Error(`${err.type}${err.message ? ": " + err.message : ""}`));
        this.inflight = null;
      },
    });
    return this.tokenClient;
  }

  async signIn(): Promise<void> {
    await this.getToken();
  }

  async signOut(): Promise<void> {
    this.cache = null;
    // GIS doesn't expose a "sign out" for the implicit OAuth flow; clearing
    // the cache forces the next getToken() to re-prompt.
  }

  async getToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.token;
    }
    const client = await this.ensureClient();
    return new Promise<string>((resolve, reject) => {
      this.inflight = { resolve, reject };
      // `consent` ensures the picker scope appears on first use; subsequent
      // calls auto-approve while the session is alive.
      client.requestAccessToken({ prompt: this.cache ? "" : "consent" });
    });
  }

  isSignedIn(): boolean {
    return !!this.cache && this.cache.expiresAt > Date.now();
  }
}
