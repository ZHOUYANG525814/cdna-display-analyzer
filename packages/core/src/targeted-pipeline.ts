import type { IFastqSource } from "@cdna/types";
import { rcInto, reverseInto, uppercaseInto } from "./demultiplex.js";
import { isValidFastqRecord, readFastqRecordsResilient } from "./fastq.js";
import { runNanoporeAnalyzer, type NanoporeAnalyzerOutput } from "./nanopore-analyzer.js";
import { serializeCsv, type AnalyzerRow, type ColumnSpec, type RowValue } from "./analyzer.js";
import { translateDna } from "./dna.js";
import type { NanoporeRoundStats, NanoporeSiteStats } from "./nanopore.js";
import {
  alignTargetedReferenceWithEstimate,
  createTargetedReferenceSeedIndex,
  estimateReferenceOffsetIndexed,
  type TargetedAlignment,
} from "./targeted-align.js";
import {
  buildProtectedMask,
  buildTargetHaplotype,
  buildTargetedReadProjection,
  callTargetSites,
  createTargetedProjectionWorkspace,
  type TargetedReadProjection,
} from "./targeted-caller.js";
import { evaluateTargetedQc, type TargetedQcFailure, type TargetedQcSettings } from "./targeted-qc.js";
import { resolveDoradoReadQ } from "./targeted-qscore.js";
import { resolveTargetSites, type ResolvedTargetSite, type TargetSiteInput } from "./targeted-types.js";
import { TargetedReadIdSet } from "./targeted-read-ids.js";
import { createWasmTargetedAligner } from "./targeted-wasm.js";
import type { WasmTargetedAlignerLike } from "./targeted-wasm.js";

const ENC = new TextEncoder();
const DEC = new TextDecoder("latin1");

export interface TargetedPipelineSettings extends TargetedQcSettings {
  minTargetBaseQ: number;
  minInputCountToScore: number;
  pseudocount: number;
  reportHaplotypes: boolean;
  rescueFlankBases?: number;
}
export interface TargetedPipelineRequest {
  sources: ReadonlyArray<IFastqSource>;
  sourceRoundIndices: ReadonlyArray<number>;
  roundNames: ReadonlyArray<string>;
  reference: string;
  sites: ReadonlyArray<TargetSiteInput>;
  settings: TargetedPipelineSettings;
  /** Test/diagnostic cap. Production Web runs omit this and stream to EOF. */
  maxReadsPerSource?: number;
  /** Candidate full-length Rust/WASM path. Keep false/omitted until the
   * frozen parity, speed and RSS gates have passed on the real development set. */
  useWasmAlignment?: boolean;
  onProgress?: (event: TargetedPipelineProgress) => void;
  onLog?: (event: TargetedPipelineLogEvent) => void;
  signal?: AbortSignal;
}
export interface TargetedPipelineProgress { sourceIndex: number; bytesProcessed: number; totalBytes: number | null; recordsProcessed: number; }
export interface TargetedPipelineLogEvent {
  text: string;
  tag: "info" | "success" | "warning" | "error";
}
export type TargetedPrimaryDropReason = TargetedQcFailure | "alignment_failed" | "duplicate_read_id" | "concatemer_or_chimera" | "malformed_fastq";
export interface TargetedFileStats {
  name: string; round: string; totalReads: number; duplicateReadIds: number; aligned: number;
  fullQcPassed: number; rescuedSiteCalls: number; primaryDropReasons: Record<TargetedPrimaryDropReason, number>;
}
export interface TargetedSiteRunStats extends NanoporeSiteStats {
  callable_full: number; callable_rescued: number; low_quality: number; target_indel: number;
  not_covered: number; ambiguous: number; stop_codon: number;
}
export interface TargetedRoundRunStats extends NanoporeRoundStats {
  total_reads: number; duplicate_read_ids: number; aligned: number; full_qc_passed: number;
  qc_failures: Record<TargetedQcFailure, number>;
  primary_drop_reasons: Record<TargetedPrimaryDropReason, number>;
  sites: Record<string, TargetedSiteRunStats>;
}
export interface TargetedPipelineResult {
  dnaCounters: Map<string, Map<string, Map<string, number>>>;
  haplotypeCounters: Map<string, Map<string, number>>;
  stats: Map<string, TargetedRoundRunStats>;
  fileStats: TargetedFileStats[];
  resolvedSites: ResolvedTargetSite[];
  analyzer: NanoporeAnalyzerOutput;
  /** Lossless exact-DNA count tables. The inferential analyzer intentionally
   * collapses synonymous codons to amino acids; these companion files retain
   * every observed target codon/haplotype so no aggregate count is hidden. */
  exactCodonCsvParts: string[];
  exactHaplotypeCsvParts: string[];
}

interface AlignmentCandidate {
  reverse: boolean;
  sequence: Uint8Array;
  quality: Uint8Array;
  alignment: TargetedAlignment;
  qc: ReturnType<typeof evaluateTargetedQc>;
}

async function* streamToAsyncIter(stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, onChunk: (n: number) => void): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) return;
      if (value) { onChunk(value.byteLength); yield value; }
    }
  } finally { reader.releaseLock(); }
}

export async function runTargetedNanoporePipeline(req: TargetedPipelineRequest): Promise<TargetedPipelineResult> {
  const startedAt = Date.now();
  const log = (text: string, tag: TargetedPipelineLogEvent["tag"] = "info") =>
    req.onLog?.({ text, tag });
  if (req.sources.length === 0 || req.sources.length !== req.sourceRoundIndices.length) throw new Error("Every source must be bound to exactly one round.");
  if (req.roundNames.length < 2 || req.roundNames.some((name, i) => name !== `Round ${i}`)) throw new Error("Rounds must be consecutive from Round 0.");
  const { reference: refString, sites } = resolveTargetSites(req.reference, req.sites);
  log(
    `Settings · reference=${refString.length} nt · rounds=${req.roundNames.length} · ` +
      `targets=${sites.length} · minReadQ=${req.settings.minReadQ} · ` +
      `coverage≥${req.settings.minReferenceCoverage} · alignmentIdentity≥${req.settings.minAlignmentIdentity} · ` +
      `protectedIdentity≥${req.settings.minProtectedIdentity} · protectedIndels≤${req.settings.maxProtectedIndelBases} nt · ` +
      `targetBaseQ≥${req.settings.minTargetBaseQ} · rescueFlank=${req.settings.rescueFlankBases ?? 30} nt · ` +
      `combinations=${req.settings.reportHaplotypes ? "on" : "off"} · concatemerRatio=1.5`,
  );
  log(
    `Statistics · enrichment=log2((RPM_round+p)/(RPM_Round0+p)) · p=${req.settings.pseudocount} RPM · ` +
      `baseline count≥${req.settings.minInputCountToScore} · variance=Enrich2-style · FDR=BH`,
  );
  log(
    `Targets · ${sites.map((site) => `${site.name}:nt${site.ntStart}-${site.ntStart + 2}:${site.wtDna}/${site.wtAa}`).join(" · ")}`,
  );
  const reference = ENC.encode(refString);
  const seedIndex = createTargetedReferenceSeedIndex(reference);
  const wasmAligner = req.useWasmAlignment
    ? createWasmTargetedAligner(reference)
    : undefined;
  try {
  const protectedMask = buildProtectedMask(reference.length, sites);
  const dnaCounters = new Map<string, Map<string, Map<string, number>>>();
  const haplotypeCounters = new Map<string, Map<string, number>>();
  const stats = new Map<string, TargetedRoundRunStats>();
  for (const round of req.roundNames) {
    dnaCounters.set(round, new Map(sites.map((s) => [s.name, new Map()])));
    haplotypeCounters.set(round, new Map());
    stats.set(round, emptyRoundStats(sites));
  }
  const fileStats = new Array<TargetedFileStats>(req.sources.length);
  // Group sources by round while preserving their original order inside each
  // round. This lets the exact read-ID set be released after each round.
  const sourceOrder = req.sources.map((_, index) => index).sort((left, right) =>
    req.sourceRoundIndices[left]! - req.sourceRoundIndices[right]! || left - right
  );
  let activeRound = "";
  let seen = new TargetedReadIdSet();
  let sequenceScratch = new Uint8Array(2048);
  let reverseScratch = new Uint8Array(2048);
  let reverseQualityScratch = new Uint8Array(2048);
  const offsetScratch: number[] = [];
  const projectionWorkspace = createTargetedProjectionWorkspace(reference.length);
  for (const sourceIndex of sourceOrder) {
    const source = req.sources[sourceIndex]!;
    const round = req.roundNames[req.sourceRoundIndices[sourceIndex]!]!;
    if (!round) throw new Error(`Source ${sourceIndex} has an invalid round binding.`);
    if (round !== activeRound) {
      activeRound = round;
      seen = new TargetedReadIdSet();
    }
    const desc = source.describe();
    const sourceStartedAt = Date.now();
    log(
      `Source ${sourceIndex + 1}/${req.sources.length} started · ${desc.name} → ${round} · ` +
        `${desc.sizeBytes == null ? "size unknown" : formatBytes(desc.sizeBytes)}`,
    );
    const stream = await source.open(req.signal);
    const roundStats = stats.get(round)!;
    const perFile = emptyFileStats(desc.name, round);
    fileStats[sourceIndex] = perFile;
    let bytesProcessed = 0, recordsProcessed = 0, lastProgressAt = 0;
    const emitProgress = (force = false): void => {
      if (!req.onProgress) return;
      const now = performance.now();
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      req.onProgress({ sourceIndex, bytesProcessed, totalBytes: desc.sizeBytes, recordsProcessed });
    };
    emitProgress(true);
    const chunks = streamToAsyncIter(stream, req.signal, (n) => {
      bytesProcessed += n;
      emitProgress();
    });
    for await (const rec of readFastqRecordsResilient(chunks)) {
      if (req.maxReadsPerSource != null && recordsProcessed >= req.maxReadsPerSource) break;
      recordsProcessed++; perFile.totalReads++; roundStats.total_reads++;
      if (!isValidFastqRecord(rec)) {
        bump(perFile.primaryDropReasons, "malformed_fastq");
        bump(roundStats.primary_drop_reasons, "malformed_fastq");
        continue;
      }
      const readId = canonicalReadId(rec.header);
      if (!seen.add(readId)) {
        perFile.duplicateReadIds++; roundStats.duplicate_read_ids++;
        bump(perFile.primaryDropReasons, "duplicate_read_id"); bump(roundStats.primary_drop_reasons, "duplicate_read_id");
        continue;
      }
      const q = resolveDoradoReadQ(rec.header, rec.qual);
      if (q.effective < req.settings.minReadQ) {
        bump(roundStats.qc_failures, "low_read_q"); bump(perFile.primaryDropReasons, "low_read_q"); bump(roundStats.primary_drop_reasons, "low_read_q");
        continue;
      }
      // A concatemer can otherwise look like one perfect reference copy plus
      // a long, free semiglobal suffix. Treat this as a structural whole-read
      // failure before alignment or per-site rescue.
      if (rec.seq.length >= Math.ceil(reference.length * 1.5)) {
        bump(perFile.primaryDropReasons, "concatemer_or_chimera");
        bump(roundStats.primary_drop_reasons, "concatemer_or_chimera");
        continue;
      }
      if (rec.seq.length > sequenceScratch.length) {
        sequenceScratch = new Uint8Array(rec.seq.length);
        reverseScratch = new Uint8Array(rec.seq.length);
        reverseQualityScratch = new Uint8Array(rec.qual.length);
      } else if (rec.qual.length > reverseQualityScratch.length) {
        reverseQualityScratch = new Uint8Array(rec.qual.length);
      }
      const forwardSequence = uppercaseInto(rec.seq, sequenceScratch);
      const reverseSequence = rcInto(forwardSequence, reverseScratch);
      const reverseQuality = reverseInto(rec.qual, reverseQualityScratch);
      const forwardEstimate = wasmAligner
        ? wasmAligner.estimate(forwardSequence)
        : estimateReferenceOffsetIndexed(seedIndex, forwardSequence, offsetScratch);
      const reverseEstimate = wasmAligner
        ? wasmAligner.estimate(reverseSequence)
        : estimateReferenceOffsetIndexed(seedIndex, reverseSequence, offsetScratch);
      const primaryReverse = reverseEstimate.hits > forwardEstimate.hits;
      const primary = makeAlignmentCandidate(
        primaryReverse,
        reference,
        forwardSequence,
        rec.qual,
        forwardEstimate,
        reverseSequence,
        reverseQuality,
        reverseEstimate,
        protectedMask,
        q.effective,
        req.settings,
        wasmAligner,
      );
      let alternate: AlignmentCandidate | null = null;
      if (
        !primary ||
        !primary.qc.passed ||
        Math.abs(forwardEstimate.hits - reverseEstimate.hits) <= 2
      ) {
        alternate = makeAlignmentCandidate(
          !primaryReverse,
          reference,
          forwardSequence,
          rec.qual,
          forwardEstimate,
          reverseSequence,
          reverseQuality,
          reverseEstimate,
          protectedMask,
          q.effective,
          req.settings,
          wasmAligner,
        );
      }
      if (!primary && !alternate) {
        bump(perFile.primaryDropReasons, "alignment_failed"); bump(roundStats.primary_drop_reasons, "alignment_failed");
        continue;
      }
      const selected = chooseAlignmentCandidate(primary, alternate)!;
      const seq = selected.sequence;
      const qual = selected.quality;
      const alignment = selected.alignment;
      perFile.aligned++; roundStats.aligned++;
      const qc = selected.qc;
      for (const failure of qc.failures) bump(roundStats.qc_failures, failure);
      if (qc.passed) { perFile.fullQcPassed++; roundStats.full_qc_passed++; }
      else { const reason = primaryFailure(qc.failures); bump(perFile.primaryDropReasons, reason); bump(roundStats.primary_drop_reasons, reason); }
      const projection = buildTargetedReadProjection(
        reference.length,
        seq.length,
        alignment,
        projectionWorkspace,
      );
      const calls = callTargetSites(
        reference,
        seq,
        qual,
        alignment,
        sites,
        { minBaseQ: req.settings.minTargetBaseQ },
        projection,
      );
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!, site = sites[i]!, ss = roundStats.sites[site.name]!;
        const rescued = !qc.passed && isLocallyRescuable(projection, site, protectedMask, req.settings);
        if (call.status === "low_quality") ss.low_quality++;
        else if (call.status === "target_insertion" || call.status === "target_deletion") ss.target_indel++;
        else if (call.status === "not_covered") ss.not_covered++;
        else if (call.status === "ambiguous") ss.ambiguous++;
        else if (call.status === "stop_codon") ss.stop_codon++;
        if ((!qc.passed && !rescued) || !call.codonCallable || call.observedDna == null) continue;
        ss.anchor_found++; ss.passed_qc++;
        if (rescued) { ss.callable_rescued++; perFile.rescuedSiteCalls++; } else ss.callable_full++;
        // The primary table is AA-level, so WT depth must include synonymous
        // codons translating to the reference amino acid.
        if (call.observedAa === site.wtAa) ss.wt_count++;
        const counter = dnaCounters.get(round)!.get(site.name)!;
        counter.set(call.observedDna, (counter.get(call.observedDna) ?? 0) + 1);
      }
      if (qc.passed && req.settings.reportHaplotypes) {
        const hap = buildTargetHaplotype(calls);
        if (hap) {
          const key = hap.replaceAll("|", "_");
          const counter = haplotypeCounters.get(round)!;
          counter.set(key, (counter.get(key) ?? 0) + 1);
          roundStats.haplotype_passed_qc++;
        }
      }
    }
    emitProgress(true);
    const drops = Object.entries(perFile.primaryDropReasons)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    log(
      `Source ${sourceIndex + 1}/${req.sources.length} complete · ${desc.name} · ` +
        `reads=${perFile.totalReads.toLocaleString()} · aligned=${perFile.aligned.toLocaleString()} · ` +
        `fullQC=${perFile.fullQcPassed.toLocaleString()} · rescuedCalls=${perFile.rescuedSiteCalls.toLocaleString()} · ` +
        `drops=${drops || "none"}` +
        (perFile.totalReads === 0 ? " · EMPTY FASTQ STREAM" : "") +
        ` · ${elapsed(sourceStartedAt)}`,
      perFile.primaryDropReasons.malformed_fastq > 0 || perFile.totalReads === 0
        ? "warning"
        : "success",
    );
  }
  log("Counting complete; calculating amino-acid enrichment, variance, p-values and BH-FDR.");
  const analyzer = runNanoporeAnalyzer({
    roundNames: req.roundNames, siteNames: sites.map((s) => s.name), dnaCounters, haplotypeCounters, stats,
    sites: sites.map((s) => ({ name: s.name, wtDna: s.wtDna })), emitHaplotype: req.settings.reportHaplotypes,
    minBaselineCountToScore: req.settings.minInputCountToScore,
    displayMode: "targeted-aa",
    pseudocount: req.settings.pseudocount,
  });
  for (const round of req.roundNames) {
    const roundStats = stats.get(round)!;
    log(
      `${round} summary · reads=${roundStats.total_reads.toLocaleString()} · ` +
        `aligned=${roundStats.aligned.toLocaleString()} · fullQC=${roundStats.full_qc_passed.toLocaleString()} · ` +
        sites.map((site) => `${site.name} callable=${roundStats.sites[site.name]!.passed_qc.toLocaleString()}`).join(" · "),
    );
  }
  for (const [family, value] of Object.entries(analyzer.libraryMedianFitness)) {
    const tag = Math.abs(value) > 1 ? "warning" : "info";
    log(`Library median · ${family}=${value.toFixed(4)}${tag === "warning" ? " (large shift; interpret median centering cautiously)" : ""}`, tag);
  }
  const exactCodonCsvParts = buildExactCodonCsv(req.roundNames, sites, dnaCounters, stats);
  const exactHaplotypeCsvParts = req.settings.reportHaplotypes
    ? buildExactHaplotypeCsv(req.roundNames, sites, haplotypeCounters, stats)
    : [];
  const zeroCoverage = req.roundNames.flatMap((round) => {
    const roundStats = stats.get(round);
    const targetIssues = sites.flatMap((site) =>
      (roundStats?.sites[site.name]?.passed_qc ?? 0) === 0
        ? [`${round}/${site.name}`]
        : [],
    );
    if (
      sites.length >= 2 &&
      req.settings.reportHaplotypes &&
      (roundStats?.haplotype_passed_qc ?? 0) === 0
    ) {
      targetIssues.push(`${round}/linked combinations`);
    }
    return targetIssues;
  });
  if (zeroCoverage.length > 0) {
    log(`Invalid effective coverage · ${zeroCoverage.join(", ")}`, "error");
  }
  log(
    `Pipeline complete · target rows=${analyzer.perSiteRows.length.toLocaleString()} · ` +
      `combination rows=${analyzer.haplotypeRows.length.toLocaleString()} · ${elapsed(startedAt)}`,
    zeroCoverage.length > 0 ? "error" : "success",
  );
  return { dnaCounters, haplotypeCounters, stats, fileStats, resolvedSites: sites, analyzer, exactCodonCsvParts, exactHaplotypeCsvParts };
  } finally {
    wasmAligner?.free();
  }
}

function makeAlignmentCandidate(
  reverse: boolean,
  reference: Uint8Array,
  forwardSequence: Uint8Array,
  forwardQuality: Uint8Array,
  forwardEstimate: ReturnType<typeof estimateReferenceOffsetIndexed>,
  reverseSequence: Uint8Array,
  reverseQuality: Uint8Array,
  reverseEstimate: ReturnType<typeof estimateReferenceOffsetIndexed>,
  protectedMask: Uint8Array,
  readQ: number,
  settings: TargetedPipelineSettings,
  wasmAligner?: WasmTargetedAlignerLike,
): AlignmentCandidate | null {
  try {
    const sequence = reverse ? reverseSequence : forwardSequence;
    const quality = reverse ? reverseQuality : forwardQuality;
    const estimate = reverse ? reverseEstimate : forwardEstimate;
    const alignment = wasmAligner
      ? wasmAligner.alignWithEstimate(sequence, estimate)
      : alignTargetedReferenceWithEstimate(reference, sequence, estimate);
    return {
      reverse,
      sequence,
      quality,
      alignment,
      qc: evaluateTargetedQc(alignment, protectedMask, readQ, settings),
    };
  } catch {
    return null;
  }
}

function chooseAlignmentCandidate(
  first: AlignmentCandidate | null,
  second: AlignmentCandidate | null,
): AlignmentCandidate | null {
  if (!first) return second;
  if (!second) return first;
  if (first.qc.passed !== second.qc.passed) return first.qc.passed ? first : second;
  if (first.alignment.score !== second.alignment.score) {
    return first.alignment.score > second.alignment.score ? first : second;
  }
  return first.reverse ? second : first;
}

function elapsed(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function buildExactCodonCsv(
  rounds: ReadonlyArray<string>, sites: ReadonlyArray<ResolvedTargetSite>,
  counters: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>,
  stats: ReadonlyMap<string, TargetedRoundRunStats>,
): string[] {
  const rows: AnalyzerRow[] = [];
  for (const site of sites) {
    const observed = new Set<string>();
    for (const round of rounds) for (const dna of counters.get(round)?.get(site.name)?.keys() ?? []) observed.add(dna);
    for (const dna of [...observed].sort()) {
      const row: Record<string, RowValue> = {
        Target: site.name, Codon_DNA: dna, Variant_AA: translateDna(dna),
      };
      for (const round of rounds) {
        const count = counters.get(round)?.get(site.name)?.get(dna) ?? 0;
        const denom = stats.get(round)?.sites[site.name]?.passed_qc ?? 0;
        row[`Count_${round}`] = count;
        row[`RPM_${round}`] = denom > 0 ? count / denom * 1e6 : 0;
      }
      rows.push(row as AnalyzerRow);
    }
  }
  const columns: ColumnSpec[] = [
    { name: "Target", type: "string" }, { name: "Codon_DNA", type: "string" },
    { name: "Variant_AA", type: "string" },
    ...rounds.flatMap((round) => ([
      { name: `Count_${round}`, type: "int" as const },
      { name: `RPM_${round}`, type: "float" as const },
    ])),
  ];
  return serializeCsv(rows, columns);
}

function buildExactHaplotypeCsv(
  rounds: ReadonlyArray<string>, sites: ReadonlyArray<ResolvedTargetSite>,
  counters: ReadonlyMap<string, ReadonlyMap<string, number>>,
  stats: ReadonlyMap<string, TargetedRoundRunStats>,
): string[] {
  if (sites.length < 2) return [];
  const observed = new Set<string>();
  for (const round of rounds) for (const dna of counters.get(round)?.keys() ?? []) observed.add(dna);
  const rows: AnalyzerRow[] = [...observed].sort().map((dna) => {
    const row: Record<string, RowValue> = {
      Combination_AA: sites.map((site, index) => `${site.name}${translateDna(dna.split("_")[index] ?? "")}`).join("|"),
      Combination_DNA: dna.replaceAll("_", "|"),
    };
    for (const round of rounds) {
      const count = counters.get(round)?.get(dna) ?? 0;
      const denom = stats.get(round)?.haplotype_passed_qc ?? 0;
      row[`Count_${round}`] = count;
      row[`RPM_${round}`] = denom > 0 ? count / denom * 1e6 : 0;
    }
    return row as AnalyzerRow;
  });
  const columns: ColumnSpec[] = [
    { name: "Combination_AA", type: "string" }, { name: "Combination_DNA", type: "string" },
    ...rounds.flatMap((round) => ([
      { name: `Count_${round}`, type: "int" as const },
      { name: `RPM_${round}`, type: "float" as const },
    ])),
  ];
  return serializeCsv(rows, columns);
}

function isLocallyRescuable(projection: TargetedReadProjection, site: ResolvedTargetSite, mask: Uint8Array, settings: TargetedPipelineSettings): boolean {
  const flank = settings.rescueFlankBases ?? 30, lo = site.start0 - flank, hi = site.end0 + flank;
  if (lo < 0 || hi > mask.length) return false;
  let matches = 0, errors = 0, left = 0, right = 0;
  for (let ref = lo; ref < hi; ref++) {
    errors += projection.insertionBefore[ref] ?? 0;
    if (mask[ref] !== 1) continue;
    const op = projection.opAtRef[ref];
    if (op === 1) matches++;
    else if (op === 2 || op === 3) errors++;
    if (op === 1 || op === 2) {
      if (ref < site.start0) left++; else if (ref >= site.end0) right++;
    }
  }
  return left >= flank && right >= flank && matches / (matches + errors) >= settings.minProtectedIdentity;
}
function canonicalReadId(header: Uint8Array): string { return (DEC.decode(header).replace(/^@/, "").split(/\s/, 1)[0] ?? ""); }
function primaryFailure(f: ReadonlyArray<TargetedQcFailure>): TargetedQcFailure {
  return (["low_read_q", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as TargetedQcFailure[]).find((x) => f.includes(x)) ?? "low_protected_identity";
}
function bump<T extends string>(record: Record<T, number>, key: T): void { record[key] = (record[key] ?? 0) + 1; }
function emptyDropReasons(): Record<TargetedPrimaryDropReason, number> { return { low_read_q: 0, partial_reference: 0, low_alignment_identity: 0, low_protected_identity: 0, protected_indel: 0, alignment_failed: 0, duplicate_read_id: 0, concatemer_or_chimera: 0, malformed_fastq: 0 }; }
function emptyFileStats(name: string, round: string): TargetedFileStats { return { name, round, totalReads: 0, duplicateReadIds: 0, aligned: 0, fullQcPassed: 0, rescuedSiteCalls: 0, primaryDropReasons: emptyDropReasons() }; }
function emptyRoundStats(sites: ReadonlyArray<ResolvedTargetSite>): TargetedRoundRunStats {
  const siteStats: Record<string, TargetedSiteRunStats> = {};
  for (const site of sites) siteStats[site.name] = { anchor_found: 0, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 0, wt_count: 0, callable_full: 0, callable_rescued: 0, low_quality: 0, target_indel: 0, not_covered: 0, ambiguous: 0, stop_codon: 0 };
  return { total_reads: 0, duplicate_read_ids: 0, aligned: 0, full_qc_passed: 0, qc_failures: { low_read_q: 0, partial_reference: 0, low_alignment_identity: 0, low_protected_identity: 0, protected_indel: 0 }, primary_drop_reasons: emptyDropReasons(), sites: siteStats, haplotype_passed_qc: 0 };
}
