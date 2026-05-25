// Google Picker integration. Loads the Picker API on demand and presents
// the standard Drive file chooser. Returns a typed array of selected files
// ready to wrap in DriveFastqSource.
//
// The Picker needs both an OAuth access token (to read user files) and a
// browser API key (its own auth path, separate from OAuth). Both must come
// from a Google Cloud project that has the Picker API enabled.

const GAPI_SCRIPT_SRC = "https://apis.google.com/js/api.js";

// Global declarations for window.gapi / window.google.picker live in
// ./google-globals.d.ts.

let gapiLoadPromise: Promise<void> | null = null;
function loadGapi(): Promise<void> {
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    if (window.gapi) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = GAPI_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${GAPI_SCRIPT_SRC}`));
    document.head.appendChild(s);
  });
  return gapiLoadPromise;
}

let pickerLoadPromise: Promise<void> | null = null;
function loadPickerLib(): Promise<void> {
  if (pickerLoadPromise) return pickerLoadPromise;
  pickerLoadPromise = (async () => {
    await loadGapi();
    await new Promise<void>((resolve, reject) => {
      if (!window.gapi) return reject(new Error("gapi unavailable"));
      window.gapi.load("picker", () => {
        if (window.google?.picker) resolve();
        else reject(new Error("google.picker did not load"));
      });
    });
  })();
  return pickerLoadPromise;
}

export interface PickedFile {
  id: string;
  name: string;
  sizeBytes: number | null;
}

export interface ShowPickerOptions {
  oauthToken: string;
  apiKey: string;
  /** Hint for what to show; defaults to a Drive view filtered to *.fastq / *.fq. */
  title?: string;
}

export async function showDrivePicker(opts: ShowPickerOptions): Promise<PickedFile[]> {
  await loadPickerLib();
  const picker = window.google?.picker;
  if (!picker) throw new Error("google.picker still unavailable after load.");

  return new Promise<PickedFile[]>((resolve, reject) => {
    try {
      // FASTQ files don't have a registered mime type, so we filter by name.
      // Three tabs in the picker so a "colleague sent me a link" workflow works:
      //   1. My Drive            — files the user owns (and shared drives)
      //   2. Shared with me      — files others granted them access to
      //   3. Recent              — both, ordered by last-opened (catches the
      //                            "I just opened this link" case without
      //                            requiring Add-to-Drive first)
      // All three use the same .fastq / .fq name filter.
      const filterQuery = "name contains '.fastq' or name contains '.fq'";

      const myDrive = new picker.DocsView();
      myDrive.setIncludeFolders(false);
      myDrive.setEnableDrives(true);
      myDrive.setQuery(filterQuery);

      const sharedWithMe = new picker.DocsView();
      sharedWithMe.setIncludeFolders(false);
      sharedWithMe.setOwnedByMe(false);
      sharedWithMe.setEnableDrives(true);
      sharedWithMe.setQuery(filterQuery);

      const builder = new picker.PickerBuilder()
        .addView(myDrive)
        .addView(sharedWithMe)
        .setOAuthToken(opts.oauthToken)
        .setDeveloperKey(opts.apiKey)
        .setTitle(opts.title ?? "Select FASTQ files from Drive")
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .enableFeature(picker.Feature.SUPPORT_DRIVES)
        .setCallback((resp) => {
          if (resp.action === picker.Action.PICKED) {
            const docs = resp.docs ?? [];
            resolve(
              docs.map((d) => ({
                id: d.id,
                name: d.name,
                sizeBytes: d.sizeBytes ? Number(d.sizeBytes) : null,
              })),
            );
          } else if (resp.action === picker.Action.CANCEL) {
            resolve([]); // user dismissed
          }
        });
      const instance = builder.build();
      instance.setVisible(true);
    } catch (e: unknown) {
      reject(e);
    }
  });
}
