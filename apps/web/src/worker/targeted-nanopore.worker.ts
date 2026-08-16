import * as Comlink from "comlink";
import { runTargetedNanoporePipeline } from "@cdna/core";
import type { IAuthProvider, IFastqSource } from "@cdna/types";
import { LocalFastqSource } from "../adapters/LocalFastqSource";
import { DriveFastqSource } from "../adapters/DriveFastqSource";
import { AutoDecompressFastqSource } from "../adapters/AutoDecompressFastqSource";
import type {
  PipelineLogMsg,
  PipelineProgressMsg,
  TargetedNanoporeJob,
  TargetedNanoporeOutcome,
} from "./types";
import { buildRunProvenance } from "./provenance";

const PREVIEW_ROWS = 200;

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
    job: TargetedNanoporeJob,
    onProgress?: (message: PipelineProgressMsg) => void,
    onLog?: (message: PipelineLogMsg) => void,
    refreshDriveToken?: () => Promise<string>,
  ): Promise<TargetedNanoporeOutcome> {
    if (job.driveFiles.length > 0 && !job.driveToken && !refreshDriveToken) {
      throw new Error("Drive files require an OAuth token.");
    }
    const auth = job.driveFiles.length > 0
      ? refreshingAuth(job.driveToken, refreshDriveToken)
      : null;
    const sources: IFastqSource[] = [
      ...job.localFiles.map((file) => new AutoDecompressFastqSource(new LocalFastqSource(file))),
      ...job.driveFiles.map((file) => new AutoDecompressFastqSource(new DriveFastqSource(file, auth!))),
    ];
    const names = [...job.localFiles.map((file) => file.name), ...job.driveFiles.map((file) => file.name)];
    const preflightStartedAt = performance.now();
    const preflight = await runTargetedNanoporePipeline({
      sources,
      sourceRoundIndices: job.sourceRoundIndices,
      roundNames: job.roundNames,
      reference: job.reference,
      sites: job.sites,
      settings: job.settings,
      maxReadsPerSource: 200,
      useWasmAlignment: job.useWasmAlignment ?? false,
    });
    const preflightReads = [...preflight.stats.values()].reduce((sum, stats) => sum + stats.total_reads, 0);
    const preflightCallable = [...preflight.stats.values()].reduce(
      (sum, stats) => sum + Object.values(stats.sites).reduce((siteSum, site) => siteSum + site.passed_qc, 0),
      0,
    );
    const preflightUnique = [...preflight.dnaCounters.values()].reduce(
      (sum, sites) => sum + [...sites.values()].reduce((siteSum, counter) => siteSum + counter.size, 0),
      0,
    );
    const preflightSeconds = (performance.now() - preflightStartedAt) / 1000;
    onLog?.({
      tag: preflightCallable > 0 ? "info" : "warning",
      text:
        `Preflight · sampled=${preflightReads.toLocaleString()} reads · callableTargets=${preflightCallable.toLocaleString()} · ` +
        `initialUniqueCodons=${preflightUnique.toLocaleString()} · ` +
        `estimated=${preflightReads > 0 ? (preflightSeconds / preflightReads * 1_000_000).toFixed(1) : "n/a"} s/M reads · ` +
        "parameters unchanged",
    });
    preflight.dnaCounters.clear();
    preflight.haplotypeCounters.clear();
    preflight.analyzer.perSiteRows.length = 0;
    preflight.analyzer.haplotypeRows.length = 0;
    preflight.analyzer.perSiteCsvParts.length = 0;
    preflight.analyzer.haplotypeCsvParts.length = 0;
    const result = await runTargetedNanoporePipeline({
      sources,
      sourceRoundIndices: job.sourceRoundIndices,
      roundNames: job.roundNames,
      reference: job.reference,
      sites: job.sites,
      settings: job.settings,
      useWasmAlignment: job.useWasmAlignment ?? false,
      onProgress: (progress) => onProgress?.({
        sourceIndex: progress.sourceIndex,
        fileName: names[progress.sourceIndex] ?? "",
        bytesProcessed: progress.bytesProcessed,
        totalBytes: progress.totalBytes,
        recordsProcessed: progress.recordsProcessed,
      }),
      ...(onLog ? { onLog } : {}),
    });

    const statsByRound: TargetedNanoporeOutcome["statsByRound"] = {};
    for (const [round, stats] of result.stats) statsByRound[round] = stats;
    const wtBySite: Record<string, string> = {};
    for (const site of result.resolvedSites) wtBySite[site.name] = site.wtDna;
    const exactCodonCounts: TargetedNanoporeOutcome["exactCodonCounts"] = {};
    const exactHaplotypeCounts: TargetedNanoporeOutcome["exactHaplotypeCounts"] = {};
    for (const round of job.roundNames) {
      exactCodonCounts[round] = {};
      for (const site of result.resolvedSites) {
        exactCodonCounts[round]![site.name] = Object.fromEntries(
          result.dnaCounters.get(round)?.get(site.name) ?? [],
        );
      }
      exactHaplotypeCounts[round] = Object.fromEntries(result.haplotypeCounters.get(round) ?? []);
    }
    const hitCounts: TargetedNanoporeOutcome["hitCounts"] = [];
    const baseline = job.roundNames[0]!;
    for (const comparison of job.roundNames.slice(1)) {
      const qColumn = `FDR_q_${comparison}_vs_${baseline}`;
      for (const site of result.resolvedSites) {
        const rows = result.analyzer.perSiteRows.filter(
          (row) => row.Target === site.name && row.Score_Eligible === "yes",
        );
        const qValues = rows.map((row) => Number(row[qColumn])).filter(Number.isFinite);
        hitCounts.push({
          label: `${site.name} @ ${comparison} vs ${baseline}`,
          q05: qValues.filter((q) => q < 0.05).length,
          q01: qValues.filter((q) => q < 0.01).length,
          total: rows.length,
        });
      }
    }
    const provenance = await buildRunProvenance({
      localFiles: job.localFiles,
      driveFiles: job.driveFiles,
      sourceRoundIndices: job.sourceRoundIndices,
      roundNames: job.roundNames,
      reference: job.reference,
      configVersion: "targeted-nanopore-config/v4",
      runtime: { alignmentEngine: job.useWasmAlignment ? "targeted-wasm-v1" : "typescript" },
    });
    const perSiteCsvBlob = result.analyzer.perSiteCsvParts.length
      ? new Blob(result.analyzer.perSiteCsvParts, { type: "text/csv" }) : null;
    const haplotypeCsvBlob = result.analyzer.haplotypeCsvParts.length
      ? new Blob(result.analyzer.haplotypeCsvParts, { type: "text/csv" }) : null;
    const exactCodonCsvBlob = result.exactCodonCsvParts.length
      ? new Blob(result.exactCodonCsvParts, { type: "text/csv" }) : null;
    const exactHaplotypeCsvBlob = result.exactHaplotypeCsvParts.length
      ? new Blob(result.exactHaplotypeCsvParts, { type: "text/csv" }) : null;
    result.analyzer.perSiteCsvParts.length = 0;
    result.analyzer.haplotypeCsvParts.length = 0;
    result.exactCodonCsvParts.length = 0;
    result.exactHaplotypeCsvParts.length = 0;
    result.dnaCounters.clear();
    result.haplotypeCounters.clear();
    return {
      perSiteCsvBlob,
      haplotypeCsvBlob,
      exactCodonCsvBlob,
      exactHaplotypeCsvBlob,
      perSiteRowsPreview: result.analyzer.perSiteRows.slice(0, PREVIEW_ROWS),
      haplotypeRowsPreview: result.analyzer.haplotypeRows.slice(0, PREVIEW_ROWS),
      perSiteRowsForViz: result.analyzer.perSiteRows,
      exactCodonCounts,
      exactHaplotypeCounts,
      haplotypeStatistics: result.analyzer.haplotypeRows,
      statsByRound,
      fileStats: result.fileStats,
      roundNames: [...job.roundNames],
      siteNames: result.resolvedSites.map((site) => site.name),
      targets: result.resolvedSites.map((site) => ({
        name: site.name,
        ntStart: site.ntStart,
        wtDna: site.wtDna,
        wtAa: site.wtAa,
      })),
      wtBySite,
      libraryMedianFitness: result.analyzer.libraryMedianFitness,
      hitCounts,
      provenance,
    };
  },
};

export type TargetedNanoporeWorkerApi = typeof api;
Comlink.expose(api);
self.postMessage({ __ready: true, ts: Date.now() });
