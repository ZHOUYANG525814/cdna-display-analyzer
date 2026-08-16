import * as Comlink from "comlink";
import { runPipeline, type PipelineProgress } from "@cdna/core";
import type { IAuthProvider, IFastqSource } from "@cdna/types";
import { LocalFastqSource } from "../adapters/LocalFastqSource";
import { DriveFastqSource } from "../adapters/DriveFastqSource";
import { AutoDecompressFastqSource } from "../adapters/AutoDecompressFastqSource";
import {
  streamParseEnrichmentBlob,
  type StreamCsvOptions,
  type StreamCsvResult,
} from "../tools/cdna-display/viz/csvParse";
import type {
  PipelineJob,
  PipelineLogMsg,
  PipelineOutcome,
  PipelineProgressMsg,
} from "./types";
import { buildRunProvenance } from "./provenance";

function refreshingAuth(
  initialToken: string | undefined,
  refresh?: () => Promise<string>,
): IAuthProvider {
  return {
    async signIn() {},
    async signOut() {},
    async getToken() {
      if (refresh) return refresh();
      if (initialToken) return initialToken;
      throw new Error("Drive token is unavailable.");
    },
    isSignedIn() { return Boolean(refresh || initialToken); },
  };
}

const api = {
  async run(
    job: PipelineJob,
    onProgress?: (message: PipelineProgressMsg) => void,
    onLog?: (message: PipelineLogMsg) => void,
    refreshDriveToken?: () => Promise<string>,
  ): Promise<PipelineOutcome> {
    if (job.driveFiles.length > 0 && !job.driveToken && !refreshDriveToken) {
      throw new Error("Drive files specified but no OAuth token attached to the job.");
    }
    const auth = job.driveFiles.length > 0
      ? refreshingAuth(job.driveToken, refreshDriveToken)
      : null;
    const sources: IFastqSource[] = [
      ...job.localFiles.map((file) => new AutoDecompressFastqSource(new LocalFastqSource(file))),
      ...job.driveFiles.map((file) =>
        new AutoDecompressFastqSource(new DriveFastqSource(file, auth!)),
      ),
    ];
    const names = [...job.localFiles.map((file) => file.name), ...job.driveFiles.map((file) => file.name)];
    const result = await runPipeline({
      sources,
      rounds: job.rounds,
      settings: job.settings,
      pseudocount: job.pseudocount,
      useWasm: job.useWasm,
      compactAnalyzer: true,
      onProgress: (progress: PipelineProgress) => onProgress?.({
        sourceIndex: progress.sourceIndex,
        fileName: names[progress.sourceIndex] ?? "",
        bytesProcessed: progress.bytesProcessed,
        totalBytes: progress.totalBytes,
        recordsProcessed: progress.recordsProcessed,
      }),
      ...(onLog ? { onLog } : {}),
      ...(job.mode === "per-round" && job.sourceRoundIndices
        ? { sourceRoundIndices: job.sourceRoundIndices }
        : {}),
    });

    const statsByRound: PipelineOutcome["statsByRound"] = {};
    for (const [round, stats] of result.stats) statsByRound[round] = stats;
    const csvParts = result.analyzer?.csvParts ?? null;
    const csvBlob = csvParts ? new Blob(csvParts, { type: "text/csv" }) : null;
    if (csvParts) csvParts.length = 0;
    const libraryMedianEnrich = result.analyzer?.libraryMedianEnrich ?? {};
    const hitCounts: PipelineOutcome["hitCounts"] = [];
    if (result.analyzer) {
      const roundNames = job.rounds.map((round) => round.name);
      const first = roundNames[0];
      for (const current of roundNames.slice(1)) {
        const qColumn = `FDR_q_${current}_vs_${first}`;
        const { q05, q01 } = result.analyzer.fdrHitCounts[qColumn] ?? { q05: 0, q01: 0 };
        hitCounts.push({ label: `${current} vs ${first}`, q05, q01, total: result.analyzer.rowCount });
      }
    }
    result.dnaCounters.clear();
    const provenance = await buildRunProvenance({
      localFiles: job.localFiles,
      driveFiles: job.driveFiles,
      ...(job.sourceRoundIndices ? { sourceRoundIndices: job.sourceRoundIndices } : {}),
      roundNames: job.rounds.map((round) => round.name),
      reference: job.reference ?? "",
      configVersion: "cdna-display-config/v2",
      runtime: { scoringEngine: job.useWasm ? "cdna-wasm" : "typescript" },
    });
    const runStats = JSON.parse(result.runStatsJson) as Record<string, unknown>;
    runStats.provenance = provenance;
    return {
      runStatsJson: JSON.stringify(runStats, null, 2),
      csvBlob,
      globalUnassigned: result.globalUnassigned,
      unassignedBreakdown: result.unassignedBreakdown,
      statsByRound,
      roundNames: job.rounds.map((round) => round.name),
      libraryMedianEnrich,
      hitCounts,
    };
  },

  async parseCsv(blob: Blob, options: StreamCsvOptions = {}): Promise<StreamCsvResult> {
    return streamParseEnrichmentBlob(blob, options);
  },
};

export type CdnaWorkerApi = typeof api;
Comlink.expose(api);
self.postMessage({ __ready: true, ts: Date.now() });
