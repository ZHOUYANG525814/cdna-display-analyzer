// End-to-end pipeline orchestrator. Mirrors the GUI's
// _plugin_demultiplex_interface flow in 01_scripts/app.py: stream sources →
// demultiplex with RC retry → analyze → produce all output artifacts.
// Isomorphic: no DOM, no Drive, just IFastqSource. A Node-side parity test or
// a browser Worker both invoke this function the same way.

import type { IFastqSource } from "@cdna/types";
import {
  DemultiplexEngine,
  copyInto,
  preprocessRounds,
  rcInto,
  reverseInto,
  uppercaseInto,
  type DemultiplexSettings,
  type RoundConfigInput,
  type RoundStats,
  type UnassignedBreakdown,
} from "./demultiplex.js";
import { meanPhred, readFastqRecords } from "./fastq.js";
import { runAnalyzer, type AnalyzerOutput } from "./analyzer.js";
import { createWasmScorer } from "./wasm.js";

export interface PipelineRequest {
  sources: ReadonlyArray<IFastqSource>;
  rounds: ReadonlyArray<RoundConfigInput>;
  settings: DemultiplexSettings;
  /** Downstream enrichment pseudocount in RPM units. Default UI choice is 0.5; 1.0
   *  remains available for sensitivity and historical comparison. */
  pseudocount: number;
  onProgress?: (event: PipelineProgress) => void;
  /** Human-readable run log channel. Each event is appended verbatim to the
   *  UI terminal (Phase 6.13). Use sparingly — these cross the worker
   *  boundary individually, so flood-firing kills throughput. */
  onLog?: (event: PipelineLogEvent) => void;
  signal?: AbortSignal;
  /** Opt into the WASM scoring hot path. The TS path remains as a reference;
   *  both must produce byte-identical results (asserted by the parity test). */
  useWasm?: boolean;
  /** Per-source round binding. When provided, must be the same length as
   *  `sources`; each entry is an index into `rounds`. The engine will only
   *  score that source's reads against the bound round (no cross-round
   *  competition). Omit for the historical multiplexed/barcoded behaviour. */
  sourceRoundIndices?: ReadonlyArray<number>;
}

export interface PipelineProgress {
  sourceIndex: number;
  bytesProcessed: number;
  totalBytes: number | null;
  recordsProcessed: number;
}

export interface PipelineLogEvent {
  text: string;
  tag: "info" | "success" | "warning" | "error";
}

export interface PipelineResult {
  globalUnassigned: number;
  unassignedBreakdown: UnassignedBreakdown;
  stats: Map<string, RoundStats>;
  dnaCounters: Map<string, Map<string, number>>;
  analyzer: AnalyzerOutput | null;
  /** Machine-readable counts in the same shape Python writes to run_stats.json. */
  runStatsJson: string;
}

// Adapt a Web Streams ReadableStream to a portable AsyncIterable. Node 20+
// has Symbol.asyncIterator on ReadableStream natively, but TypeScript's lib
// types don't expose it; a manual reader works in every modern runtime.
async function* streamToAsyncIter(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onBytes: (chunkSize: number) => void,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        onBytes(value.length);
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult> {
  const t0 = performance.now();
  const log = (text: string, tag: PipelineLogEvent["tag"] = "info"): void => {
    req.onLog?.({ text, tag });
  };

  const preprocessed = preprocessRounds(req.rounds);
  const wasmScorer = req.useWasm ? createWasmScorer(preprocessed) : undefined;
  // Omit the key when no scorer — exactOptionalPropertyTypes disallows `{wasmScorer: undefined}`.
  const engine = wasmScorer
    ? new DemultiplexEngine(preprocessed, req.settings, { wasmScorer })
    : new DemultiplexEngine(preprocessed, req.settings);

  // Settings recap (Phase 6.13): give the user a paper-trail of exactly what
  // the engine ran with. Anchor previews + filter thresholds + run topology.
  log(
    `Settings · WASM=${req.useWasm ? "on" : "off"}` +
      ` · adaptive=${req.settings.adaptive}` +
      ` · filterStop=${req.settings.filterStop}` +
      ` · minMeanPhred=${req.settings.minMeanPhred.toFixed(1)}` +
      ` · minMeanPhredCds=${req.settings.minMeanPhredCds.toFixed(1)}` +
      ` · pseudocount=${req.pseudocount} RPM · FDR=BH`,
  );
  const ASCII_DEC = new TextDecoder("latin1");
  for (let i = 0; i < preprocessed.length; i++) {
    const r = preprocessed[i]!;
    const anchorStr = ASCII_DEC.decode(r.fwAnchor);
    const bcLen = r.fwBarcode.length;
    log(
      `  ${r.name}: Fw anchor=${anchorStr} (${r.fwAnchor.length} bp)` +
        ` · barcode=${bcLen} bp · CDS=[${r.cdsStart}, ${r.cdsEnd}]`,
    );
  }

  try {
  for (let srcIdx = 0; srcIdx < req.sources.length; srcIdx++) {
    const source = req.sources[srcIdx]!;
    const desc = source.describe();
    const srcSizeStr = desc.sizeBytes != null
      ? `${(desc.sizeBytes / 1024 / 1024).toFixed(1)} MB`
      : "?";
    log(`Source ${srcIdx + 1}/${req.sources.length}: opening ${desc.name} (${srcSizeStr})`);
    const stream = await source.open(req.signal);

    let bytesProcessed = 0;
    let recordsProcessed = 0;
    let lastReportedBytes = 0;
    const tSrc0 = performance.now();
    // Filter-funnel log cadence: emit a running breakdown roughly every
    // 100k records so users see counters move during long runs.
    let lastLogRecord = 0;
    const LOG_EVERY = 100_000;
    // Three scratch buffers, reused across every read on this source:
    //   - upScratch / upQualScratch: forward-strand uppercase-normalised
    //     seq and qual (B5 fix — readers can produce soft-masked lowercase
    //     bases, which the engine treats as no_anchor since it does exact
    //     byte comparison)
    //   - rcScratch / rcQualScratch: RC of upScratch, reverse of upQualScratch
    //     (qual must be reversed in lockstep so the CDS-region Q-score check
    //     in the engine looks at the right bases)
    // All grow on demand if a read is longer than any seen so far.
    let upScratch = new Uint8Array(256);
    let upQualScratch = new Uint8Array(256);
    let rcScratch = new Uint8Array(256);
    let rcQualScratch = new Uint8Array(256);

    // Fire one progress at the start of each source so the UI shows the
    // active file name immediately even before any chunks arrive.
    req.onProgress?.({
      sourceIndex: srcIdx,
      bytesProcessed: 0,
      totalBytes: desc.sizeBytes,
      recordsProcessed: 0,
    });

    // Per-chunk progress: fire whenever we've intaken >1MB since last report.
    // This makes the bar move on small files where we never reach the
    // per-record threshold, and on very fast streams (e.g. local SSD).
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

    // Per-round binding (when provided) skips cross-round competition. We
    // resolve the bound round index up-front so the hot inner loop just
    // branches on `boundRoundIdx === -1` rather than re-checking config.
    const boundRoundIdx =
      req.sourceRoundIndices && req.sourceRoundIndices.length === req.sources.length
        ? req.sourceRoundIndices[srcIdx] ?? -1
        : -1;

    try {
      for await (const rec of readFastqRecords(bytesIter)) {
        if (req.signal?.aborted) throw req.signal.reason ?? new Error("aborted");

        // Q-score filter, identical to the Python pre-demultiplex check:
        // mean Phred < threshold → drop and charge to low_quality bucket.
        if (meanPhred(rec.qual) < req.settings.minMeanPhred) {
          engine.recordLowQuality();
        } else {
          // Grow scratch buffers if this read is larger than any seen so far.
          if (rec.seq.length > upScratch.length) {
            upScratch = new Uint8Array(rec.seq.length);
            upQualScratch = new Uint8Array(rec.seq.length);
            rcScratch = new Uint8Array(rec.seq.length);
            rcQualScratch = new Uint8Array(rec.seq.length);
          }
          // B5: uppercase-normalise the read so soft-masked lowercase bases
          // don't silently fail the anchor scan. ASCII letter case differs
          // by exactly 0x20, so the test + subtract is a single branch.
          const upSeq = uppercaseInto(rec.seq, upScratch);
          // Qual line copied as-is (B2 needs it intact for the CDS Q check).
          // We can avoid the copy on the forward path, but the RC path needs
          // a reversed-qual buffer; for symmetry both branches use scratch.
          const upQual = rec.qual.length === rec.seq.length
            ? copyInto(rec.qual, upQualScratch)
            : rec.qual; // malformed FASTQ; engine will handle the mismatch

          let reason =
            boundRoundIdx >= 0
              ? engine.processReadForRound(upSeq, upQual, boundRoundIdx)
              : engine.processRead(upSeq, upQual);
          if (reason !== "assigned") {
            const rcBytes = rcInto(upSeq, rcScratch);
            const rcQual = reverseInto(upQual, rcQualScratch);
            reason =
              boundRoundIdx >= 0
                ? engine.processReadForRound(rcBytes, rcQual, boundRoundIdx)
                : engine.processRead(rcBytes, rcQual);
          }
          if (reason !== "assigned") {
            engine.recordUnassigned(reason);
          }
        }

        recordsProcessed++;
        // Per-record progress: every 4096 records. Combined with the per-MB
        // byte report above, this gives smooth UI updates whether the
        // bottleneck is I/O (Drive stream) or CPU (local file).
        if (req.onProgress && (recordsProcessed & 0xfff) === 0) {
          lastReportedBytes = bytesProcessed;
          req.onProgress({
            sourceIndex: srcIdx,
            bytesProcessed,
            totalBytes: desc.sizeBytes,
            recordsProcessed,
          });
        }
        // Filter-funnel cadence (Phase 6.13): every ~LOG_EVERY records, dump
        // a running breakdown so users see counters move during long runs.
        // Cost is negligible (one log line per ~100k reads); the running
        // totals come from cheap fields already maintained on the engine.
        if (req.onLog && recordsProcessed - lastLogRecord >= LOG_EVERY) {
          lastLogRecord = recordsProcessed;
          let passed = 0;
          let truncated = 0;
          let lenIndel = 0;
          let stop = 0;
          let lowQCds = 0;
          for (const s of engine.stats.values()) {
            passed += s.passed_qc;
            truncated += s.discard_truncated;
            lenIndel += s.discard_length_indel;
            stop += s.discard_stop_codon;
            lowQCds += s.discard_low_quality_cds;
          }
          const u = engine.unassignedBreakdown;
          log(
            `  …${(recordsProcessed / 1000).toFixed(0)}k reads · passed_qc=${passed}` +
              ` · lowQ=${u.low_quality} · noAnchor=${u.no_anchor}` +
              ` · ambig=${u.ambiguous} · bcMismatch=${u.barcode_mismatch}` +
              ` · trunc=${truncated} · indel=${lenIndel} · stop=${stop} · lowQcds=${lowQCds}`,
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
    // Per-source completion summary (Phase 6.13). Use the *running* engine
    // totals: in per-round mode this corresponds to a single round's data;
    // in multiplexed mode this reflects everything seen so far.
    const dt = ((performance.now() - tSrc0) / 1000).toFixed(1);
    if (boundRoundIdx >= 0) {
      // Per-round mode → the bound round's stats are this source's stats.
      const cfg = preprocessed[boundRoundIdx]!;
      const s = engine.stats.get(cfg.name)!;
      const counter = engine.dnaCounters.get(cfg.name)!;
      log(
        `  ${desc.name} done in ${dt}s · ${recordsProcessed} reads` +
          ` · ${s.passed_qc} passed_qc · ${counter.size} unique CDS`,
        "success",
      );
    } else {
      log(
        `  ${desc.name} done in ${dt}s · ${recordsProcessed} reads processed`,
        "success",
      );
    }
  }

  const tAnalyzer0 = performance.now();
  log("Demultiplex complete; running analyzer (DNA→AA, RPM, enrichment, Z, p, FDR)…");
  const roundNames = req.rounds.map((r) => r.name);
  const analyzer = runAnalyzer({
    roundNames,
    dnaCounters: engine.dnaCounters,
    stats: engine.stats,
    pseudocount: req.pseudocount,
  });
  const dtAnalyzer = ((performance.now() - tAnalyzer0) / 1000).toFixed(1);

  // Phase 6.13 end-of-run reporting: library-median diagnostic + FDR summary.
  if (analyzer) {
    const med = analyzer.libraryMedianEnrich;
    for (const colName of Object.keys(med)) {
      const m = med[colName]!;
      const flag = m < -1
        ? "warning"
        : m > 1
        ? "warning"
        : "info";
      const tag = flag === "warning" ? "⚠ " : "";
      log(`Library median ${colName} = ${m.toFixed(3)} ${tag}`, flag as PipelineLogEvent["tag"]);
    }
    // Count hits per enrichable round at standard FDR thresholds.
    const lastRound = roundNames[roundNames.length - 1];
    const firstRound = roundNames[0];
    if (lastRound && firstRound && lastRound !== firstRound) {
      const qCol = `FDR_q_${lastRound}_vs_${firstRound}`;
      let q05 = 0;
      let q01 = 0;
      for (const row of analyzer.rows) {
        const q = row[qCol] as number;
        if (Number.isFinite(q)) {
          if (q < 0.05) q05++;
          if (q < 0.01) q01++;
        }
      }
      log(
        `${lastRound} vs ${firstRound}: ${q05.toLocaleString()} variants with FDR < 0.05` +
          ` (${q01.toLocaleString()} with FDR < 0.01)` +
          ` out of ${analyzer.rows.length.toLocaleString()} unique peptides`,
        q05 > 0 ? "success" : "info",
      );
    }
    log(`Analyzer: ${dtAnalyzer}s · ${analyzer.rows.length.toLocaleString()} unique peptides`);
  } else {
    log("Analyzer: no peptides emitted (empty counters).", "warning");
  }

  const runStatsJson = buildRunStatsJson(
    engine,
    roundNames,
    req.pseudocount,
    analyzer?.libraryMedianEnrich,
  );
  log(`Total runtime: ${((performance.now() - t0) / 1000).toFixed(1)}s`, "success");

  return {
    globalUnassigned: engine.globalUnassigned,
    unassignedBreakdown: engine.unassignedBreakdown,
    stats: engine.stats,
    dnaCounters: engine.dnaCounters,
    analyzer,
    runStatsJson,
  };
  } finally {
    wasmScorer?.free?.();
  }
}

// Build the run_stats.json payload. Phase 6.12 bumps schema_version to 2:
// adds `library_median_enrich` (one entry per Enrich_Global_<r> column),
// which surfaces the CLR-style library-wide shift. Non-zero values flag
// sequencing-depth or PCR-yield artifacts; strongly negative values flag
// the "most variants dropped out" regime where Centered_Enrich over-corrects.
// `library_median_enrich` is omitted (key absent, not "null") when no
// enrichment columns were emitted (single-round runs), keeping the JSON
// clean for downstream readers that don't expect the key.
export function buildRunStatsJson(
  engine: DemultiplexEngine,
  roundNames: ReadonlyArray<string>,
  pseudocount: number,
  libraryMedianEnrich?: Record<string, number>,
): string {
  const rounds: Record<string, RoundStats> = {};
  for (const r of roundNames) {
    const s = engine.stats.get(r);
    if (s) rounds[r] = s;
  }
  const payload: Record<string, unknown> = {
    schema_version: 2,
    global_unassigned: engine.globalUnassigned,
    unassigned_breakdown: engine.unassignedBreakdown,
    rounds,
    statistical_model: {
      enrichment: "log2((RPM_destination + p_RPM) / (RPM_source + p_RPM))",
      pseudocount,
      pseudocount_unit: "RPM",
      variance: "Enrich2-style four-term Poisson delta method with p_RPM converted per library to p_RPM * passed_qc / 1e6 reads",
    },
  };
  if (libraryMedianEnrich && Object.keys(libraryMedianEnrich).length > 0) {
    payload.library_median_enrich = libraryMedianEnrich;
  }
  return jsonStringifySortedKeys(payload, 2);
}

// JSON.stringify with recursive key sort. Mirrors Python's
// json.dumps(..., sort_keys=True, indent=2). The replacer rebuilds each object
// in alphabetical key order; arrays pass through unchanged.
function jsonStringifySortedKeys(value: unknown, indent: number): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) sorted[k] = src[k];
      return sorted;
    }
    return v;
  }, indent);
}
