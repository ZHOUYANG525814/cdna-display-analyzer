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
  onProgress?: (event: PipelineProgress) => void;
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
  const preprocessed = preprocessRounds(req.rounds);
  const wasmScorer = req.useWasm ? createWasmScorer(preprocessed) : undefined;
  // Omit the key when no scorer — exactOptionalPropertyTypes disallows `{wasmScorer: undefined}`.
  const engine = wasmScorer
    ? new DemultiplexEngine(preprocessed, req.settings, { wasmScorer })
    : new DemultiplexEngine(preprocessed, req.settings);

  try {
  for (let srcIdx = 0; srcIdx < req.sources.length; srcIdx++) {
    const source = req.sources[srcIdx]!;
    const desc = source.describe();
    // Surface entry into each source so a stuck source.open() (e.g. a
    // Drive fetch that never resolves) is obvious in the log.
    console.log(`[pipeline] source[${srcIdx}] opening: ${desc.name} (${desc.sizeBytes ?? "?"} bytes)`);
    const stream = await source.open(req.signal);
    console.log(`[pipeline] source[${srcIdx}] stream opened, beginning read loop`);

    let bytesProcessed = 0;
    let recordsProcessed = 0;
    let lastReportedBytes = 0;
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
      }
    } finally {
      req.onProgress?.({
        sourceIndex: srcIdx,
        bytesProcessed,
        totalBytes: desc.sizeBytes,
        recordsProcessed,
      });
    }
  }

  const roundNames = req.rounds.map((r) => r.name);
  const analyzer = runAnalyzer({
    roundNames,
    dnaCounters: engine.dnaCounters,
    stats: engine.stats,
  });

  const runStatsJson = buildRunStatsJson(engine, roundNames);

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

// Build the run_stats.json payload with byte-identical formatting to the
// Python emitter in 01_scripts/app.py: indent=2, sort_keys=True (recursive),
// no trailing newline. The TS port writes a JSON whose bytes match exactly.
export function buildRunStatsJson(
  engine: DemultiplexEngine,
  roundNames: ReadonlyArray<string>,
): string {
  const rounds: Record<string, RoundStats> = {};
  for (const r of roundNames) {
    const s = engine.stats.get(r);
    if (s) rounds[r] = s;
  }
  const payload = {
    schema_version: 1,
    global_unassigned: engine.globalUnassigned,
    unassigned_breakdown: engine.unassignedBreakdown,
    rounds,
  };
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
