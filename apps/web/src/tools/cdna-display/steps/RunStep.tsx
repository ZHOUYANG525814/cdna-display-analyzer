import { useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Play, Square } from "lucide-react";
import { useRunStore, type LogEntry } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { validatePrimer, validateProjectName, validateReference, validateRoundName } from "@/lib/validation";

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
  const projectName = useRunStore((s) => s.projectName);
  const referenceSeq = useRunStore((s) => s.referenceSeq);
  const expectedFileNames = useRunStore((s) => s.expectedFileNames);
  const errorMessage = useRunStore((s) => s.errorMessage);
  const minMeanPhred = useRunStore((s) => s.minMeanPhred);
  const minMeanPhredCds = useRunStore((s) => s.minMeanPhredCds);
  const pseudocount = useRunStore((s) => s.pseudocount);
  // Per-round inputs may contain multiple technical shards per round.
  const uiSources = useMemo(() => {
    if (pipelineMode === "per-round") {
      const local = rounds.flatMap((round) => round.sources.flatMap((source) => source.file
        ? [{ name: source.file.name, totalBytes: isGzipFastq(source.file.name) ? null : source.file.size as number | null, sizeBytes: source.file.size, roundName: round.name }]
        : []));
      const drive = rounds.flatMap((round) => round.sources.flatMap((source) => source.driveRef
        ? [{ name: source.driveRef.name, totalBytes: isGzipFastq(source.driveRef.name) ? null : source.driveRef.sizeBytes, sizeBytes: source.driveRef.sizeBytes, roundName: round.name }]
        : []));
      return [...local, ...drive];
    }
    return [
      ...localFiles.map((f) => ({ name: f.name, totalBytes: isGzipFastq(f.name) ? null : f.size as number | null, sizeBytes: f.size, roundName: null })),
      ...driveFiles.map((d) => ({ name: d.name, totalBytes: isGzipFastq(d.name) ? null : d.sizeBytes, sizeBytes: d.sizeBytes, roundName: null })),
    ];
  }, [pipelineMode, rounds, localFiles, driveFiles]);
  const total = uiSources.length;
  const analysisErrors = useMemo(() => {
    const errors: string[] = [];
    const projectError = validateProjectName(projectName); if (projectError) errors.push(projectError);
    const referenceError = validateReference(referenceSeq); if (referenceError) errors.push(referenceError);
    if (rounds.length < 2) errors.push("Round 0 and at least one selected round are required.");
    if (rounds.some((round) => validateRoundName(round.name) || validatePrimer(round.fwPrimer, "Forward") || validatePrimer(round.rvPrimer, "Reverse"))) errors.push("Every round needs a valid name and primer pair.");
    if (rounds.some((round) => round.cdsStart == null || round.cdsEnd == null || round.cdsEnd < round.cdsStart || (round.cdsEnd - round.cdsStart + 1) % 3 !== 0)) errors.push("Every round needs an in-frame CDS interval.");
    if (pipelineMode === "per-round" && rounds.some((round) => round.sources.length === 0 || round.sources.some((source) => !source.file && !source.driveRef))) errors.push("Select every expected shard and bind at least one FASTQ to every round.");
    if (pipelineMode === "multiplexed") {
      if (total === 0) errors.push("Select at least one FASTQ file.");
      if (total < expectedFileNames.length) errors.push("Select a FASTQ for every expected slot in the imported locked config.");
    }
    if (!Number.isFinite(minMeanPhred) || minMeanPhred < 0 || minMeanPhred > 40 || !Number.isFinite(minMeanPhredCds) || minMeanPhredCds < 0 || minMeanPhredCds > 40 || !Number.isFinite(pseudocount) || pseudocount <= 0 || pseudocount > 100) errors.push("One or more QC/statistical settings are outside the supported range.");
    return errors;
  }, [driveFiles, expectedFileNames, localFiles, minMeanPhred, minMeanPhredCds, pipelineMode, projectName, pseudocount, referenceSeq, rounds, total]);

  // Pipe worker bundle/import errors into the run log so they're visible.
  useEffect(() => {
    setCdnaWorkerErrorHandler((msg) =>
      useRunStore.getState().appendLog({ text: msg, tag: "error" }),
    );
  }, []);

  const start = useCallback(async () => {
    const s = useRunStore.getState();
    if (analysisErrors.length > 0) {
      s.failRun(analysisErrors.join(" "));
      return;
    }
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
  }, [analysisErrors]);

  const cancel = useCallback(() => {
    terminateCdnaWorker();
    const s = useRunStore.getState();
    s.cancelRun();
    s.appendLog({ text: "Cancelled by user — worker terminated.", tag: "warning" });
  }, []);

  const sources = uiSources;

  const showProgress = status !== "idle";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="sticky top-14 z-40 -mx-1 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <Card className="border-primary/40 shadow-md">
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
          {status !== "running" && (
            <Button size="lg" onClick={start} disabled={analysisErrors.length > 0}>
              <Play className="mr-1.5 h-4 w-4" /> Run analysis
            </Button>
          )}
          {status === "running" && (
            <Button size="lg" variant="destructive" onClick={cancel}>
              <Square className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-3">{analysisErrors.length > 0 && <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{analysisErrors.map((error) => <div key={error}>• {error}</div>)}</div>}{errorMessage && <div role="alert" className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{errorMessage}</div>}</CardContent>
      </Card>
      </div>

      <Card><CardHeader><CardTitle className="text-base">Inputs and design</CardTitle><CardDescription>Confirm the round/file binding and CDS definition before the full run.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><div className="rounded bg-muted/40 p-3 text-xs">Mode: <strong>{pipelineMode}</strong> · {rounds.length} rounds · {total} files · reference {referenceSeq.length.toLocaleString()} bp</div><div className="space-y-1 rounded border p-3">{uiSources.map((source, index) => <div key={`${source.name}:${index}`} className="flex flex-wrap justify-between gap-x-3 text-xs"><span className="min-w-0 font-mono">{source.roundName ? `${source.roundName} ← ` : ""}{source.name}</span><span className="text-muted-foreground">{isGzipFastq(source.name) ? "gzip" : "uncompressed"}{source.sizeBytes != null ? ` · ${formatBytes(source.sizeBytes)}` : " · size unknown"}</span></div>)}</div>{rounds.map((round) => <div key={round.id} className="rounded border p-3"><strong>{round.name}</strong><div className="mt-1 text-xs text-muted-foreground">Fw {round.fwPrimer} · Rv {round.rvPrimer} · CDS {round.cdsStart ?? "?"}–{round.cdsEnd ?? "?"}</div></div>)}</CardContent></Card>

      <NgSettings />

      {showProgress && <Card><CardHeader><CardTitle className="text-sm">Progress</CardTitle></CardHeader><CardContent className="space-y-4"><OverallProgress /><div className="space-y-2">{sources.map((source, index) => <PerFileProgress key={index} index={index} name={source.name} totalBytes={source.totalBytes} />)}</div></CardContent></Card>}

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

function NgSettings() {
  const s = useRunStore();
  return <><Card><CardHeader><CardTitle className="text-base">QC and statistics</CardTitle><CardDescription>Read Q ≥ {s.minMeanPhred}; CDS Q ≥ {s.minMeanPhredCds}; pseudocount {s.pseudocount} RPM; stop filtering {s.filterStop ? "on" : "off"}; engine {s.useWasm ? "WASM" : "TypeScript"}.</CardDescription></CardHeader><CardContent><details><summary className="cursor-pointer text-sm font-medium">Advanced settings</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">
    <label className="space-y-1 text-xs"><Label>Minimum mean read Q</Label><Input disabled={s.status === "running"} type="number" min={0} max={40} value={s.minMeanPhred} onChange={(event) => s.setMinMeanPhred(Number(event.target.value))} /></label>
    <label className="space-y-1 text-xs"><Label>Minimum mean CDS Q</Label><Input disabled={s.status === "running"} type="number" min={0} max={40} value={s.minMeanPhredCds} onChange={(event) => s.setMinMeanPhredCds(Number(event.target.value))} /></label>
    <label className="space-y-1 text-xs"><Label>Enrichment pseudocount (RPM)</Label><Input disabled={s.status === "running"} type="number" min={Number.MIN_VALUE} max={100} step={0.5} value={s.pseudocount} onChange={(event) => s.setPseudocount(Number(event.target.value))} /></label>
    <div className="space-y-3 text-sm"><label className="flex items-center gap-2"><input disabled={s.status === "running"} type="checkbox" checked={s.filterStop} onChange={(event) => s.setFilterStop(event.target.checked)} />Discard premature stop codons</label><label className="flex items-center gap-2"><input disabled={s.status === "running"} type="checkbox" checked={s.useWasm} onChange={(event) => s.setUseWasm(event.target.checked)} />Use WASM analysis engine</label></div>
  </div></details></CardContent></Card>
  <Card><CardHeader><CardTitle className="text-base">System-managed structural safeguards</CardTitle><CardDescription>Fixed pipeline rules are shown for auditability. NGS uses anchor-based fixed-coordinate extraction, not full-reference gapped realignment.</CardDescription></CardHeader><CardContent className="space-y-3">
    <div className="grid gap-2 text-xs sm:grid-cols-2">
      <Fixed label="FASTQ handling" value="streamed; malformed records isolated" />
      <Fixed label="Read orientation" value="forward, then reverse complement" />
      <Fixed label="Forward anchor" value="exact primer 3′ terminal 10 nt" />
      <Fixed label="Sequence normalization" value="uppercase A/C/G/T/N" />
      <Fixed label="CDS model" value="fixed coordinates after the anchor" />
      <Fixed label="CDS structure" value="in bounds; configured length divisible by 3" />
      <Fixed label="Dominant DNA ties" value="lexicographically smallest sequence" />
      <Fixed label="Multiple testing" value="BH-FDR per round comparison" />
    </div>
    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
      {s.pipelineMode === "multiplexed"
        ? "Multiplexed round assignment: barcode score ≤ 1.0 and best-vs-runner-up margin ≥ 1.0. Reads that cannot be assigned uniquely remain unassigned."
        : "Per-round assignment: the file binding locks the biological round. The same exact anchor and barcode score ≤ 1.0 are checked, but reads are never reassigned to another round."}
      {" "}Insertions or deletions are not repaired by this NGS path; use a reference and primer/CDS coordinates that match the amplicon design.
    </div>
  </CardContent></Card></>;
}

function Fixed({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 rounded bg-muted/40 px-3 py-2"><span className="text-muted-foreground">{label}</span><span className="text-right font-mono">{value}</span></div>;
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
