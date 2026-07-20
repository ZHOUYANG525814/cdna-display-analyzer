// End-to-end Nanopore SSM pipeline orchestrator. Streams each source as bytes
// → FASTQ records, runs each read through the NanoporeEngine with RC retry on
// no-site-extracted, and produces the per-site + haplotype counters that the
// analyzer (Phase 6.4) will consume to emit CSVs.
//
// Modes:
//   - multiplexed: every source feeds all rounds; engine binds each read to a
//     round via barcode match on the 5' head.
//   - per-round: `sourceRoundIndices` binds source[i] → round[k]. No barcode
//     matching needed.
//
// Iso-morphic: no DOM, no Drive. Node-side tests and the browser Worker both
// invoke this function the same way (same shape as runPipeline for cDNA).

import type { IFastqSource } from "@cdna/types";
import {
  copyInto,
  rcInto,
  reverseInto,
  uppercaseInto,
} from "./demultiplex.js";
import {
  isValidFastqRecord,
  readFastqRecordsResilient,
} from "./fastq.js";
import {
  DEFAULT_SETTINGS,
  NanoporeEngine,
  resolveWtRois,
  type NanoporeGlobalBreakdown,
  type NanoporeRoundStats,
  type NanoporeSettings,
  type NanoporeSiteConfig,
  type SiteScorerLike,
} from "./nanopore.js";
import { runNanoporeAnalyzer, type NanoporeAnalyzerOutput } from "./nanopore-analyzer.js";
import { createDualAnchorScorer } from "./wasm.js";

const ENC = new TextEncoder();

/** User-facing site input — anchors as plain ACGT strings. The orchestrator
 *  encodes them and resolves the WT ROI from the reference. */
export interface NanoporeSiteInput {
  name: string;
  fwAnchor: string;
  rvAnchor: string;
}

export interface NanoporeRoundInput {
  name: string;
  /** Multiplexed mode only. Per-round mode: omit. */
  barcode?: string;
}

export interface NanoporePipelineRequest {
  sources: ReadonlyArray<IFastqSource>;
  /** Reference amplicon spanning every site (used to derive WT ROI per site). */
  reference: string;
  sites: ReadonlyArray<NanoporeSiteInput>;
  rounds: ReadonlyArray<NanoporeRoundInput>;
  settings?: Partial<NanoporeSettings>;
  /** Per-round binding for "per-round" mode. Length === sources.length. */
  sourceRoundIndices?: ReadonlyArray<number>;
  /** Opt into the WASM DualAnchorScorer. Falls back to the pure-TS scorer
   *  when false / omitted. Both paths are byte-identical (parity-tested). */
  useWasm?: boolean;
  onProgress?: (event: NanoporePipelineProgress) => void;
  /** Run-log channel (Phase 6.13). Receives settings recap, periodic filter-
   *  funnel snapshots (~100k records), per-source done summary, library-
   *  median diagnostic, FDR hit-count summary. */
  onLog?: (event: NanoporeLogEvent) => void;
  signal?: AbortSignal;
}

export interface NanoporeLogEvent {
  text: string;
  tag: "info" | "success" | "warning" | "error";
}

export interface NanoporePipelineProgress {
  sourceIndex: number;
  bytesProcessed: number;
  totalBytes: number | null;
  recordsProcessed: number;
}

export interface NanoporePipelineResult {
  /** Round name → site → roi_dna → count. */
  dnaCounters: Map<string, Map<string, Map<string, number>>>;
  /** Round name → joined_dna → count. Empty when haplotype output is disabled. */
  haplotypeCounters: Map<string, Map<string, number>>;
  /** Per-round stats including per-site sub-counters. */
  stats: Map<string, NanoporeRoundStats>;
  globalBreakdown: NanoporeGlobalBreakdown;
  /** Resolved per-site config (anchors, expected ROI length, WT DNA). */
  resolvedSites: NanoporeSiteConfig[];
  /** Round-name list in input order — analyzer iterates this for CSV column order. */
  roundNames: string[];
  /** Site-name list in input order. */
  siteNames: string[];
  /** Analyzer output: per-site rows + (when ≥2 sites + reportHaplotype) haplotype
   *  rows, plus their CSV strings. Computed once at the end of the pipeline so
   *  the worker→main thread payload includes the final tables. */
  analyzer: NanoporeAnalyzerOutput;
}

/** Stream-byte-callback wrapper: yields Uint8Array chunks and calls `onChunk`
 *  with each chunk's byte length so the orchestrator can update progress. */
async function* streamToAsyncIter(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onChunk: (n: number) => void,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        onChunk(value.byteLength);
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runNanoporePipeline(
  req: NanoporePipelineRequest,
): Promise<NanoporePipelineResult> {
  if (req.sources.length === 0) {
    throw new Error("At least one FASTQ source is required.");
  }
  if (req.sites.length === 0) {
    throw new Error("At least one SSM site is required.");
  }
  if (req.rounds.length === 0) {
    throw new Error("At least one selection round is required.");
  }
  if (new Set(req.sites.map((site) => site.name)).size !== req.sites.length) {
    throw new Error("SSM site names must be unique.");
  }
  if (new Set(req.rounds.map((round) => round.name)).size !== req.rounds.length) {
    throw new Error("Selection round names must be unique.");
  }
  if (req.sourceRoundIndices) {
    if (req.sourceRoundIndices.length !== req.sources.length) {
      throw new Error("Every per-round FASTQ source must have exactly one round binding.");
    }
    for (const [sourceIndex, roundIndex] of req.sourceRoundIndices.entries()) {
      if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= req.rounds.length) {
        throw new Error(`Source ${sourceIndex} has an invalid round binding.`);
      }
    }
  } else {
    const barcodes = req.rounds.map((round) => round.barcode ?? "");
    if (barcodes.some((barcode) => barcode.length === 0)) {
      throw new Error("Every multiplexed round must define a barcode.");
    }
    if (new Set(barcodes).size !== barcodes.length) {
      throw new Error("Multiplexed rounds must use distinct barcodes.");
    }
  }
  const t0 = performance.now();
  const log = (text: string, tag: NanoporeLogEvent["tag"] = "info"): void => {
    req.onLog?.({ text, tag });
  };

  const settings: NanoporeSettings = { ...DEFAULT_SETTINGS, ...(req.settings ?? {}) };

  // Resolve WT ROI per site from the reference.
  const { wtByName, expectedRoiLen } = resolveWtRois(req.reference, req.sites);

  const resolvedSites: NanoporeSiteConfig[] = req.sites.map((s) => ({
    name: s.name,
    fwAnchor: ENC.encode(s.fwAnchor.toUpperCase()),
    rvAnchor: ENC.encode(s.rvAnchor.toUpperCase()),
    expectedRoiLen: expectedRoiLen.get(s.name)!,
    wtDna: wtByName.get(s.name)!,
  }));

  const rounds = req.rounds.map((r) =>
    r.barcode
      ? { name: r.name, barcode: ENC.encode(r.barcode.toUpperCase()) }
      : { name: r.name },
  );

  // Settings + per-site WT recap (Phase 6.13).
  log(
    `Settings · WASM=${req.useWasm ? "on" : "off"}` +
      ` · maxAnchorSubs=${settings.maxAnchorSubs}` +
      ` · maxAnchorIndels=${settings.maxAnchorIndels}` +
      ` · minMeanPhredRead=${settings.minMeanPhredRead}` +
      ` · minMeanPhredRoi=${settings.minMeanPhredRoi}` +
      ` · filterStop=${settings.filterStop}` +
      ` · pseudocount=${settings.pseudocount} RPM · FDR=BH`,
  );
  for (const s of resolvedSites) {
    log(
      `  Site ${s.name}: ROI=${s.expectedRoiLen} bp` +
        ` · WT=${s.wtDna}` +
        ` · Fw=${s.fwAnchor.length} bp · Rv=${s.rvAnchor.length} bp`,
    );
  }

  // Construct scorer — WASM if requested, TS fallback otherwise. The engine
  // builds its own TS scorer when none is supplied; only override when WASM.
  let scorer: SiteScorerLike | undefined;
  if (req.useWasm) {
    scorer = createDualAnchorScorer(
      resolvedSites.map((s) => ({ fwAnchor: s.fwAnchor, rvAnchor: s.rvAnchor })),
      settings.maxAnchorSubs,
      settings.maxAnchorIndels,
    );
  }

  const engine = new NanoporeEngine(resolvedSites, rounds, settings, scorer);

  try {
    for (let srcIdx = 0; srcIdx < req.sources.length; srcIdx++) {
      const source = req.sources[srcIdx]!;
      const desc = source.describe();
      const sizeStr = desc.sizeBytes != null
        ? `${(desc.sizeBytes / 1024 / 1024).toFixed(1)} MB`
        : "?";
      log(`Source ${srcIdx + 1}/${req.sources.length}: opening ${desc.name} (${sizeStr})`);
      const stream = await source.open(req.signal);
      const tSrc0 = performance.now();

      let bytesProcessed = 0;
      let recordsProcessed = 0;
      let lastReportedBytes = 0;
      let lastLogRecord = 0;
      const malformedAtSourceStart = engine.globalBreakdown.malformed_fastq;
      const LOG_EVERY = 100_000;
      let upScratch = new Uint8Array(256);
      let upQualScratch = new Uint8Array(256);
      let rcScratch = new Uint8Array(256);
      let rcQualScratch = new Uint8Array(256);

      req.onProgress?.({
        sourceIndex: srcIdx,
        bytesProcessed: 0,
        totalBytes: desc.sizeBytes,
        recordsProcessed: 0,
      });

      const bytesIter = streamToAsyncIter(stream, req.signal, (n) => {
        bytesProcessed += n;
        if (req.onProgress && bytesProcessed - lastReportedBytes >= 1024 * 1024) {
          lastReportedBytes = bytesProcessed;
          req.onProgress({
            sourceIndex: srcIdx,
            bytesProcessed,
            totalBytes: desc.sizeBytes,
            recordsProcessed,
          });
        }
      });

      const boundRoundIdx = req.sourceRoundIndices
        ? req.sourceRoundIndices[srcIdx]!
        : -1;

      try {
        for await (const rec of readFastqRecordsResilient(bytesIter)) {
          if (req.signal?.aborted) throw req.signal.reason ?? new Error("aborted");

          if (!isValidFastqRecord(rec)) {
            engine.recordMalformedFastq();
          } else {
            if (rec.seq.length > upScratch.length) {
              upScratch = new Uint8Array(rec.seq.length);
              upQualScratch = new Uint8Array(rec.seq.length);
              rcScratch = new Uint8Array(rec.seq.length);
              rcQualScratch = new Uint8Array(rec.seq.length);
            }

            const upSeq = uppercaseInto(rec.seq, upScratch);
            const upQual = copyInto(rec.qual, upQualScratch);

            let outcome =
              boundRoundIdx >= 0
                ? engine.processReadForRound(upSeq, upQual, boundRoundIdx)
                : engine.processRead(upSeq, upQual);
            if (outcome !== "assigned" && outcome !== "low_quality_read") {
              // Low quality is final — RC won't fix bad chemistry. Anything
              // else (no_anchor / barcode_mismatch) might just be antisense.
              const rcBytes = rcInto(upSeq, rcScratch);
              const rcQual = reverseInto(upQual, rcQualScratch);
              outcome =
                boundRoundIdx >= 0
                  ? engine.processReadForRound(rcBytes, rcQual, boundRoundIdx)
                  : engine.processRead(rcBytes, rcQual);
            }
          }

          recordsProcessed++;
          if (req.onProgress && (recordsProcessed & 0xfff) === 0) {
            lastReportedBytes = bytesProcessed;
            req.onProgress({
              sourceIndex: srcIdx,
              bytesProcessed,
              totalBytes: desc.sizeBytes,
              recordsProcessed,
            });
          }
          // Filter-funnel cadence (Phase 6.13).
          if (req.onLog && recordsProcessed - lastLogRecord >= LOG_EVERY) {
            lastLogRecord = recordsProcessed;
            const gb = engine.globalBreakdown;
            // Aggregate per-site passed_qc across all rounds.
            let passed = 0;
            let anchorFound = 0;
            let roiIndel = 0;
            let lowQRoi = 0;
            for (const stats of engine.stats.values()) {
              for (const ss of Object.values(stats.sites)) {
                passed += ss.passed_qc;
                anchorFound += ss.anchor_found;
                roiIndel += ss.discard_roi_indel;
                lowQRoi += ss.discard_low_q_roi;
              }
            }
            log(
              `  …${(recordsProcessed / 1000).toFixed(0)}k reads · passed=${passed}` +
                ` · malformed=${gb.malformed_fastq}` +
                ` · lowQ=${gb.low_quality_read} · bcMiss=${gb.barcode_mismatch}` +
                ` · noSite=${gb.no_site_extracted}` +
                ` · anchorOk=${anchorFound} · roiIndel=${roiIndel} · lowQroi=${lowQRoi}`,
            );
          }
        }
      } finally {
        req.onProgress?.({
          sourceIndex: srcIdx,
          bytesProcessed,
          totalBytes: desc.sizeBytes,
          recordsProcessed,
        });
      }

      // Per-source completion summary (Phase 6.13). Reuses the boundRoundIdx
      // computed before the read loop above.
      const dt = ((performance.now() - tSrc0) / 1000).toFixed(1);
      const sourceMalformed =
        engine.globalBreakdown.malformed_fastq - malformedAtSourceStart;
      const sourceQcText =
        ` · malformed=${sourceMalformed}` +
        (recordsProcessed === 0 ? " · EMPTY FASTQ STREAM" : "");
      const sourceTag =
        sourceMalformed > 0 || recordsProcessed === 0 ? "warning" : "success";
      if (boundRoundIdx >= 0) {
        const roundName = rounds[boundRoundIdx]?.name ?? "?";
        const stats = engine.stats.get(roundName);
        if (stats) {
          const sitePassed = Object.values(stats.sites).map((s) => s.passed_qc);
          const totalPassed = sitePassed.reduce((a, b) => a + b, 0);
          log(
            `  ${desc.name} done in ${dt}s · ${recordsProcessed} reads` +
              ` · ${totalPassed} site-passes across ${sitePassed.length} site(s)` +
              sourceQcText,
            sourceTag,
          );
        }
      } else {
        log(
          `  ${desc.name} done in ${dt}s · ${recordsProcessed} reads processed` +
            sourceQcText,
          sourceTag,
        );
      }
    }
  } finally {
    // Free the WASM scorer if we constructed one.
    const maybeFree = (scorer as unknown as { free?: () => void } | undefined)?.free;
    if (typeof maybeFree === "function") {
      maybeFree.call(scorer);
    }
  }

  const tAnalyzer0 = performance.now();
  log("Demultiplex complete; running analyzer (DNA→AA, RPM, fitness, Z, p, FDR)…");
  const roundNames = rounds.map((r) => r.name);
  const siteNames = resolvedSites.map((s) => s.name);
  const analyzer = runNanoporeAnalyzer({
    roundNames,
    siteNames,
    dnaCounters: engine.dnaCounters,
    haplotypeCounters: engine.haplotypeCounters,
    stats: engine.stats,
    sites: resolvedSites.map((s) => ({ name: s.name, wtDna: s.wtDna })),
    emitHaplotype: settings.reportHaplotype,
    pseudocount: settings.pseudocount,
  });
  const dtAnalyzer = ((performance.now() - tAnalyzer0) / 1000).toFixed(1);

  // Library-median diagnostic + FDR summary (Phase 6.13).
  const med = analyzer.libraryMedianFitness;
  for (const key of Object.keys(med)) {
    const m = med[key]!;
    const tag = m < -1 || m > 1 ? "warning" : "info";
    const flag = tag === "warning" ? "⚠ " : "";
    log(`Library median Fitness_vs_WT ${key} = ${m.toFixed(3)} ${flag}`, tag as NanoporeLogEvent["tag"]);
  }

  // Hit counts per (site, last round) at standard FDR thresholds.
  const lastRound = roundNames[roundNames.length - 1];
  const firstRound = roundNames[0];
  if (lastRound && firstRound && lastRound !== firstRound) {
    const qCol = `FDR_q_${lastRound}`;
    const counts = new Map<string, { total: number; q05: number; q01: number }>();
    for (const row of analyzer.perSiteRows) {
      const site = String(row.Site);
      const c = counts.get(site) ?? { total: 0, q05: 0, q01: 0 };
      c.total++;
      const q = row[qCol] as number;
      if (Number.isFinite(q)) {
        if (q < 0.05) c.q05++;
        if (q < 0.01) c.q01++;
      }
      counts.set(site, c);
    }
    for (const [site, c] of counts) {
      log(
        `Site ${site} @ ${lastRound}: ${c.q05.toLocaleString()} variants with FDR < 0.05` +
          ` (${c.q01.toLocaleString()} with FDR < 0.01)` +
          ` out of ${c.total.toLocaleString()} unique AAs`,
        c.q05 > 0 ? "success" : "info",
      );
    }
  }
  log(`Analyzer: ${dtAnalyzer}s · ${analyzer.perSiteRows.length.toLocaleString()} per-site rows`);
  const zeroCoverage = roundNames.flatMap((round) => {
    const roundStats = engine.stats.get(round);
    const siteIssues = siteNames.flatMap((site) =>
      (roundStats?.sites[site]?.passed_qc ?? 0) === 0
        ? [`${round}/${site}`]
        : [],
    );
    if (
      siteNames.length >= 2 &&
      settings.reportHaplotype &&
      (roundStats?.haplotype_passed_qc ?? 0) === 0
    ) {
      siteIssues.push(`${round}/linked combinations`);
    }
    return siteIssues;
  });
  if (zeroCoverage.length > 0) {
    log(`Invalid effective coverage · ${zeroCoverage.join(", ")}`, "error");
  }
  log(
    `Total runtime: ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    zeroCoverage.length > 0 ? "error" : "success",
  );

  return {
    dnaCounters: engine.dnaCounters,
    haplotypeCounters: engine.haplotypeCounters,
    stats: engine.stats,
    globalBreakdown: engine.globalBreakdown,
    resolvedSites,
    roundNames,
    siteNames,
    analyzer,
  };
}
