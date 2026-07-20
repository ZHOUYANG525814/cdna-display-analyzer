import { useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Play, Square } from "lucide-react";
import { useRunStore, type LogEntry } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { runInWorker, setWorkerErrorHandler, terminateWorker } from "@/worker/workerClient";
import type { RoundConfigInput } from "@cdna/core";

const TAG_COLORS: Record<string, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

// Every component in this file uses single-field Zustand selectors so progress
// ticks (~60–120/sec at the new threshold) only re-render the pieces that
// actually depend on the changed slice. RunStep itself only reads structural
// state — status + counts — so it doesn't re-render on every byte/progress msg.
export function RunStep() {
  const status = useRunStore((s) => s.status);
  const localFiles = useRunStore((s) => s.localFiles);
  const driveFiles = useRunStore((s) => s.driveFiles);
  const rounds = useRunStore((s) => s.rounds);
  const pipelineMode = useRunStore((s) => s.pipelineMode);
  // Duplicate-source detector. Flags any FASTQ that appears more than once
  // across the run — would silently double-count its reads otherwise. Local
  // files keyed by (name, size, lastModified); Drive files keyed by id.
  const duplicateGroups = useMemo(() => {
    const keyToLabels = new Map<string, string[]>();
    const addSource = (key: string, label: string) => {
      const arr = keyToLabels.get(key) ?? [];
      arr.push(label);
      keyToLabels.set(key, arr);
    };
    if (pipelineMode === "per-round") {
      for (const r of rounds) {
        if (r.file) {
          addSource(`local:${r.file.name}:${r.file.size}:${r.file.lastModified}`, `${r.name} ← ${r.file.name}`);
        } else if (r.driveRef) {
          addSource(`drive:${r.driveRef.id}`, `${r.name} ← ${r.driveRef.name}`);
        }
      }
    } else {
      for (const f of localFiles) {
        addSource(`local:${f.name}:${f.size}:${f.lastModified}`, f.name);
      }
      for (const d of driveFiles) {
        addSource(`drive:${d.id}`, d.name);
      }
    }
    const dupes: string[][] = [];
    for (const labels of keyToLabels.values()) {
      if (labels.length > 1) dupes.push(labels);
    }
    return dupes;
  }, [pipelineMode, rounds, localFiles, driveFiles]);

  // In per-round mode the user-facing source list comes from rounds[i].file,
  // not the (unused) localFiles array. Compute a unified view for the UI.
  const uiSources = useMemo(() => {
    if (pipelineMode === "per-round") {
      const local = rounds
        .filter((r) => r.file != null)
        .map((r) => ({ name: r.file!.name, totalBytes: r.file!.size as number | null }));
      const drive = rounds
        .filter((r) => r.driveRef != null)
        .map((r) => ({ name: r.driveRef!.name, totalBytes: r.driveRef!.sizeBytes }));
      return [...local, ...drive];
    }
    return [
      ...localFiles.map((f) => ({ name: f.name, totalBytes: f.size as number | null })),
      ...driveFiles.map((d) => ({ name: d.name, totalBytes: d.sizeBytes })),
    ];
  }, [pipelineMode, rounds, localFiles, driveFiles]);
  const total = uiSources.length;

  // Pipe worker bundle/import errors into the run log so they're visible.
  useEffect(() => {
    setWorkerErrorHandler((msg) =>
      useRunStore.getState().appendLog({ text: msg, tag: "error" }),
    );
  }, []);

  const start = useCallback(async () => {
    const s = useRunStore.getState();
    const roundsCfg: RoundConfigInput[] = s.rounds.map((r) => ({
      name: r.name,
      fwPrimer: r.fwPrimer,
      rvPrimer: r.rvPrimer,
      cdsStart: r.cdsStart!,
      cdsEnd: r.cdsEnd!,
    }));

    // Job assembly differs between the two modes:
    //
    //  - multiplexed: read directly from the store's localFiles + driveFiles.
    //    sourceRoundIndices is omitted; pipeline.ts demultiplexes by barcode.
    //
    //  - per-round: each round has either a local File or a Drive ref. We
    //    split into the worker's [localFiles, driveFiles] flat arrays and
    //    record which round each entry belongs to in sourceRoundIndices.
    //    Layout: all local sources first (in round order), then all drive
    //    sources (in round order). sourceRoundIndices is parallel to that
    //    combined array.
    let jobLocalFiles: File[];
    let jobDriveFiles = s.driveFiles;
    let sourceRoundIndices: number[] | undefined;
    if (s.pipelineMode === "per-round") {
      const missing = s.rounds
        .filter((r) => r.file == null && r.driveRef == null)
        .map((r) => r.name);
      if (missing.length > 0) {
        const msg = `Per-round mode: these rounds have no FASTQ bound: ${missing.join(", ")}`;
        s.appendLog({ text: msg, tag: "error" });
        s.failRun(msg);
        return;
      }
      const localFilesArr: File[] = [];
      const localIndicesRound: number[] = [];
      const driveFilesArr: typeof s.driveFiles = [];
      const driveIndicesRound: number[] = [];
      for (let i = 0; i < s.rounds.length; i++) {
        const r = s.rounds[i]!;
        if (r.file) {
          localFilesArr.push(r.file);
          localIndicesRound.push(i);
        } else if (r.driveRef) {
          driveFilesArr.push(r.driveRef);
          driveIndicesRound.push(i);
        }
      }
      jobLocalFiles = localFilesArr;
      jobDriveFiles = driveFilesArr;
      sourceRoundIndices = [...localIndicesRound, ...driveIndicesRound];
    } else {
      jobLocalFiles = s.localFiles;
    }

    s.startRun();
    s.appendLog({
      text:
        `Pipeline started · mode=${s.pipelineMode} · ${roundsCfg.length} round(s) · ` +
        `${jobLocalFiles.length + jobDriveFiles.length} file(s) · WASM=${s.useWasm}`,
      tag: "info",
    });
    try {
      // Drive bearer token: prefer the one stashed by the Sources flow
      // (multiplexed mode). For per-round Drive picks we read from the
      // DriveAuthProvider's sessionStorage cache so a Configure-time pick
      // still has a valid token to ship to the worker.
      let driveToken = (window as unknown as { __drive_token?: string }).__drive_token;
      if (!driveToken && jobDriveFiles.length > 0) {
        try {
          const raw = sessionStorage.getItem("cdna_drive_token");
          if (raw) {
            const parsed = JSON.parse(raw) as { token?: string; expiresAt?: number };
            if (parsed.token && (parsed.expiresAt ?? 0) > Date.now()) {
              driveToken = parsed.token;
            }
          }
        } catch {
          /* fall through; the worker will surface the missing-token error */
        }
      }
      const outcome = await runInWorker(
        {
          localFiles: jobLocalFiles,
          driveFiles: jobDriveFiles,
          ...(driveToken ? { driveToken } : {}),
          rounds: roundsCfg,
          settings: {
            // Adaptive=true is hardcoded. The non-adaptive Rv-anchor indel
            // check was removed from the UI in Phase 6.11: the exact-10-bp
            // scan dropped reads whenever the Rv-anchor 10-mer happened to
            // occur inside the ROI by chance (frequent on AT-biased or
            // repeat-containing libraries) and silently skipped the check on
            // reads with sequencing errors in the anchor — punishing clean
            // reads more than dirty ones. The engine still accepts the flag
            // for desktop-Python parity tests; we just never send false.
            adaptive: true,
            filterStop: s.filterStop,
            // Read from the store; defaults are 20.0 (Illumina Q≥20 is the
            // standard cutoff for high-confidence base calls). Users can lower
            // them on the Configure → Advanced section for noisy datasets.
            minMeanPhred: s.minMeanPhred,
            minMeanPhredCds: s.minMeanPhredCds,
          },
          pseudocount: s.pseudocount,
          useWasm: s.useWasm,
          mode: s.pipelineMode,
          ...(sourceRoundIndices ? { sourceRoundIndices } : {}),
        },
        (p) => useRunStore.getState().updateProgress(p),
        // onLog (Phase 6.13): pipeline pushes settings recap, filter-funnel
        // snapshots, library-median diagnostic, FDR summary. Each entry is
        // appended verbatim to the UI's terminal log panel.
        (m) => useRunStore.getState().appendLog({ text: m.text, tag: m.tag }),
      );
      const passed = Object.values(outcome.statsByRound).reduce(
        (acc, r) => acc + r.passed_qc,
        0,
      );
      useRunStore.getState().appendLog({
        text: `Pipeline complete · ${outcome.globalUnassigned.toLocaleString()} unassigned · ${passed.toLocaleString()} passed-QC reads`,
        tag: "success",
      });
      useRunStore.getState().finishRun(outcome);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      useRunStore.getState().appendLog({ text: `ERROR: ${msg}`, tag: "error" });
      useRunStore.getState().failRun(msg);
    }
  }, []);

  const cancel = useCallback(() => {
    terminateWorker();
    const s = useRunStore.getState();
    s.cancelRun();
    s.appendLog({ text: "Cancelled by user — worker terminated.", tag: "warning" });
  }, []);

  const sources = uiSources;

  const showProgress = status === "running" || status === "done" || status === "cancelled";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {duplicateGroups.length > 0 && status === "idle" && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-medium text-warning">
            Duplicate FASTQ detected — reads would be counted twice
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The same file is referenced more than once in this run. The
            pipeline will ingest each copy independently, so any peptide it
            contains will be over-represented in the matrix. Remove the
            extra references (or run anyway if this is intentional).
          </p>
          <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs">
            {duplicateGroups.map((labels, i) => (
              <li key={i} className="font-mono">
                {labels.join("  ↔  ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Run pipeline</CardTitle>
            <CardDescription>
              {status === "idle" && `Ready: ${total} file(s) queued, ${rounds.length} round(s) configured.`}
              {status === "running" && "Streaming, demultiplexing, and aggregating."}
              {status === "done" && "Finished — results below."}
              {status === "error" && "Halted with an error."}
              {status === "cancelled" && "Cancelled."}
            </CardDescription>
          </div>
          {status === "idle" && (
            <Button size="lg" onClick={start}>
              <Play className="mr-1.5 h-4 w-4" /> Start
            </Button>
          )}
          {status === "running" && (
            <Button size="lg" variant="destructive" onClick={cancel}>
              <Square className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
          )}
        </CardHeader>

        {showProgress && (
          <CardContent className="space-y-4">
            <OverallProgress />
            <div className="space-y-2">
              {sources.map((s, i) => (
                <PerFileProgress key={i} index={i} name={s.name} totalBytes={s.totalBytes} />
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Log</CardTitle>
        </CardHeader>
        <CardContent>
          <LogViewer />
        </CardContent>
      </Card>

      <NavRow />
    </div>
  );
}

function NavRow() {
  const status = useRunStore((s) => s.status);
  const goPrev = useRunStore((s) => s.goPrev);
  const goNext = useRunStore((s) => s.goNext);
  return (
    <div className="flex justify-between">
      <Button variant="ghost" onClick={goPrev} disabled={status === "running"}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
      </Button>
      {status === "done" && (
        <Button size="lg" onClick={goNext}>
          View results
        </Button>
      )}
    </div>
  );
}

// Isolated log component — selects only `log`. Progress ticks don't touch the
// log slice, so this never re-renders during streaming.
function LogViewer() {
  const log = useRunStore((s) => s.log);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log.length]);

  return (
    <div
      ref={ref}
      className="h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"
    >
      {log.length === 0 && (
        <p className="text-muted-foreground">Pipeline output will appear here.</p>
      )}
      {log.map((entry: LogEntry, i: number) => (
        <div key={i} className={TAG_COLORS[entry.tag] ?? ""}>
          {entry.text}
        </div>
      ))}
    </div>
  );
}

function OverallProgress() {
  const startedAt = useRunStore((s) => s.startedAt);
  const finishedAt = useRunStore((s) => s.finishedAt);
  const status = useRunStore((s) => s.status);
  const perSourceBytes = useRunStore((s) => s.perSourceBytes);
  const localFiles = useRunStore((s) => s.localFiles);
  const driveFiles = useRunStore((s) => s.driveFiles);
  const pipelineMode = useRunStore((s) => s.pipelineMode);
  const rounds = useRunStore((s) => s.rounds);

  const totalKnownBytes = useMemo(() => {
    let t = 0;
    if (pipelineMode === "per-round") {
      for (const r of rounds) {
        if (r.file) t += r.file.size;
        else if (r.driveRef?.sizeBytes != null) t += r.driveRef.sizeBytes;
      }
    } else {
      for (const f of localFiles) t += f.size;
      for (const d of driveFiles) if (d.sizeBytes != null) t += d.sizeBytes;
    }
    return t;
  }, [pipelineMode, rounds, localFiles, driveFiles]);

  let bytesDone = 0;
  for (const v of Object.values(perSourceBytes)) bytesDone += v;
  const pct = totalKnownBytes > 0 ? Math.min(100, (bytesDone / totalKnownBytes) * 100) : 0;
  const elapsed = startedAt ? ((finishedAt ?? performance.now()) - startedAt) / 1000 : 0;
  // ETA: remaining-bytes × seconds-per-byte. Avoid div-by-zero at startup.
  const eta = totalKnownBytes > 0 && bytesDone > 1024 * 1024 && status === "running"
    ? Math.max(0, ((totalKnownBytes - bytesDone) / bytesDone) * elapsed)
    : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">Overall</span>
        <span className="font-mono text-muted-foreground">
          {pct.toFixed(1)}% · {formatBytes(bytesDone)} / {formatBytes(totalKnownBytes)} ·{" "}
          {formatDuration(elapsed)} elapsed
          {eta != null && ` · ETA ${formatDuration(eta)}`}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

function PerFileProgress({
  index,
  name,
  totalBytes,
}: {
  index: number;
  name: string;
  totalBytes: number | null;
}) {
  const bytesDone = useRunStore((s) => s.perSourceBytes[index] ?? 0);
  const activeIdx = useRunStore((s) => s.progress?.sourceIndex);
  const pct = totalBytes && totalBytes > 0 ? Math.min(100, (bytesDone / totalBytes) * 100) : 0;
  const isActive = activeIdx === index;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 min-w-0">
          {isActive && <Badge variant="default" className="text-[10px] py-0">streaming</Badge>}
          <span className="truncate font-mono">{name}</span>
        </span>
        <span className="font-mono text-muted-foreground shrink-0 ml-2">
          {formatBytes(bytesDone)}
          {totalBytes != null && ` / ${formatBytes(totalBytes)} · ${pct.toFixed(0)}%`}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem}s`;
}
