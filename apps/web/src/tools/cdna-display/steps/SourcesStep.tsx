import { useEffect, useRef, useState } from "react";
import { FolderOpen, FileText, Cloud, X, ArrowRight, Sparkles, Layers, Files } from "lucide-react";
import { useRunStore } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";
import { showDrivePicker } from "@/adapters/DrivePicker";
import { DEMO_REFERENCE, DEMO_ROUNDS, loadDemoFastq } from "@/tools/cdna-display/demo";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;

export function SourcesStep() {
  const {
    projectName,
    setProjectName,
    localFiles,
    driveFiles,
    setLocalFiles,
    setDriveFiles,
    clearAllFiles,
    goNext,
    setReferenceSeq,
    setRounds,
    rounds,
    setStep,
    pipelineMode,
    setPipelineMode,
  } = useRunStore();
  const totalFiles = localFiles.length + driveFiles.length;
  const perRound = pipelineMode === "per-round";
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoErr, setDemoErr] = useState<string | null>(null);

  const onFiles = (list: FileList | null) => {
    if (!list) return;
    const arr = Array.from(list).filter((f) => /\.(fastq|fq)$/i.test(f.name));
    setLocalFiles([...localFiles, ...arr]);
  };

  const loadDemo = async () => {
    setDemoBusy(true);
    setDemoErr(null);
    try {
      const file = await loadDemoFastq();
      // Replace any previously-picked files so the demo run is reproducible.
      setLocalFiles([file]);
      setDriveFiles([]);
      setProjectName("Demo_run");
      setReferenceSeq(DEMO_REFERENCE);
      // Preserve any existing round ids that match by name; rebuild from
      // the demo config so cdsStart/cdsEnd are populated and the user can
      // click straight through to Run.
      const nextRounds = DEMO_ROUNDS.map((r, i) => ({
        ...r,
        id: rounds[i]?.id ?? `demo_${i}_${Date.now()}`,
      }));
      setRounds(nextRounds);
      // Drop the user right at the Run step — the wizard skipped past
      // Configure + Preview because everything is already filled in.
      setStep("run");
    } catch (e: unknown) {
      setDemoErr((e as Error).message);
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
          <CardDescription>Name that appears on your downloaded artifacts.</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="project">Project name</Label>
          <Input
            id="project"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="mt-1.5 max-w-md"
          />
        </CardContent>
      </Card>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              First time here? Try the demo
            </CardTitle>
            <CardDescription className="mt-1">
              Loads a 1,000-read synthetic FASTQ + matching primer config and
              jumps straight to the Run step. Whole flow finishes in under a
              second. No Google sign-in needed.
            </CardDescription>
          </div>
          <Button onClick={loadDemo} disabled={demoBusy} className="shrink-0">
            <Sparkles className="mr-1.5 h-4 w-4" />
            {demoBusy ? "Loading…" : "Try with demo data"}
          </Button>
        </CardHeader>
        {demoErr && (
          <CardContent className="pt-0">
            <p className="text-sm text-destructive">{demoErr}</p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline mode</CardTitle>
          <CardDescription>
            Choose how each FASTQ maps to a selection round.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            <ModeOption
              active={pipelineMode === "multiplexed"}
              icon={Layers}
              title="Multiplexed (default)"
              description="Reads from one or more FASTQs are demultiplexed by barcode across all rounds. Each round needs a distinct primer barcode."
              onClick={() => setPipelineMode("multiplexed")}
            />
            <ModeOption
              active={pipelineMode === "per-round"}
              icon={Files}
              title="One FASTQ per round"
              description="Each FASTQ is bound to one round; no barcode demultiplex. Same primer across rounds is safe. You'll bind files to rounds below."
              onClick={() => setPipelineMode("per-round")}
            />
          </div>
        </CardContent>
      </Card>

      {perRound && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base">FASTQ sources — configured per round</CardTitle>
            <CardDescription>
              In per-round mode, each round picks its own FASTQ in the
              <span className="font-medium"> Configure</span> step. There's
              nothing to do on this page — continue when you're ready.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {!perRound && (
      <Card>
        <CardHeader>
          <CardTitle>FASTQ sources</CardTitle>
          <CardDescription>
            Single-end FASTQ files only. `.fastq.gz` is not yet supported.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="local">
            <TabsList>
              <TabsTrigger value="local">
                <FileText className="mr-1.5 h-4 w-4" /> Local files
              </TabsTrigger>
              <TabsTrigger value="drive">
                <Cloud className="mr-1.5 h-4 w-4" /> Google Drive
              </TabsTrigger>
            </TabsList>

            <TabsContent value="local">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  onFiles(e.dataTransfer.files);
                }}
                className={`mt-4 rounded-lg border-2 border-dashed p-8 text-center transition ${
                  dragActive ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <FolderOpen className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">
                  Drag &amp; drop FASTQs here, or
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => inputRef.current?.click()}
                >
                  Browse files…
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".fastq,.fq"
                  className="hidden"
                  onChange={(e) => onFiles(e.target.files)}
                />
              </div>
            </TabsContent>

            <TabsContent value="drive">
              <DriveTabContent setDriveFiles={setDriveFiles} driveFileCount={driveFiles.length} />
            </TabsContent>
          </Tabs>

          {totalFiles > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium">
                  {totalFiles} file{totalFiles === 1 ? "" : "s"} selected
                </span>
                <Button variant="ghost" size="sm" onClick={clearAllFiles}>
                  <X className="mr-1 h-3.5 w-3.5" /> Clear all
                </Button>
              </div>
              <ul className="divide-y rounded-md border text-sm">
                {localFiles.map((f, i) => (
                  <li key={"l:" + i} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="secondary">local</Badge>
                      <span className="truncate font-mono text-xs">{f.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                  </li>
                ))}
                {driveFiles.map((d) => (
                  <li key={"d:" + d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge>drive</Badge>
                      <span className="truncate font-mono text-xs">{d.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {d.sizeBytes != null ? formatBytes(d.sizeBytes) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      <div className="flex justify-end">
        <Button
          size="lg"
          disabled={!perRound && totalFiles === 0}
          onClick={goNext}
        >
          Continue <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function DriveTabContent({
  setDriveFiles,
  driveFileCount,
}: {
  setDriveFiles: (f: import("@/worker/types").DriveFileRef[]) => void;
  driveFileCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authRef = useRef<DriveAuthProvider | null>(null);
  if (!authRef.current && CLIENT_ID) authRef.current = new DriveAuthProvider({ clientId: CLIENT_ID });

  if (!CLIENT_ID || !API_KEY) {
    return (
      <div className="mt-4 space-y-3 rounded-md border bg-muted/30 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Optional</Badge>
          <p className="font-medium">Drive sign-in needs a one-time setup.</p>
        </div>
        <p className="text-muted-foreground">
          You can use the <span className="font-medium">Local files</span> tab without any
          setup. The Drive flow requires a Google Cloud project so the browser can request
          a per-file access token.
        </p>
        <ol className="ml-5 list-decimal space-y-1.5 text-xs text-muted-foreground">
          <li>
            Open{" "}
            <a
              href="https://console.cloud.google.com/"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Google Cloud Console
            </a>{" "}
            and create or pick a project.
          </li>
          <li>
            Enable <span className="font-mono">Google Drive API</span> and{" "}
            <span className="font-mono">Google Picker API</span>.
          </li>
          <li>
            Create an <span className="font-medium">OAuth 2.0 Client ID</span> (type:{" "}
            <em>Web application</em>) and add{" "}
            <span className="font-mono">http://localhost:5173</span> to its{" "}
            <em>Authorized JavaScript origins</em>.
          </li>
          <li>
            Create a <span className="font-medium">Browser API key</span>, restricted to
            the same origin and the two APIs above.
          </li>
          <li>
            Copy both into{" "}
            <span className="font-mono">apps/web/.env.local</span>:
            <pre className="mt-1 rounded bg-background p-2 font-mono text-[10px]">
{`VITE_GOOGLE_CLIENT_ID=…
VITE_GOOGLE_API_KEY=…`}
            </pre>
          </li>
          <li>Restart the dev server.</li>
        </ol>
      </div>
    );
  }

  const openPicker = async (token: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      (window as unknown as { __drive_token?: string }).__drive_token = token;
      console.log("[drive] opening Picker …");
      // Project number = numeric prefix of the OAuth client ID (everything
      // up to the first '-'). The Picker needs it to register the per-file
      // grant against the right OAuth client.
      const projectNumber = (CLIENT_ID ?? "").split("-")[0]!;
      const picked = await showDrivePicker({
        oauthToken: token,
        apiKey: API_KEY!,
        appId: projectNumber,
      });
      console.log(`[drive] Picker closed; picked ${picked.length} file(s)`, picked);
      if (picked.length > 0) {
        setDriveFiles(picked.map((p) => ({ id: p.id, name: p.name, sizeBytes: p.sizeBytes })));
      }
    } catch (e: unknown) {
      console.error("[drive] picker failed:", e);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPick = async () => {
    if (!API_KEY) {
      setError("VITE_GOOGLE_API_KEY is not configured.");
      return;
    }
    const auth = authRef.current!;
    // If we already have a valid token (from earlier or restored from
    // sessionStorage after a redirect), just open the picker directly.
    if (auth.isSignedIn()) {
      console.log("[drive] already signed in; opening picker directly");
      await openPicker(await auth.getToken());
      return;
    }
    // Otherwise, mark our intent and trigger the OAuth redirect. The page
    // will navigate to Google and back; on return, the useEffect below
    // detects the pending action and reopens the picker automatically.
    console.log("[drive] not signed in; saving 'open_picker' and redirecting to Google");
    DriveAuthProvider.setPendingAction("open_picker");
    setBusy(true);
    void auth.getToken(); // never resolves — navigates away
  };

  // After the OAuth redirect returns, our DriveAuthProvider constructor has
  // already parsed the access token from the URL fragment. If we'd queued
  // "open_picker" before the redirect, resume that action now.
  useEffect(() => {
    const auth = authRef.current;
    if (!auth || !API_KEY) return;
    const pending = DriveAuthProvider.consumePendingAction();
    if (pending === "open_picker" && auth.isSignedIn()) {
      console.log("[drive] resuming pending action 'open_picker' after OAuth return");
      void (async () => {
        const token = await auth.getToken();
        await openPicker(token);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Stream files directly from your Google Drive. Files never leave your browser.
      </p>
      <div>
        <Button onClick={onPick} disabled={busy} variant="outline">
          <Cloud className="mr-1.5 h-4 w-4" />
          {driveFileCount > 0 ? `Reselect Drive files (${driveFileCount})` : "Sign in & pick from Drive…"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ModeOption({
  active,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: typeof Layers;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-start gap-3 rounded-lg border p-3 text-left transition " +
        (active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/50")
      }
    >
      <Icon
        className={"mt-0.5 h-4 w-4 shrink-0 " + (active ? "text-primary" : "text-muted-foreground")}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

