// Comlink-exposed worker module. Vite picks this up via the
//   new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" })
// invocation in workerClient.ts.
//
// We deliberately construct LocalFastqSource on the worker side so the File
// objects (which are structured-cloneable) cross only once, and the streaming
// reads never have to cross the boundary.

import * as Comlink from "comlink";
import {
  runPipeline,
  runNanoporePipeline,
  runTargetedNanoporePipeline,
  type NanoporePipelineProgress,
  type PipelineProgress,
} from "@cdna/core";
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
  NanoporeJob,
  NanoporeOutcome,
  TargetedNanoporeJob,
  TargetedNanoporeOutcome,
  PipelineJob,
  PipelineLogMsg,
  PipelineProgressMsg,
  PipelineOutcome,
} from "./types";

const PREVIEW_ROWS = 200;

// Worker-side console.log appears in DevTools under its own thread context;
// every `[worker]` line below shows up when DevTools → Console → "all
// contexts" is selected. This is the single source of truth when debugging
// a stuck pipeline — every long-running step gets logged on entry and exit.
function wlog(msg: string, extra?: unknown): void {
  if (extra !== undefined) {
    console.log(`[worker] ${msg}`, extra);
  } else {
    console.log(`[worker] ${msg}`);
  }
}

// Stub auth provider for the worker side: the main thread fetched a token
// before submitting the job, so we just hand that back. If the token expires
// mid-pipeline we surface the error and the user re-runs (token refresh
// across the worker boundary is a Phase 4+ concern).
function staticAuth(token: string): IAuthProvider {
  return {
    async signIn() {},
    async signOut() {},
    async getToken() {
      return token;
    },
    isSignedIn() {
      return true;
    },
  };
}

// Raw `message` listener BEFORE Comlink.expose — verifies that postMessage
// from the main thread is actually arriving at the worker. If this fires but
// `[worker] run() entered` doesn't, the message is reaching us but Comlink
// isn't dispatching it.
self.addEventListener("message", (event: MessageEvent) => {
  wlog("raw postMessage received", { dataType: typeof event.data, hasPort: event.ports.length });
});

wlog("module loaded — about to call Comlink.expose");

const api = {
  /**
   * Run the pipeline on a mix of local files and Drive files. The progress
   * callback is a Comlink proxy; calling it sends a structured-clone message
   * back to the main thread (one per ~64k records — see core/src/pipeline.ts).
   */
  async run(
    job: PipelineJob,
    onProgress?: (msg: PipelineProgressMsg) => void,
    onLog?: (msg: PipelineLogMsg) => void,
  ): Promise<PipelineOutcome> {
    const log = (m: string, extra?: unknown) => wlog(m, extra);

    try {
      log("run() entered", {
        localFiles: job.localFiles.length,
        driveFiles: job.driveFiles.length,
        rounds: job.rounds.length,
        useWasm: job.useWasm,
      });

      if (job.driveFiles.length > 0 && !job.driveToken) {
        throw new Error("Drive files specified but no OAuth token attached to the job.");
      }
      const auth = job.driveToken ? staticAuth(job.driveToken) : null;

      // Local files come first, then Drive files. Source-index ordering matches
      // the UI display so progress events point at the right name.
      const sources: IFastqSource[] = [
        ...job.localFiles.map((f) => new LocalFastqSource(f)),
        ...job.driveFiles.map((d) =>
          new DriveFastqSource({ id: d.id, name: d.name, sizeBytes: d.sizeBytes }, auth!),
        ),
      ];
      const sourceNames = [
        ...job.localFiles.map((f) => f.name),
        ...job.driveFiles.map((d) => d.name),
      ];
      log(`constructed ${sources.length} sources`, sourceNames);

      let lastReportedSrc = -1;
      const wrappedProgress = (p: PipelineProgress) => {
        // Log when we cross into a new source so the user sees "starting file N"
        if (p.sourceIndex !== lastReportedSrc) {
          lastReportedSrc = p.sourceIndex;
          log(
            `source[${p.sourceIndex}] = ${sourceNames[p.sourceIndex]} — first progress event`,
          );
        }
        onProgress?.({
          sourceIndex: p.sourceIndex,
          fileName: sourceNames[p.sourceIndex] ?? "",
          bytesProcessed: p.bytesProcessed,
          totalBytes: p.totalBytes,
          recordsProcessed: p.recordsProcessed,
        });
      };

      log("calling runPipeline …", {
        mode: job.mode ?? "multiplexed",
        sourceRoundIndices: job.sourceRoundIndices,
      });
      const result = await runPipeline({
        sources,
        rounds: job.rounds,
        settings: job.settings,
        pseudocount: job.pseudocount,
        useWasm: job.useWasm,
        onProgress: wrappedProgress,
        ...(onLog ? { onLog } : {}),
        ...(job.mode === "per-round" && job.sourceRoundIndices
          ? { sourceRoundIndices: job.sourceRoundIndices }
          : {}),
      });
      log("runPipeline returned", {
        globalUnassigned: result.globalUnassigned,
        roundStats: Array.from(result.stats.entries()).map(([k, v]) => ({
          name: k,
          passed_qc: v.passed_qc,
        })),
      });

      // Flatten Maps → plain records so the postMessage clone succeeds.
      const statsByRound: Record<string, ReturnType<typeof result.stats.get> & {}> = {};
      for (const [name, stat] of result.stats) {
        statsByRound[name] = stat;
      }

      // Wrap the CSV in a Blob so postMessage doesn't deep-copy it. Blobs are
      // structured-cloneable but cross by reference, not value — this matters
      // when the CSV is tens of MB. We pass `csvParts` (a string[] of one
      // entry per line) straight to the Blob constructor: it accepts a list
      // of strings without ever concatenating them into one JS String, so the
      // CSV bytes can total many GB without tripping V8's ~537 MB string-
      // length ceiling.
      const csvParts = result.analyzer?.csvParts ?? null;
      const csvBlob = csvParts ? new Blob(csvParts, { type: "text/csv" }) : null;
      log(`csvParts lines=${csvParts?.length ?? 0} → wrapped as Blob (size=${csvBlob?.size ?? 0})`);

      // Compute hit counts per (last_round vs first) FDR threshold so the
      // Results page can render headline numbers without re-parsing the CSV.
      const libraryMedianEnrich = result.analyzer?.libraryMedianEnrich ?? {};
      const hitCounts: Array<{ label: string; q05: number; q01: number; total: number }> = [];
      if (result.analyzer) {
        const roundNames = job.rounds.map((r) => r.name);
        const first = roundNames[0];
        for (let i = 1; i < roundNames.length; i++) {
          const curr = roundNames[i]!;
          const qCol = `FDR_q_${curr}_vs_${first}`;
          let q05 = 0;
          let q01 = 0;
          for (const row of result.analyzer.rows) {
            const q = row[qCol] as number;
            if (Number.isFinite(q)) {
              if (q < 0.05) q05++;
              if (q < 0.01) q01++;
            }
          }
          hitCounts.push({
            label: `${curr} vs ${first}`,
            q05,
            q01,
            total: result.analyzer.rows.length,
          });
        }
      }

      return {
        runStatsJson: result.runStatsJson,
        csvBlob,
        globalUnassigned: result.globalUnassigned,
        unassignedBreakdown: result.unassignedBreakdown,
        statsByRound,
        roundNames: job.rounds.map((r) => r.name),
        libraryMedianEnrich,
        hitCounts,
      };
    } catch (e: unknown) {
      const err = e as Error;
      const msg = `worker run() threw: ${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`;
      console.error(`[worker] ${msg}`);
      throw e;
    }
  },

  /**
   * Nanopore SSM run. Same boundary semantics as `run` (Comlink-proxied
   * progress, structured-clone payloads, Blob-wrapped CSVs) but routes to
   * `runNanoporePipeline` with per-site + haplotype output.
   */
  async runNanopore(
    job: NanoporeJob,
    onProgress?: (msg: PipelineProgressMsg) => void,
    onLog?: (msg: PipelineLogMsg) => void,
  ): Promise<NanoporeOutcome> {
    const log = (m: string, extra?: unknown) => wlog(m, extra);

    try {
      log("runNanopore() entered", {
        localFiles: job.localFiles.length,
        driveFiles: job.driveFiles.length,
        sites: job.sites.length,
        rounds: job.rounds.length,
        mode: job.mode ?? "multiplexed",
        useWasm: job.useWasm,
      });

      if (job.driveFiles.length > 0 && !job.driveToken) {
        throw new Error("Drive files specified but no OAuth token attached to the job.");
      }
      const auth = job.driveToken ? staticAuth(job.driveToken) : null;

      const sources: IFastqSource[] = [
        ...job.localFiles.map((f) => new LocalFastqSource(f)),
        ...job.driveFiles.map((d) =>
          new DriveFastqSource({ id: d.id, name: d.name, sizeBytes: d.sizeBytes }, auth!),
        ),
      ];
      const sourceNames = [
        ...job.localFiles.map((f) => f.name),
        ...job.driveFiles.map((d) => d.name),
      ];
      log(`constructed ${sources.length} sources`, sourceNames);

      let lastReportedSrc = -1;
      const wrappedProgress = (p: NanoporePipelineProgress) => {
        if (p.sourceIndex !== lastReportedSrc) {
          lastReportedSrc = p.sourceIndex;
          log(
            `[nanopore] source[${p.sourceIndex}] = ${sourceNames[p.sourceIndex]} — first progress event`,
          );
        }
        onProgress?.({
          sourceIndex: p.sourceIndex,
          fileName: sourceNames[p.sourceIndex] ?? "",
          bytesProcessed: p.bytesProcessed,
          totalBytes: p.totalBytes,
          recordsProcessed: p.recordsProcessed,
        });
      };

      log("calling runNanoporePipeline …");
      const result = await runNanoporePipeline({
        sources,
        reference: job.reference,
        sites: job.sites,
        rounds: job.rounds,
        ...(job.settings ? { settings: job.settings } : {}),
        useWasm: job.useWasm,
        onProgress: wrappedProgress,
        ...(onLog ? { onLog } : {}),
        ...(job.mode === "per-round" && job.sourceRoundIndices
          ? { sourceRoundIndices: job.sourceRoundIndices }
          : {}),
      });
      log("runNanoporePipeline returned", {
        sites: result.siteNames.length,
        roundsWithStats: Array.from(result.stats.keys()),
        perSiteRows: result.analyzer.perSiteRows.length,
        haplotypeRows: result.analyzer.haplotypeRows.length,
      });

      // Flatten Map<round, NanoporeRoundStats> → Record. Each value already
      // has `sites: Record<string, NanoporeSiteStats>` so the nested shape
      // is already structurally cloneable.
      const statsByRound: Record<string, ReturnType<typeof result.stats.get> & {}> = {};
      for (const [name, stat] of result.stats) {
        statsByRound[name] = stat;
      }

      // Site → WT DNA map, used by the UI to badge WT rows.
      const resolvedWtBySite: Record<string, string> = {};
      const expectedRoiLenBySite: Record<string, number> = {};
      for (const s of result.resolvedSites) {
        resolvedWtBySite[s.name] = s.wtDna;
        expectedRoiLenBySite[s.name] = s.expectedRoiLen;
      }

      // Same string[] → Blob pattern as the cDNA path: avoids materializing
      // multi-GB CSV text as one JS String.
      const perSiteCsvParts = result.analyzer.perSiteCsvParts;
      const haplotypeCsvParts = result.analyzer.haplotypeCsvParts;
      const perSiteCsvBlob =
        perSiteCsvParts.length > 0 ? new Blob(perSiteCsvParts, { type: "text/csv" }) : null;
      const haplotypeCsvBlob =
        haplotypeCsvParts.length > 0 ? new Blob(haplotypeCsvParts, { type: "text/csv" }) : null;
      log(
        `csv lines: per-site=${perSiteCsvParts.length}, haplotype=${haplotypeCsvParts.length}` +
          ` (sizes: per-site=${perSiteCsvBlob?.size ?? 0}, hap=${haplotypeCsvBlob?.size ?? 0})`,
      );

      // Hit counts per (site, lastRound vs first) at standard FDR thresholds.
      // Same shape as the cDNA path so the MethodsCard can render identically.
      const libraryMedianFitness = result.analyzer.libraryMedianFitness;
      const hitCounts: Array<{ label: string; q05: number; q01: number; total: number }> = [];
      const npRoundNames = result.roundNames;
      const npLast = npRoundNames[npRoundNames.length - 1];
      const npFirst = npRoundNames[0];
      if (npLast && npFirst && npLast !== npFirst) {
        const qCol = `FDR_q_${npLast}`;
        const counts = new Map<string, { q05: number; q01: number; total: number }>();
        for (const row of result.analyzer.perSiteRows) {
          const site = String(row.Site);
          const c = counts.get(site) ?? { q05: 0, q01: 0, total: 0 };
          c.total++;
          const q = row[qCol] as number;
          if (Number.isFinite(q)) {
            if (q < 0.05) c.q05++;
            if (q < 0.01) c.q01++;
          }
          counts.set(site, c);
        }
        for (const [site, c] of counts) {
          hitCounts.push({ label: `${site} @ ${npLast}`, ...c });
        }
      }

      return {
        perSiteCsvBlob,
        haplotypeCsvBlob,
        perSiteRowsPreview: result.analyzer.perSiteRows.slice(0, PREVIEW_ROWS),
        haplotypeRowsPreview: result.analyzer.haplotypeRows.slice(0, PREVIEW_ROWS),
        statsByRound,
        globalBreakdown: result.globalBreakdown,
        roundNames: result.roundNames,
        siteNames: result.siteNames,
        resolvedWtBySite,
        expectedRoiLenBySite,
        libraryMedianFitness,
        hitCounts,
      };
    } catch (e: unknown) {
      const err = e as Error;
      const msg = `worker runNanopore() threw: ${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`;
      console.error(`[worker] ${msg}`);
      throw e;
    }
  },

  async runTargetedNanopore(
    job: TargetedNanoporeJob,
    onProgress?: (msg: PipelineProgressMsg) => void,
    onLog?: (msg: PipelineLogMsg) => void,
  ): Promise<TargetedNanoporeOutcome> {
    if (job.driveFiles.length > 0 && !job.driveToken) throw new Error("Drive files require an OAuth token.");
    const auth = job.driveToken ? staticAuth(job.driveToken) : null;
    const sources: IFastqSource[] = [
      ...job.localFiles.map((f) => new AutoDecompressFastqSource(new LocalFastqSource(f))),
      ...job.driveFiles.map((d) => new AutoDecompressFastqSource(new DriveFastqSource(d, auth!))),
    ];
    const names = [...job.localFiles.map((f) => f.name), ...job.driveFiles.map((d) => d.name)];
    const result = await runTargetedNanoporePipeline({
      sources,
      sourceRoundIndices: job.sourceRoundIndices,
      roundNames: job.roundNames,
      reference: job.reference,
      sites: job.sites,
      settings: job.settings,
      onProgress: (p) => onProgress?.({
        sourceIndex: p.sourceIndex,
        fileName: names[p.sourceIndex] ?? "",
        bytesProcessed: p.bytesProcessed,
        totalBytes: p.totalBytes,
        recordsProcessed: p.recordsProcessed,
      }),
      onLog: (event) => onLog?.(event),
    });
    const statsByRound: Record<string, (typeof result.stats extends Map<string, infer V> ? V : never)> = {};
    for (const [round, value] of result.stats) statsByRound[round] = value;
    const wtBySite: Record<string, string> = {};
    for (const site of result.resolvedSites) wtBySite[site.name] = site.wtDna;
    const exactCodonCounts: Record<string, Record<string, Record<string, number>>> = {};
    const exactHaplotypeCounts: Record<string, Record<string, number>> = {};
    for (const round of job.roundNames) {
      exactCodonCounts[round] = {};
      for (const site of result.resolvedSites) exactCodonCounts[round]![site.name] = Object.fromEntries(result.dnaCounters.get(round)?.get(site.name) ?? []);
      exactHaplotypeCounts[round] = Object.fromEntries(result.haplotypeCounters.get(round) ?? []);
    }
    const hitCounts: Array<{ label: string; q05: number; q01: number; total: number }> = [];
    const baselineRound = job.roundNames[0]!;
    for (const comparisonRound of job.roundNames.slice(1)) {
      const qColumn = `FDR_q_${comparisonRound}_vs_${baselineRound}`;
      for (const site of result.resolvedSites) {
        const rows = result.analyzer.perSiteRows.filter((row) => row.Target === site.name && row.Score_Eligible === "yes");
        const qValues = rows.map((row) => Number(row[qColumn])).filter(Number.isFinite);
        hitCounts.push({
          label: `${site.name} @ ${comparisonRound} vs ${baselineRound}`,
          q05: qValues.filter((q) => q < 0.05).length,
          q01: qValues.filter((q) => q < 0.01).length,
          total: rows.length,
        });
      }
      const haplotypeRows = result.analyzer.haplotypeRows.filter((row) => row.Score_Eligible === "yes");
      if (haplotypeRows.length) {
        const qValues = haplotypeRows.map((row) => Number(row[qColumn])).filter(Number.isFinite);
        hitCounts.push({
          label: `target combination @ ${comparisonRound} vs ${baselineRound}`,
          q05: qValues.filter((q) => q < 0.05).length,
          q01: qValues.filter((q) => q < 0.01).length,
          total: haplotypeRows.length,
        });
      }
    }
    return {
      perSiteCsvBlob: result.analyzer.perSiteCsvParts.length ? new Blob(result.analyzer.perSiteCsvParts, { type: "text/csv" }) : null,
      haplotypeCsvBlob: result.analyzer.haplotypeCsvParts.length ? new Blob(result.analyzer.haplotypeCsvParts, { type: "text/csv" }) : null,
      exactCodonCsvBlob: result.exactCodonCsvParts.length ? new Blob(result.exactCodonCsvParts, { type: "text/csv" }) : null,
      exactHaplotypeCsvBlob: result.exactHaplotypeCsvParts.length ? new Blob(result.exactHaplotypeCsvParts, { type: "text/csv" }) : null,
      perSiteRowsPreview: result.analyzer.perSiteRows.slice(0, PREVIEW_ROWS),
      haplotypeRowsPreview: result.analyzer.haplotypeRows.slice(0, PREVIEW_ROWS),
      perSiteRowsForViz: result.analyzer.perSiteRows,
      exactCodonCounts,
      exactHaplotypeCounts,
      haplotypeStatistics: result.analyzer.haplotypeRows,
      statsByRound,
      fileStats: result.fileStats,
      roundNames: [...job.roundNames],
      siteNames: result.resolvedSites.map((s) => s.name),
      targets: result.resolvedSites.map((s) => ({ name: s.name, ntStart: s.ntStart, wtDna: s.wtDna, wtAa: s.wtAa })),
      wtBySite,
      libraryMedianFitness: result.analyzer.libraryMedianFitness,
      hitCounts,
    };
  },

  /**
   * Streaming parse of the analyzer's Master_Enrichment_Matrix CSV into the
   * shape the cDNA Results-page dashboard expects (top-N preview, capped
   * matrix, per-round count sample). Lives on the worker so the multi-second
   * walk over a 758 MB blob doesn't freeze the main thread. The result is
   * structured-cloneable (plain objects + numbers + strings) so postMessage
   * back to the caller is straightforward.
   */
  async parseCsv(blob: Blob, opts: StreamCsvOptions = {}): Promise<StreamCsvResult> {
    wlog(`parseCsv() entered (blob.size=${blob.size})`);
    try {
      const result = await streamParseEnrichmentBlob(blob, opts);
      wlog(
        `parseCsv() done: rows=${result.totalRows}, matrix=${result.matrix.rows.length}, ` +
          `top=${result.top.rows.length}`,
      );
      return result;
    } catch (e: unknown) {
      const err = e as Error;
      console.error(`[worker] parseCsv() threw: ${err.name}: ${err.message}`);
      throw e;
    }
  },
};

export type PipelineWorkerApi = typeof api;

try {
  Comlink.expose(api);
  wlog("Comlink.expose() returned successfully");
} catch (e: unknown) {
  console.error("[worker] Comlink.expose() threw:", e);
}

// Critical: signal the main thread that we're fully ready to accept
// messages. With module workers + top-level-await (used by the WASM
// init), messages sent before the worker finishes evaluating its module
// are silently dropped by Chrome. The main thread waits for this signal
// before posting anything; until then it just queues calls.
self.postMessage({ __ready: true, ts: Date.now() });
wlog("__ready signal sent to main thread");
