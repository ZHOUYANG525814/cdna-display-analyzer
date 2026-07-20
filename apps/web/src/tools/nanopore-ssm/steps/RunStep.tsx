// Nanopore SSM — Run step. Dispatches a NanoporeJob into the persistent
// worker via runNanoporeInWorker; tracks per-source progress + live log;
// transitions to Results on success.
//
// Cancel + wake-lock are deferred — the cDNA tool has them; the Nanopore
// tool will copy the same pattern in a follow-up. For now, Start kicks off
// the run and the UI follows along.

import { useCallback, useEffect, useMemo } from "react";
import { ArrowLeft, Play, Square } from "lucide-react";
import {
  useNanoporeStore,
  type NanoporeLogEntry,
} from "@/state/useNanoporeStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  runNanoporeInWorker,
  setWorkerErrorHandler,
  terminateWorker,
} from "@/worker/workerClient";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const TAG_COLORS: Record<string, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function RunStep() {
  const projectName = useNanoporeStore((s) => s.projectName);
  const pipelineMode = useNanoporeStore((s) => s.pipelineMode);
  const localFiles = useNanoporeStore((s) => s.localFiles);
  const driveFiles = useNanoporeStore((s) => s.driveFiles);
  const referenceSeq = useNanoporeStore((s) => s.referenceSeq);
  const sites = useNanoporeStore((s) => s.sites);
  const rounds = useNanoporeStore((s) => s.rounds);
  const reportHaplotype = useNanoporeStore((s) => s.reportHaplotype);
  const minMeanPhredRead = useNanoporeStore((s) => s.minMeanPhredRead);
  const minMeanPhredRoi = useNanoporeStore((s) => s.minMeanPhredRoi);
  const pseudocount = useNanoporeStore((s) => s.pseudocount);
  const status = useNanoporeStore((s) => s.status);
  const log = useNanoporeStore((s) => s.log);
  const perSourceBytes = useNanoporeStore((s) => s.perSourceBytes);
  const setStatus = useNanoporeStore((s) => s.setStatus);
  const setProgress = useNanoporeStore((s) => s.setProgress);
  const setSourceBytes = useNanoporeStore((s) => s.setSourceBytes);
  const setTiming = useNanoporeStore((s) => s.setTiming);
  const appendLog = useNanoporeStore((s) => s.appendLog);
  const clearLog = useNanoporeStore((s) => s.clearLog);
  const setOutcome = useNanoporeStore((s) => s.setOutcome);
  const setErrorMessage = useNanoporeStore((s) => s.setErrorMessage);
  const goPrev = useNanoporeStore((s) => s.goPrev);
  const setStep = useNanoporeStore((s) => s.setStep);

  const pushLog = useCallback(
    (entry: NanoporeLogEntry) => appendLog(entry),
    [appendLog],
  );

  // Surface worker bundle/import errors in the log.
  useEffect(() => {
    setWorkerErrorHandler((m) => pushLog({ ts: Date.now(), tag: "error", msg: m }));
  }, [pushLog]);

  // Build the source list shown on this page. Total bytes per source drive
  // the per-source progress bars.
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

  const handleStart = async () => {
    clearLog();
    setOutcome(null);
    setErrorMessage(null);
    setStatus("running");
    setTiming(Date.now(), null);
    pushLog({ ts: Date.now(), tag: "info", msg: `Starting Nanopore SSM run: ${projectName || "(unnamed)"}` });
    pushLog({
      ts: Date.now(),
      tag: "info",
      msg: `${uiSources.length} source(s), ${sites.length} site(s), ${rounds.length} round(s), mode=${pipelineMode}`,
    });

    // Build localFiles / driveFiles + sourceRoundIndices arrays the worker
    // expects. In per-round mode the round binding follows the order
    // (local files first, then Drive files), matching the cDNA convention.
    const jobLocalFiles: File[] = [];
    const jobDriveFiles: { id: string; name: string; sizeBytes: number | null }[] = [];
    const sourceRoundIndices: number[] = [];

    if (pipelineMode === "per-round") {
      // Local-first, then Drive — preserve round-index correspondence.
      for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i]!;
        if (r.file) {
          jobLocalFiles.push(r.file);
          sourceRoundIndices.push(i);
        }
      }
      for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i]!;
        if (r.driveRef) {
          jobDriveFiles.push({
            id: r.driveRef.id,
            name: r.driveRef.name,
            sizeBytes: r.driveRef.sizeBytes,
          });
          sourceRoundIndices.push(i);
        }
      }
    } else {
      jobLocalFiles.push(...localFiles);
      for (const d of driveFiles) {
        jobDriveFiles.push({ id: d.id, name: d.name, sizeBytes: d.sizeBytes });
      }
    }

    let driveToken: string | undefined;
    if (jobDriveFiles.length > 0) {
      if (!CLIENT_ID) {
        const m = "Drive sources selected but VITE_GOOGLE_CLIENT_ID is not configured.";
        pushLog({ ts: Date.now(), tag: "error", msg: m });
        setErrorMessage(m);
        setStatus("error");
        return;
      }
      try {
        const auth = new DriveAuthProvider({ clientId: CLIENT_ID });
        driveToken = await auth.getToken();
      } catch (e) {
        const m = `Failed to refresh Drive token: ${(e as Error).message}`;
        pushLog({ ts: Date.now(), tag: "error", msg: m });
        setErrorMessage(m);
        setStatus("error");
        return;
      }
    }

    try {
      const outcome = await runNanoporeInWorker(
        {
          localFiles: jobLocalFiles,
          driveFiles: jobDriveFiles,
          ...(driveToken ? { driveToken } : {}),
          reference: referenceSeq,
          sites: sites.map((s) => ({
            name: s.name,
            fwAnchor: s.fwAnchor,
            rvAnchor: s.rvAnchor,
          })),
          rounds:
            pipelineMode === "multiplexed"
              ? rounds.map((r) => ({ name: r.name, barcode: r.barcode }))
              : rounds.map((r) => ({ name: r.name })),
          settings: {
            minMeanPhredRead,
            minMeanPhredRoi,
            reportHaplotype,
            pseudocount,
          },
          mode: pipelineMode,
          ...(pipelineMode === "per-round" ? { sourceRoundIndices } : {}),
          useWasm: true,
        },
        (msg) => {
          setProgress(msg);
          setSourceBytes(msg.sourceIndex, msg.bytesProcessed);
        },
        // onLog (Phase 6.13): pipeline pushes settings recap, filter-funnel
        // snapshots, library-median diagnostic, FDR summary. Forward each
        // entry verbatim into the Nanopore store's log buffer.
        (m) => pushLog({ ts: Date.now(), tag: m.tag, msg: m.text }),
      );

      setOutcome(outcome);
      setTiming(useNanoporeStore.getState().startedAt, Date.now());
      setStatus("done");
      pushLog({ ts: Date.now(), tag: "success", msg: "Run complete." });
      // Hop straight to Results so the user sees the numbers.
      setStep("results");
    } catch (e) {
      // If the user already hit Cancel, the worker was terminated and the
      // Comlink RPC threw "Worker has been terminated" or similar. Don't
      // promote that to an "error" status — the cancelled state is what we
      // want to surface in the UI.
      if (useNanoporeStore.getState().status === "cancelled") return;
      const m = `Run failed: ${(e as Error).message}`;
      pushLog({ ts: Date.now(), tag: "error", msg: m });
      setErrorMessage(m);
      setStatus("error");
    }
  };

  const running = status === "running";

  const handleCancel = useCallback(() => {
    terminateWorker();
    setStatus("cancelled");
    setTiming(useNanoporeStore.getState().startedAt, Date.now());
    appendLog({
      ts: Date.now(),
      tag: "warning",
      msg: "Cancelled by user — worker terminated.",
    });
  }, [setStatus, setTiming, appendLog]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="text-base">Run pipeline</CardTitle>
          <CardDescription>
            Per-read flow: read-Q gate → dual-anchor banded scan per site → ROI
            length + Q + frameshift + stop checks → per-site count + (when
            ≥2 sites) joined haplotype.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              {projectName ? (
                <span className="font-medium text-foreground">{projectName}</span>
              ) : (
                "(unnamed project)"
              )}{" "}
              · {uiSources.length} source{uiSources.length === 1 ? "" : "s"} ·{" "}
              {rounds.length} round{rounds.length === 1 ? "" : "s"} · {sites.length}{" "}
              site{sites.length === 1 ? "" : "s"}
              {sites.length >= 2 && reportHaplotype ? " + haplotype" : ""}
            </div>
            {running ? (
              <Button size="lg" variant="destructive" onClick={handleCancel}>
                <Square className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => void handleStart()}
                disabled={uiSources.length === 0}
              >
                <Play className="mr-2 h-4 w-4" />
                Start
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-source progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {uiSources.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active sources.</p>
          ) : (
            uiSources.map((s, i) => {
              const bytes = perSourceBytes[i] ?? 0;
              const pct =
                s.totalBytes && s.totalBytes > 0
                  ? Math.min(100, Math.round((bytes / s.totalBytes) * 100))
                  : 0;
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-mono">{s.name}</span>
                    <span className="text-muted-foreground">{pct}%</span>
                  </div>
                  <Progress value={pct} />
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Live log</CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {status}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
            {log.length === 0 ? (
              <span className="text-muted-foreground">
                {"// log will stream here when you start the run"}
              </span>
            ) : (
              log.map((e, i) => (
                <div key={i} className={TAG_COLORS[e.tag] ?? ""}>
                  [{new Date(e.ts).toLocaleTimeString()}] {e.msg}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={goPrev} disabled={running}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          variant="outline"
          onClick={() => setStep("results")}
          disabled={status !== "done"}
        >
          View results →
        </Button>
      </div>
    </div>
  );
}
