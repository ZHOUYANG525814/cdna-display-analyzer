// TS-vs-WASM throughput bench on a 50k-read sample. Gated behind RUN_BENCH=1
// so the default `pnpm test` stays under a second. Generate the fixture once:
//   head -200000 ../../../00_material/HN01_S31_1_230210_takai.fastq > /tmp/sample_50k.fastq
// then run with:
//   RUN_BENCH=1 BENCH_FASTQ=/tmp/sample_50k.fastq pnpm --filter @cdna/core test

import { describe, it } from "vitest";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";
import { runPipeline } from "../src/pipeline.js";
import {
  DemultiplexEngine,
  preprocessRounds,
  reverseComplementBytesToBytes,
  type DemultiplexSettings,
  type RoundConfigInput,
} from "../src/demultiplex.js";
import { createWasmScorer } from "../src/wasm.js";
import { readFastqRecords, meanPhred } from "../src/fastq.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
const FASTQ = process.env.BENCH_FASTQ ?? "/tmp/sample_50k.fastq";
const ENABLED = process.env.RUN_BENCH === "1";

function fileSource(filePath: string): IFastqSource {
  return {
    describe(): FastqSourceDescriptor {
      return { id: filePath, name: path.basename(filePath), sizeBytes: null };
    },
    async open(): Promise<ReadableStream<Uint8Array>> {
      return Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    },
  };
}

interface PrimersConfig {
  rounds: Record<string, { fw_primer: string; rv_primer: string; cds_start: number; cds_end: number }>;
  settings?: { adaptive?: boolean; filter_stop?: boolean };
}

async function loadConfig(): Promise<{ rounds: RoundConfigInput[]; settings: DemultiplexSettings }> {
  const text = await readFile(path.join(FIX, "primers.yaml"), "utf8");
  const cfg = yaml.parse(text) as PrimersConfig;
  const rounds = Object.entries(cfg.rounds).map(([name, r]) => ({
    name,
    fwPrimer: r.fw_primer,
    rvPrimer: r.rv_primer,
    cdsStart: r.cds_start,
    cdsEnd: r.cds_end,
  }));
  const settings: DemultiplexSettings = {
    adaptive: cfg.settings?.adaptive ?? true,
    filterStop: cfg.settings?.filter_stop ?? true,
    minMeanPhred: 20.0,
    minMeanPhredCds: 20.0,
  };
  return { rounds, settings };
}

async function runOnce(useWasm: boolean): Promise<{ ms: number; passed: number }> {
  const { rounds, settings } = await loadConfig();
  const t0 = performance.now();
  const result = await runPipeline({
    sources: [fileSource(FASTQ)],
    rounds,
    settings,
    pseudocount: 0.5,
    useWasm,
  });
  const ms = performance.now() - t0;
  let passed = 0;
  for (const s of result.stats.values()) passed += s.passed_qc;
  return { ms, passed };
}

describe.skipIf(!ENABLED)("TS vs WASM throughput (set RUN_BENCH=1)", () => {
  it("compares end-to-end pipeline time", async () => {
    if (!existsSync(FASTQ)) {
      throw new Error(`BENCH_FASTQ not found at ${FASTQ}; see header comment for generation`);
    }

    // Warmup each path once (JIT, file cache).
    await runOnce(false);
    await runOnce(true);

    const trials = 3;
    const tsTimes: number[] = [];
    const wasmTimes: number[] = [];
    let tsPassed = 0;
    let wasmPassed = 0;
    for (let i = 0; i < trials; i++) {
      const ts = await runOnce(false);
      tsTimes.push(ts.ms);
      tsPassed = ts.passed;
      const wa = await runOnce(true);
      wasmTimes.push(wa.ms);
      wasmPassed = wa.passed;
    }
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const tsMed = median(tsTimes);
    const wasmMed = median(wasmTimes);

    console.log(`\nEnd-to-end bench on ${FASTQ}  (median of ${trials} trials)`);
    console.log(`  TS   : ${tsMed.toFixed(1)} ms   passed_qc=${tsPassed}`);
    console.log(`  WASM : ${wasmMed.toFixed(1)} ms   passed_qc=${wasmPassed}`);
    console.log(`  speedup: ${(tsMed / wasmMed).toFixed(2)}×`);
    if (tsPassed !== wasmPassed) {
      throw new Error("passed_qc differs between paths — parity broken!");
    }
  }, 600_000);

  // Isolates the scoring inner loop (no file I/O, no line splitter, no
  // Map/Counter updates). If the speedup here is large but end-to-end is
  // small, the conclusion is that scoring isn't the bottleneck.
  it("microbenches only the processRead inner loop", async () => {
    if (!existsSync(FASTQ)) return;
    const { rounds, settings } = await loadConfig();

    // Load all reads (post-Q-filter) into memory once.
    const reads: Array<{ seq: Uint8Array; qual: Uint8Array }> = [];
    const source = fileSource(FASTQ);
    const stream = await source.open();
    for await (const rec of readFastqRecords(
      (async function* () {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
    )) {
      if (meanPhred(rec.qual) >= settings.minMeanPhred) {
        // Copy out so the underlying chunk can be released.
        reads.push({ seq: rec.seq.slice(), qual: rec.qual.slice() });
      }
    }
    console.log(`\n[micro] cached ${reads.length} post-Q reads`);

    const preprocessed = preprocessRounds(rounds);
    const runScoringPass = (useWasm: boolean): number => {
      const wasmScorer = useWasm ? createWasmScorer(preprocessed) : undefined;
      const engine = wasmScorer
        ? new DemultiplexEngine(preprocessed, settings, { wasmScorer })
        : new DemultiplexEngine(preprocessed, settings);
      const t0 = performance.now();
      for (const { seq, qual } of reads) {
        let reason = engine.processRead(seq, qual);
        if (reason !== "assigned") {
          const rc = reverseComplementBytesToBytes(seq);
          const rcQual = qual.slice().reverse();
          reason = engine.processRead(rc, rcQual);
        }
        if (reason !== "assigned") engine.recordUnassigned(reason);
      }
      const ms = performance.now() - t0;
      wasmScorer?.free?.();
      return ms;
    };

    // Warmup.
    runScoringPass(false);
    runScoringPass(true);
    const trials = 5;
    const ts: number[] = [];
    const wa: number[] = [];
    for (let i = 0; i < trials; i++) {
      ts.push(runScoringPass(false));
      wa.push(runScoringPass(true));
    }
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const tsMed = median(ts);
    const waMed = median(wa);
    console.log(`[micro] TS  : ${tsMed.toFixed(1)} ms (${(reads.length / tsMed).toFixed(0)} k reads/s)`);
    console.log(`[micro] WASM: ${waMed.toFixed(1)} ms (${(reads.length / waMed).toFixed(0)} k reads/s)`);
    console.log(`[micro] speedup: ${(tsMed / waMed).toFixed(2)}×`);
  }, 600_000);
});
