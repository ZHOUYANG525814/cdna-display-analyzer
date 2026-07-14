#!/usr/bin/env node
import {
  alignTargetedReference,
  buildProtectedMask,
  doradoMeanQ,
  evaluateTargetedQc,
  parseDoradoHeaderQ,
  readFastqRecords,
  resolveDoradoReadQ,
  reverseComplementBytes,
  runTargetedNanoporePipeline,
} from "@cdna/core";
import { stat } from "node:fs/promises";
import { loadTargetedConfig } from "./config.js";
import { fileChunks, quantile } from "./io.js";

class FileFastqSource {
  constructor(private readonly path: string, private readonly size: number) {}
  describe() { return { id: this.path, name: this.path, sizeBytes: this.size }; }
  async open(): Promise<ReadableStream<Uint8Array>> {
    const iterator = fileChunks(this.path)[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      async cancel() { await iterator.return?.(); },
    });
  }
}

const args = process.argv.slice(2);
const command = args[0];
const configArg = option("--config");
const limit = Number(option("--limit") ?? "500");

if (!command || !configArg || !Number.isInteger(limit) || limit < 1) usage();

try {
  const config = await loadTargetedConfig(configArg);
  if (command === "validate") {
    console.log(JSON.stringify({
      status: "valid",
      config: config.configPath,
      referenceLength: config.reference.length,
      sites: config.sites.map(({ name, ntStart, length, wtDna, wtAa, design }) => ({ name, ntStart, length, wtDna, wtAa, design })),
      rounds: config.rounds,
      qc: config.qc,
    }, null, 2));
  } else if (command === "q-audit") {
    await qAudit(config, limit);
  } else if (command === "benchmark") {
    await benchmark(config, limit);
  } else if (command === "analyze") {
    await analyze(config, limit);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error("Usage: targeted-nanopore <validate|q-audit|benchmark|analyze> --config design.yaml [--limit 500]");
  process.exit(2);
}

async function analyze(config: Awaited<ReturnType<typeof loadTargetedConfig>>, maxReads: number): Promise<void> {
  const sources = await Promise.all(config.rounds.map(async (round) => new FileFastqSource(round.fastq, (await stat(round.fastq)).size)));
  const result = await runTargetedNanoporePipeline({
    sources,
    sourceRoundIndices: config.rounds.map((_, i) => i),
    roundNames: config.rounds.map((_, i) => `Round ${i}`),
    reference: config.reference,
    sites: config.sites.map((s) => ({ name: s.name, ntStart: s.ntStart, length: s.length, design: "NNK" as const })),
    settings: { ...config.qc, minTargetBaseQ: 15, minInputCountToScore: 10, reportHaplotypes: true },
    maxReadsPerSource: maxReads,
  });
  console.log(JSON.stringify({
    readsPerSourceLimit: maxReads,
    stats: Object.fromEntries(result.stats),
    files: result.fileStats,
    topRows: result.analyzer.perSiteRows.slice(0, 30),
    libraryMedianFitness: result.analyzer.libraryMedianFitness,
  }, null, 2));
}

async function qAudit(config: Awaited<ReturnType<typeof loadTargetedConfig>>, maxReads: number): Promise<void> {
  for (const round of config.rounds) {
    const header: number[] = [];
    const recalculated: number[] = [];
    let missingHeader = 0;
    let count = 0;
    for await (const record of readFastqRecords(fileChunks(round.fastq))) {
      if (count >= maxReads) break;
      count++;
      const headerQ = parseDoradoHeaderQ(record.header);
      if (headerQ == null) missingHeader++;
      else header.push(headerQ);
      recalculated.push(doradoMeanQ(record.qual));
    }
    header.sort((a, b) => a - b);
    recalculated.sort((a, b) => a - b);
    console.log(JSON.stringify({
      round: round.name,
      reads: count,
      missingHeaderQ: missingHeader,
      headerQ: distribution(header),
      recalculatedQ: distribution(recalculated),
    }));
  }
}

async function benchmark(config: Awaited<ReturnType<typeof loadTargetedConfig>>, maxReads: number): Promise<void> {
  const reference = new TextEncoder().encode(config.reference);
  const protectedMask = buildProtectedMask(reference.length, config.sites);
  for (const round of config.rounds) {
    let reads = 0;
    let readQPassed = 0;
    let aligned = 0;
    let passedQc = 0;
    let forward = 0;
    let reverse = 0;
    let failures = 0;
    const qcFailures: Record<string, number> = {};
    const primaryDropReasons: Record<string, number> = {};
    let identity = 0;
    let coverage = 0;
    const protectedIdentities: number[] = [];
    const protectedIndelBases: number[] = [];
    const started = performance.now();
    for await (const record of readFastqRecords(fileChunks(round.fastq))) {
      if (reads >= maxReads) break;
      reads++;
      try {
        const readQ = resolveDoradoReadQ(record.header, record.qual).effective;
        if (readQ < config.qc.minReadQ) {
          qcFailures.low_read_q = (qcFailures.low_read_q ?? 0) + 1;
          primaryDropReasons.low_read_q = (primaryDropReasons.low_read_q ?? 0) + 1;
          continue;
        }
        readQPassed++;
        const sense = tryAlign(reference, record.seq);
        const antisense = sense
          && sense.referenceCoverage >= config.qc.minReferenceCoverage
          && sense.identity >= config.qc.minAlignmentIdentity
          ? null
          : tryAlign(reference, new TextEncoder().encode(reverseComplementBytes(record.seq)));
        const best = !antisense || (sense && sense.score >= antisense.score) ? sense : antisense;
        if (!best) {
          failures++;
          primaryDropReasons.alignment_failed = (primaryDropReasons.alignment_failed ?? 0) + 1;
          continue;
        }
        aligned++;
        if (best === antisense) reverse++; else forward++;
        identity += best.identity;
        coverage += best.referenceCoverage;
        const qc = evaluateTargetedQc(best, protectedMask, readQ, config.qc);
        protectedIdentities.push(qc.protectedIdentity);
        protectedIndelBases.push(qc.protectedInsertedBases + qc.protectedDeletedBases);
        if (qc.passed) passedQc++;
        else {
          const primary = qc.failures[0]!;
          primaryDropReasons[primary] = (primaryDropReasons[primary] ?? 0) + 1;
          for (const failure of qc.failures) qcFailures[failure] = (qcFailures[failure] ?? 0) + 1;
        }
      } catch {
        failures++;
        primaryDropReasons.processing_error = (primaryDropReasons.processing_error ?? 0) + 1;
      }
    }
    const seconds = (performance.now() - started) / 1000;
    protectedIdentities.sort((a, b) => a - b);
    protectedIndelBases.sort((a, b) => a - b);
    console.log(JSON.stringify({
      round: round.name,
      reads,
      readQPassed,
      aligned,
      passedQc,
      failures,
      qcFailures,
      primaryDropReasons,
      orientation: { forward, reverse },
      readsPerSecond: reads / seconds,
      meanIdentity: aligned ? identity / aligned : null,
      meanReferenceCoverage: aligned ? coverage / aligned : null,
      protectedIdentity: distribution(protectedIdentities),
      protectedIndelBases: distribution(protectedIndelBases),
      elapsedSeconds: seconds,
      heapMb: process.memoryUsage().heapUsed / 1024 / 1024,
    }));
  }
}

function tryAlign(reference: Uint8Array, read: Uint8Array) {
  try {
    return alignTargetedReference(reference, read);
  } catch {
    return null;
  }
}

function distribution(sorted: readonly number[]) {
  return {
    n: sorted.length,
    min: quantile(sorted, 0),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: quantile(sorted, 1),
  };
}
