import { useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  useTargetedNanoporeStore,
  type TargetedLogEntry,
} from "@/state/useTargetedNanoporeStore";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";
import {
  runTargetedNanoporeInWorker,
  setWorkerErrorHandler,
  terminateWorker,
} from "@/worker/workerClient";
import { aminoAcidTargetLabel } from "../targetNaming";
import {
  findDuplicateFastqGroups,
  targetedZeroCoverage,
  zeroCoverageMessage,
} from "@/lib/runGuards";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const TAG_COLORS: Record<TargetedLogEntry["tag"], string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function RunStep() {
  const s = useTargetedNanoporeStore();
  const running = s.runState.status === "running";
  const uiSources = useMemo(() => {
    const local = s.rounds.flatMap((round) =>
      round.files.flatMap((source) =>
        source.file
          ? [{
              name: source.file.name,
              totalBytes: isGzipFastq(source.file.name)
                ? null
                : (source.file.size as number | null),
            }]
          : [],
      ),
    );
    const drive = s.rounds.flatMap((round) =>
      round.files.flatMap((source) =>
        source.driveRef
          ? [{
              name: source.driveRef.name,
              totalBytes: isGzipFastq(source.driveRef.name)
                ? null
                : source.driveRef.sizeBytes,
            }]
          : [],
      ),
    );
    // Worker order is local files first, then Drive files.
    return [...local, ...drive];
  }, [s.rounds]);

  useEffect(() => {
    setWorkerErrorHandler((msg) =>
      useTargetedNanoporeStore.getState().appendRunLog({ tag: "error", msg }),
    );
  }, []);

  const run = useCallback(async () => {
    const current = useTargetedNanoporeStore.getState();
    current.setRunState({
      status: "running",
      error: null,
      outcome: null,
      startedAt: Date.now(),
      finishedAt: null,
      progress: null,
      perSourceBytes: {},
      log: [],
    });
    current.appendRunLog({
      tag: "info",
      msg:
        `Starting targeted Nanopore run · ${current.rounds.length} rounds · ` +
        `${uiSources.length} files · ${current.sites.length} targets`,
    });

    try {
      const localFiles: File[] = [];
      const driveFiles: NonNullable<
        (typeof current.rounds)[number]["files"][number]["driveRef"]
      >[] = [];
      const localRounds: number[] = [];
      const driveRounds: number[] = [];
      for (const round of current.rounds) {
        for (const source of round.files) {
          if (source.file) {
            localFiles.push(source.file);
            localRounds.push(round.round);
          } else if (source.driveRef) {
            driveFiles.push(source.driveRef);
            driveRounds.push(round.round);
          }
        }
      }
      const duplicateGroups = await findDuplicateFastqGroups(
        current.rounds.flatMap((round) =>
          round.files.flatMap((source) =>
            source.file
              ? [{
                  file: source.file,
                  label: `Round ${round.round} ← ${source.file.name}`,
                }]
              : [],
          ),
        ),
        current.rounds.flatMap((round) =>
          round.files.flatMap((source) =>
            source.driveRef
              ? [{
                  file: source.driveRef,
                  label: `Round ${round.round} ← ${source.driveRef.name}`,
                }]
              : [],
          ),
        ),
      );
      if (duplicateGroups.length > 0) {
        throw new Error(
          "Duplicate FASTQ content detected: " +
          duplicateGroups.map((labels) => labels.join(" ↔ ")).join("; ") +
          ". Remove duplicate inputs before running.",
        );
      }

      let driveToken: string | undefined;
      if (driveFiles.length) {
        if (!CLIENT_ID) throw new Error("Google Drive OAuth is not configured.");
        driveToken = await new DriveAuthProvider({ clientId: CLIENT_ID }).getToken();
      }

      const outcome = await runTargetedNanoporeInWorker(
        {
          localFiles,
          driveFiles,
          ...(driveToken ? { driveToken } : {}),
          sourceRoundIndices: [...localRounds, ...driveRounds],
          roundNames: current.rounds.map((round) => `Round ${round.round}`),
          reference: current.referenceSeq,
          sites: current.sites.map((site) => ({
            name: aminoAcidTargetLabel(
              current.referenceSeq,
              current.cdsStart,
              site.ntStart,
            ).name,
            ntStart: site.ntStart,
            length: 3,
          })),
          settings: {
            ...current.settings,
            reportHaplotypes:
              current.reportHaplotypes && current.sites.length >= 2,
          },
        },
        (progress) =>
          useTargetedNanoporeStore.getState().updateRunProgress(progress),
        (event) =>
          useTargetedNanoporeStore
            .getState()
            .appendRunLog({ tag: event.tag, msg: event.text }),
      );

      const latest = useTargetedNanoporeStore.getState();
      if (latest.runState.status === "cancelled") return;
      const zeroCoverage = targetedZeroCoverage(
        outcome,
        current.reportHaplotypes && current.sites.length >= 2,
      );
      if (zeroCoverage.length > 0) {
        const message = zeroCoverageMessage(zeroCoverage);
        latest.appendRunLog({ tag: "error", msg: message });
        latest.setRunState({
          status: "error",
          error: message,
          outcome,
          finishedAt: Date.now(),
        });
        return;
      }
      latest.appendRunLog({ tag: "success", msg: "Run complete; opening results." });
      latest.setRunState({
        status: "done",
        outcome,
        finishedAt: Date.now(),
      });
      latest.setStep("results");
    } catch (error) {
      const latest = useTargetedNanoporeStore.getState();
      if (latest.runState.status === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      latest.appendRunLog({ tag: "error", msg: `Run failed: ${message}` });
      latest.setRunState({
        status: "error",
        error: message,
        finishedAt: Date.now(),
      });
    }
  }, [uiSources.length]);

  const cancel = useCallback(() => {
    terminateWorker();
    const current = useTargetedNanoporeStore.getState();
    current.setRunState({ status: "cancelled", finishedAt: Date.now() });
    current.appendRunLog({
      tag: "warning",
      msg: "Cancelled by user — worker terminated.",
    });
  }, []);

  const status = s.runState.status;
  const showProgress = status !== "idle";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Card className="border-primary/40">
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Run targeted Nanopore pipeline</CardTitle>
            <CardDescription>
              {status === "idle" &&
                `Ready: ${uiSources.length} file(s), ${s.rounds.length} round(s), ${s.sites.length} target(s).`}
              {status === "running" &&
                "Streaming reads, aligning the reference, applying QC and counting target states."}
              {status === "done" && "Finished."}
              {status === "error" && "Halted with an error; the log identifies the last completed phase."}
              {status === "cancelled" && "Cancelled."}
            </CardDescription>
          </div>
          {running ? (
            <Button size="lg" variant="destructive" onClick={cancel}>
              <Square className="mr-2 h-4 w-4" />
              Cancel
            </Button>
          ) : (
            <Button
              size="lg"
              disabled={!s.qcLocked || uiSources.length === 0}
              onClick={() => void run()}
            >
              <Play className="mr-2 h-4 w-4" />
              {status === "idle" ? "Run analysis" : "Run again"}
            </Button>
          )}
        </CardHeader>
        {showProgress && (
          <CardContent className="space-y-4">
            <OverallProgress sources={uiSources} />
            <div className="space-y-2">
              {uiSources.map((source, index) => (
                <PerFileProgress
                  key={`${source.name}:${index}`}
                  index={index}
                  name={source.name}
                  totalBytes={source.totalBytes}
                />
              ))}
            </div>
            {s.runState.error && (
              <p className="text-sm text-destructive">{s.runState.error}</p>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Live log</CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {status}
          </Badge>
        </CardHeader>
        <CardContent>
          <LogViewer />
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button
          variant="outline"
          disabled={running}
          onClick={() => s.setStep("qc")}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          variant="outline"
          disabled={status !== "done"}
          onClick={() => s.setStep("results")}
        >
          View results →
        </Button>
      </div>
    </div>
  );
}

function OverallProgress({
  sources,
}: {
  sources: Array<{ name: string; totalBytes: number | null }>;
}) {
  const runState = useTargetedNanoporeStore((state) => state.runState);
  const totalKnownBytes = sources.reduce(
    (sum, source) => sum + (source.totalBytes ?? 0),
    0,
  );
  const hasUnknownTotal = sources.some((source) => source.totalBytes == null);
  const bytesDone = Object.values(runState.perSourceBytes).reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  const knownBytesDone = sources.reduce(
    (sum, source, index) =>
      sum +
      (source.totalBytes == null
        ? 0
        : Math.min(runState.perSourceBytes[index] ?? 0, source.totalBytes)),
    0,
  );
  const percent =
    totalKnownBytes > 0 && !hasUnknownTotal
      ? Math.min(100, (knownBytesDone / totalKnownBytes) * 100)
      : 0;
  const elapsedSeconds = runState.startedAt
    ? ((runState.finishedAt ?? Date.now()) - runState.startedAt) / 1000
    : 0;
  const etaSeconds =
    totalKnownBytes > 0 &&
    !hasUnknownTotal &&
    knownBytesDone > 1024 * 1024 &&
    runState.status === "running"
      ? Math.max(
          0,
          ((totalKnownBytes - knownBytesDone) / knownBytesDone) * elapsedSeconds,
        )
      : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Overall</span>
        <span className="font-mono text-muted-foreground">
          {hasUnknownTotal
            ? `${formatBytes(bytesDone)} processed · total unknown`
            : `${percent.toFixed(1)}% · ${formatBytes(knownBytesDone)} / ${formatBytes(totalKnownBytes)}`}{" "}
          · {formatDuration(elapsedSeconds)} elapsed
          {etaSeconds != null && ` · ETA ${formatDuration(etaSeconds)}`}
        </span>
      </div>
      <Progress value={hasUnknownTotal ? undefined : percent} />
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
  const bytesDone = useTargetedNanoporeStore(
    (state) => state.runState.perSourceBytes[index] ?? 0,
  );
  const activeIndex = useTargetedNanoporeStore(
    (state) => state.runState.progress?.sourceIndex,
  );
  const percent =
    totalBytes && totalBytes > 0
      ? Math.min(100, (bytesDone / totalBytes) * 100)
      : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          {activeIndex === index && (
            <Badge variant="default" className="py-0 text-[10px]">
              streaming
            </Badge>
          )}
          <span className="truncate font-mono">{name}</span>
        </span>
        <span className="ml-2 shrink-0 font-mono text-muted-foreground">
          {formatBytes(bytesDone)}
          {totalBytes != null &&
            ` / ${formatBytes(totalBytes)} · ${percent.toFixed(0)}%`}
        </span>
      </div>
      <Progress value={totalBytes == null ? undefined : percent} className="h-1.5" />
    </div>
  );
}

function LogViewer() {
  const log = useTargetedNanoporeStore((state) => state.runState.log);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log.length]);

  return (
    <div
      ref={ref}
      className="h-56 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"
    >
      {log.length === 0 ? (
        <span className="text-muted-foreground">
          {"// log will stream here when you start the run"}
        </span>
      ) : (
        log.map((entry, index) => (
          <div
            key={`${entry.ts}:${index}`}
            className={TAG_COLORS[entry.tag]}
          >
            [{new Date(entry.ts).toLocaleTimeString()}] {entry.msg}
          </div>
        ))
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds - minutes * 60)}s`;
}

function isGzipFastq(name: string): boolean {
  return /\.(?:fastq|fq|fastqsanger)\.gz$/i.test(name);
}
