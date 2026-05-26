// Minimal global declarations for the Google Identity Services + Picker
// scripts that the Drive adapters load lazily. Declared here once so
// TypeScript sees a single canonical shape for window.google / window.gapi.

declare global {
  interface GisTokenClient {
    requestAccessToken(options?: { prompt?: string }): void;
  }
  interface GisTokenResponse {
    access_token: string;
    expires_in: number;
    error?: string;
    error_description?: string;
  }

  interface GooglePickerView {}
  interface GooglePickerInstance {
    setVisible(visible: boolean): void;
  }
  interface GooglePickerCallback {
    action: string;
    docs?: Array<{ id: string; name: string; mimeType: string; sizeBytes?: string }>;
  }
  interface GooglePickerBuilder {
    addView(view: GooglePickerView): GooglePickerBuilder;
    setOAuthToken(token: string): GooglePickerBuilder;
    setDeveloperKey(key: string): GooglePickerBuilder;
    /** Google Cloud project number (numeric prefix of the OAuth client ID).
     *  Required for the Picker to register the per-file grant against the
     *  right OAuth client; without it, files.get returns 404. */
    setAppId(appId: string): GooglePickerBuilder;
    setCallback(cb: (resp: GooglePickerCallback) => void): GooglePickerBuilder;
    setTitle(title: string): GooglePickerBuilder;
    enableFeature(feature: string): GooglePickerBuilder;
    build(): GooglePickerInstance;
  }

  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (resp: GisTokenResponse) => void;
            error_callback?: (err: { type: string; message?: string }) => void;
          }): GisTokenClient;
        };
      };
      picker?: {
        PickerBuilder: new () => GooglePickerBuilder;
        ViewId: { DOCS: string };
        DocsView: new () => GooglePickerView & {
          setIncludeFolders(v: boolean): unknown;
          setMimeTypes(types: string): unknown;
          setQuery(query: string): unknown;
          /** false → include files shared with the user but not owned. */
          setOwnedByMe(v: boolean): unknown;
          /** Surface shared drives (formerly "team drives") alongside My Drive. */
          setEnableDrives(v: boolean): unknown;
          /** Show "Starred", "Recent", "Shared with me" — see DocsViewMode. */
          setLabel(label: string): unknown;
        };
        Feature: {
          MULTISELECT_ENABLED: string;
          SUPPORT_DRIVES: string;
        };
        Action: { PICKED: string; CANCEL: string };
      };
    };
  }
}

export {};
