import { useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Play, Square } from "lucide-react";
import { useRunStore, type LogEntry } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  runInCdnaWorker,
  setCdnaWorkerErrorHandler,
  terminateCdnaWorker,
} from "@/worker/cdnaWorkerClient";
import type { RoundConfigInput } from "@cdna/core";
import {
  cdnaZeroCoverage,
  findDuplicateFastqGroups,
  zeroCoverageMessage,
} from "@/lib/runGuards";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const TAG_COLORS: Record<string, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

// Every component in this file uses single-field Zustand selectors so progress
// ticks (time-throttled to at most one every 200 ms) only re-render the pieces that
// actually depend on the changed slice. RunStep itself only reads structural
// state — status + counts — so it doesn't re-render on every byte/progress msg.
export function RunStep() {
  const status = useRunStore((s) => s.status);
  const localFiles = useRunStore((s) => s.localFiles);
  const driveFiles = useRunStore((s) => s.driveFiles);
  const rounds = useRunStore((s) => s.rounds);
  const pipelineMode = useRunStore((s) => s.pipelineMode);
  // Per-round inputs may contain multiple technical shards per round.
  const uiSources = useMemo(() => {
    if (pipelineMode === "per-round") {
      const local = rounds.flatMap((round) => round.sources.flatMap((source) => source.file
        ? [{ name: source.file.name, totalBytes: isGzipFastq(source.file.name) ? null : source.file.size as number | null }]
        : []));
      const drive = rounds.flatMap((round) => round.sources.flatMap((source) => source.driveRef
        ? [{ name: source.driveRef.name, totalBytes: isGzipFastq(source.driveRef.name) ? null : source.driveRef.sizeBytes }]
        : []));
      return [...local, ...drive];
    }
    return [
      ...localFiles.map((f) => ({ name: f.name, totalBytes: isGzipFastq(f.name) ? null : f.size as number | null })),
      ...driveFiles.map((d) => ({ name: d.name, totalBytes: isGzipFastq(d.name) ? null : d.sizeBytes })),
    ];
  }, [pipelineMode, rounds, localFiles, driveFiles]);
  const total = uiSources.length;

  // Pipe worker bundle/import errors into the run log so they're visible.
  useEffect(() => {
    setCdnaWorkerErrorHandler((msg) =>
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
    //  - per-round: each round has one or more local/Drive shards. We
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
        .filter((r) => !r.sources.some((source) => source.file || source.driveRef))
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
        for (const source of r.sources) {
          if (source.file) {
            localFilesArr.push(source.file);
            localIndicesRound.push(i);
          } else if (source.driveRef) {
            driveFilesArr.push(source.driveRef);
            driveIndicesRound.push(i);
          }
        }
      }
      jobLocalFiles = localFilesArr;
      jobDriveFiles = driveFilesArr;
      sourceRoundIndices = [...localIndicesRound, ...driveIndicesRound];
    } else {
      jobLocalFiles = s.localFiles;
    }

    s.startRun();
    s.appendLog({ text: "Verifying FASTQ source uniqueness…", tag: "info" });
    let duplicateCheck;
    try {
      duplicateCheck = await findDuplicateFastqGroups(
        s.pipelineMode === "per-round"
          ? s.rounds.flatMap((round) =>
              round.sources.flatMap((source) => source.file
                ? [{ file: source.file, label: `${round.name} ← ${source.file.name}` }]
                : []),
            )
          : s.localFiles.map((file) => ({ file, label: file.name })),
        s.pipelineMode === "per-round"
          ? s.rounds.flatMap((round) =>
              round.sources.flatMap((source) => source.driveRef
                ? [{ file: source.driveRef, label: `${round.name} ← ${source.driveRef.name}` }]
                : []),
            )
          : s.driveFiles.map((file) => ({ file, label: file.name })),
      );
    } catch (error) {
      const msg = `Could not verify FASTQ uniqueness: ${
        error instanceof Error ? error.message : String(error)
      }`;
      s.appendLog({ text: msg, tag: "error" });
      s.failRun(msg);
      return;
    }
    if (duplicateCheck.exactGroups.length > 0) {
      const msg =
        "The same FASTQ source was bound more than once: " +
        duplicateCheck.exactGroups.map((labels) => labels.join(" ↔ ")).join("; ") +
        ". Remove duplicate inputs before running.";
      s.appendLog({ text: msg, tag: "error" });
      s.failRun(msg);
      return;
    }
    if (duplicateCheck.probableGroups.length > 0) {
      const details = duplicateCheck.probableGroups
        .map((labels) => labels.join(" ↔ "))
        .join("; ");
      const confirmed = window.confirm(
        "Possible duplicate FASTQ inputs were found using file size plus sampled head/tail SHA-256 " +
          `(not a complete content hash): ${details}. Continue anyway?`,
      );
      if (!confirmed) {
        const msg = "Run cancelled: possible duplicate FASTQ inputs were not confirmed.";
        s.appendLog({ text: msg, tag: "warning" });
        s.cancelRun();
        return;
      }
      s.appendLog({ text: `Possible duplicates confirmed by user: ${details}`, tag: "warning" });
    }

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
      let driveToken: string | undefined;
      let driveAuth: DriveAuthProvider | undefined;
      if (jobDriveFiles.length > 0) {
        if (!CLIENT_ID) throw new Error("Google Drive OAuth is not configured.");
        driveAuth = new DriveAuthProvider({ clientId: CLIENT_ID });
        driveToken = await driveAuth.getToken();
      }
      const outcome = await runInCdnaWorker(
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
          reference: s.referenceSeq,
          mode: s.pipelineMode,
          ...(sourceRoundIndices ? { sourceRoundIndices } : {}),
        },
        (p) => useRunStore.getState().updateProgress(p),
        // onLog (Phase 6.13): pipeline pushes settings recap, filter-funnel
        // snapshots, library-median diagnostic, FDR summary. Each entry is
        // appended verbatim to the UI's terminal log panel.
        (m) => useRunStore.getState().appendLog({ text: m.text, tag: m.tag }),
        driveAuth ? () => driveAuth!.getToken() : undefined,
      );
      const passed = Object.values(outcome.statsByRound).reduce(
        (acc, r) => acc + r.passed_qc,
        0,
      );
      const zeroCoverage = cdnaZeroCoverage(outcome);
      if (zeroCoverage.length > 0) {
        const msg = zeroCoverageMessage(zeroCoverage);
        useRunStore.getState().appendLog({ text: msg, tag: "error" });
        useRunStore.setState({ outcome });
        useRunStore.getState().failRun(msg);
        return;
      }
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
    terminateCdnaWorker();
    const s = useRunStore.getState();
    s.cancelRun();
    s.appendLog({ text: "Cancelled by user — worker terminated.", tag: "warning" });
  }, []);

  const sources = uiSources;

  const showProgress = status === "running" || status === "done" || status === "cancelled";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
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
          {status !== "running" && status !== "done" && (
            <Button size="lg" onClick={start}>
              <Play className="mr-1.5 h-4 w-4" /> {status === "idle" ? "Start" : "Run again"}
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
        for (const source of r.sources) {
          if (source.file && !isGzipFastq(source.file.name)) t += source.file.size;
          else if (source.driveRef?.sizeBytes != null && !isGzipFastq(source.driveRef.name)) t += source.driveRef.sizeBytes;
        }
      }
    } else {
      for (const f of localFiles) if (!isGzipFastq(f.name)) t += f.size;
      for (const d of driveFiles) if (d.sizeBytes != null && !isGzipFastq(d.name)) t += d.sizeBytes;
    }
    return t;
  }, [pipelineMode, rounds, localFiles, driveFiles]);

  const hasUnknownTotal = useMemo(() => {
    if (pipelineMode === "per-round") {
      return rounds.some((round) => round.sources.some((source) =>
        (source.file && isGzipFastq(source.file.name)) ||
        (source.driveRef && (source.driveRef.sizeBytes == null || isGzipFastq(source.driveRef.name))),
      ));
    }
    return localFiles.some((file) => isGzipFastq(file.name)) ||
      driveFiles.some((file) => file.sizeBytes == null || isGzipFastq(file.name));
  }, [pipelineMode, rounds, localFiles, driveFiles]);

  let bytesDone = 0;
  for (const v of Object.values(perSourceBytes)) bytesDone += v;
  const pct = totalKnownBytes > 0 && !hasUnknownTotal
    ? Math.min(100, (bytesDone / totalKnownBytes) * 100)
    : 0;
  const elapsed = startedAt ? ((finishedAt ?? performance.now()) - startedAt) / 1000 : 0;
  // ETA: remaining-bytes × seconds-per-byte. Avoid div-by-zero at startup.
  const eta = totalKnownBytes > 0 && !hasUnknownTotal && bytesDone > 1024 * 1024 && status === "running"
    ? Math.max(0, ((totalKnownBytes - bytesDone) / bytesDone) * elapsed)
    : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">Overall</span>
        <span className="font-mono text-muted-foreground">
          {hasUnknownTotal
            ? `${formatBytes(bytesDone)} processed · total unknown`
            : `${pct.toFixed(1)}% · ${formatBytes(bytesDone)} / ${formatBytes(totalKnownBytes)}`} ·{" "}
          {formatDuration(elapsed)} elapsed
          {eta != null && ` · ETA ${formatDuration(eta)}`}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

function isGzipFastq(name: string): boolean { return /\.gz$/i.test(name); }

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
