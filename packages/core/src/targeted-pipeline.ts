import type { IFastqSource } from "@cdna/types";
import { rcInto, reverseInto, uppercaseInto } from "./demultiplex.js";
import { readFastqRecordsResilient } from "./fastq.js";
import { runNanoporeAnalyzer, type NanoporeAnalyzerOutput } from "./nanopore-analyzer.js";
import type { NanoporeRoundStats, NanoporeSiteStats } from "./nanopore.js";
import { alignTargetedReference, estimateReferenceOffset, type TargetedAlignment } from "./targeted-align.js";
import { buildProtectedMask, buildTargetHaplotype, callTargetSites } from "./targeted-caller.js";
import { evaluateTargetedQc, type TargetedQcFailure, type TargetedQcSettings } from "./targeted-qc.js";
import { resolveDoradoReadQ } from "./targeted-qscore.js";
import { resolveTargetSites, type ResolvedTargetSite, type TargetSiteInput } from "./targeted-types.js";

const ENC = new TextEncoder();
const DEC = new TextDecoder("latin1");

export interface TargetedPipelineSettings extends TargetedQcSettings {
  minTargetBaseQ: number;
  minInputCountToScore: number;
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
  onProgress?: (event: TargetedPipelineProgress) => void;
  signal?: AbortSignal;
}
export interface TargetedPipelineProgress { sourceIndex: number; bytesProcessed: number; totalBytes: number | null; recordsProcessed: number; }
export type TargetedPrimaryDropReason = TargetedQcFailure | "alignment_failed" | "duplicate_read_id" | "concatemer_or_chimera" | "malformed_fastq";
export interface TargetedFileStats {
  name: string; round: string; totalReads: number; duplicateReadIds: number; aligned: number;
  fullQcPassed: number; rescuedSiteCalls: number; primaryDropReasons: Record<TargetedPrimaryDropReason, number>;
}
export interface TargetedSiteRunStats extends NanoporeSiteStats {
  callable_full: number; callable_rescued: number; low_quality: number; target_indel: number;
  not_covered: number; ambiguous: number; off_design: number; stop_codon: number;
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
  if (req.sources.length === 0 || req.sources.length !== req.sourceRoundIndices.length) throw new Error("Every source must be bound to exactly one round.");
  if (req.roundNames.length < 2 || req.roundNames.some((name, i) => name !== `Round ${i}`)) throw new Error("Rounds must be consecutive from Round 0.");
  const { reference: refString, sites } = resolveTargetSites(req.reference, req.sites);
  const reference = ENC.encode(refString);
  const protectedMask = buildProtectedMask(reference.length, sites);
  const dnaCounters = new Map<string, Map<string, Map<string, number>>>();
  const haplotypeCounters = new Map<string, Map<string, number>>();
  const stats = new Map<string, TargetedRoundRunStats>();
  const seenByRound = new Map<string, Set<string>>();
  for (const round of req.roundNames) {
    dnaCounters.set(round, new Map(sites.map((s) => [s.name, new Map()])));
    haplotypeCounters.set(round, new Map());
    stats.set(round, emptyRoundStats(sites));
    seenByRound.set(round, new Set());
  }
  const fileStats: TargetedFileStats[] = [];
  for (let sourceIndex = 0; sourceIndex < req.sources.length; sourceIndex++) {
    const source = req.sources[sourceIndex]!;
    const round = req.roundNames[req.sourceRoundIndices[sourceIndex]!]!;
    if (!round) throw new Error(`Source ${sourceIndex} has an invalid round binding.`);
    const desc = source.describe();
    const stream = await source.open(req.signal);
    const roundStats = stats.get(round)!;
    const seen = seenByRound.get(round)!;
    const perFile = emptyFileStats(desc.name, round);
    fileStats.push(perFile);
    let bytesProcessed = 0, recordsProcessed = 0, lastReportedBytes = 0;
    req.onProgress?.({ sourceIndex, bytesProcessed: 0, totalBytes: desc.sizeBytes, recordsProcessed: 0 });
    const chunks = streamToAsyncIter(stream, req.signal, (n) => {
      bytesProcessed += n;
      if (bytesProcessed - lastReportedBytes >= 1024 * 1024) {
        lastReportedBytes = bytesProcessed;
        req.onProgress?.({ sourceIndex, bytesProcessed, totalBytes: desc.sizeBytes, recordsProcessed });
      }
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
      if (seen.has(readId)) {
        perFile.duplicateReadIds++; roundStats.duplicate_read_ids++;
        bump(perFile.primaryDropReasons, "duplicate_read_id"); bump(roundStats.primary_drop_reasons, "duplicate_read_id");
        continue;
      }
      seen.add(readId);
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
      let seq = uppercaseInto(rec.seq, new Uint8Array(rec.seq.length));
      let qual = rec.qual;
      let alignment: TargetedAlignment;
      try {
        const rc = rcInto(seq, new Uint8Array(seq.length));
        const fwSeeds = estimateReferenceOffset(reference, seq).hits;
        const rcSeeds = estimateReferenceOffset(reference, rc).hits;
        if (rcSeeds > fwSeeds) { seq = rc; qual = reverseInto(rec.qual, new Uint8Array(rec.qual.length)); }
        alignment = alignTargetedReference(reference, seq);
        if (fwSeeds === rcSeeds) {
          const otherSeq = rcInto(seq, new Uint8Array(seq.length));
          const other = alignTargetedReference(reference, otherSeq);
          if (other.score > alignment.score) { seq = otherSeq; qual = reverseInto(qual, new Uint8Array(qual.length)); alignment = other; }
        }
      } catch {
        bump(perFile.primaryDropReasons, "alignment_failed"); bump(roundStats.primary_drop_reasons, "alignment_failed");
        continue;
      }
      perFile.aligned++; roundStats.aligned++;
      const qc = evaluateTargetedQc(alignment, protectedMask, q.effective, req.settings);
      for (const failure of qc.failures) bump(roundStats.qc_failures, failure);
      if (qc.passed) { perFile.fullQcPassed++; roundStats.full_qc_passed++; }
      else { const reason = primaryFailure(qc.failures); bump(perFile.primaryDropReasons, reason); bump(roundStats.primary_drop_reasons, reason); }
      const calls = callTargetSites(reference, seq, qual, alignment, sites, { minBaseQ: req.settings.minTargetBaseQ });
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!, site = sites[i]!, ss = roundStats.sites[site.name]!;
        const rescued = !qc.passed && isLocallyRescuable(alignment, site, protectedMask, req.settings);
        if (call.status === "low_quality") ss.low_quality++;
        else if (call.status === "target_insertion" || call.status === "target_deletion") ss.target_indel++;
        else if (call.status === "not_covered") ss.not_covered++;
        else if (call.status === "ambiguous") ss.ambiguous++;
        else if (call.status === "off_design_codon") ss.off_design++;
        else if (call.status === "stop_codon") ss.stop_codon++;
        if ((!qc.passed && !rescued) || !call.codonCallable || call.observedDna == null) continue;
        ss.anchor_found++; ss.passed_qc++;
        if (rescued) { ss.callable_rescued++; perFile.rescuedSiteCalls++; } else ss.callable_full++;
        if (call.status === "wt") ss.wt_count++;
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
    req.onProgress?.({ sourceIndex, bytesProcessed, totalBytes: desc.sizeBytes, recordsProcessed });
  }
  const analyzer = runNanoporeAnalyzer({
    roundNames: req.roundNames, siteNames: sites.map((s) => s.name), dnaCounters, haplotypeCounters, stats,
    sites: sites.map((s) => ({ name: s.name, wtDna: s.wtDna })), emitHaplotype: req.settings.reportHaplotypes,
    minBaselineCountToScore: req.settings.minInputCountToScore,
  });
  return { dnaCounters, haplotypeCounters, stats, fileStats, resolvedSites: sites, analyzer };
}

function isLocallyRescuable(alignment: TargetedAlignment, site: ResolvedTargetSite, mask: Uint8Array, settings: TargetedPipelineSettings): boolean {
  const flank = settings.rescueFlankBases ?? 30, lo = site.start0 - flank, hi = site.end0 + flank;
  if (lo < 0 || hi > mask.length) return false;
  let ref = 0, matches = 0, errors = 0, left = 0, right = 0;
  for (const op of alignment.cigar) {
    if (op.code === "I") { if (ref >= lo && ref <= hi) errors += op.length; continue; }
    for (let k = 0; k < op.length; k++, ref++) {
      if (ref < lo || ref >= hi || mask[ref] !== 1) continue;
      if (op.code === "M") matches++; else errors++;
      // M/X consume a read base; D does not. A terminal deletion must never
      // masquerade as covered rescue flank.
      if (op.code !== "D") {
        if (ref < site.start0) left++; else if (ref >= site.end0) right++;
      }
    }
  }
  return left >= flank && right >= flank && matches / (matches + errors) >= settings.minProtectedIdentity;
}
function canonicalReadId(header: Uint8Array): string { return (DEC.decode(header).replace(/^@/, "").split(/\s/, 1)[0] ?? ""); }
function primaryFailure(f: ReadonlyArray<TargetedQcFailure>): TargetedQcFailure {
  return (["low_read_q", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as TargetedQcFailure[]).find((x) => f.includes(x)) ?? "low_protected_identity";
}
function bump<T extends string>(record: Record<T, number>, key: T): void { record[key] = (record[key] ?? 0) + 1; }
function isValidFastqRecord(rec: { header: Uint8Array; seq: Uint8Array; separator: Uint8Array; qual: Uint8Array }): boolean {
  if (rec.header[0] !== 64 || rec.separator[0] !== 43 || rec.seq.length === 0 || rec.seq.length !== rec.qual.length) return false;
  for (const b of rec.seq) {
    const u = b >= 97 && b <= 122 ? b - 32 : b;
    if (u !== 65 && u !== 67 && u !== 71 && u !== 84 && u !== 78) return false;
  }
  for (const q of rec.qual) if (q < 33 || q > 126) return false;
  return true;
}
function emptyDropReasons(): Record<TargetedPrimaryDropReason, number> { return { low_read_q: 0, partial_reference: 0, low_alignment_identity: 0, low_protected_identity: 0, protected_indel: 0, alignment_failed: 0, duplicate_read_id: 0, concatemer_or_chimera: 0, malformed_fastq: 0 }; }
function emptyFileStats(name: string, round: string): TargetedFileStats { return { name, round, totalReads: 0, duplicateReadIds: 0, aligned: 0, fullQcPassed: 0, rescuedSiteCalls: 0, primaryDropReasons: emptyDropReasons() }; }
function emptyRoundStats(sites: ReadonlyArray<ResolvedTargetSite>): TargetedRoundRunStats {
  const siteStats: Record<string, TargetedSiteRunStats> = {};
  for (const site of sites) siteStats[site.name] = { anchor_found: 0, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 0, wt_count: 0, callable_full: 0, callable_rescued: 0, low_quality: 0, target_indel: 0, not_covered: 0, ambiguous: 0, off_design: 0, stop_codon: 0 };
  return { total_reads: 0, duplicate_read_ids: 0, aligned: 0, full_qc_passed: 0, qc_failures: { low_read_q: 0, partial_reference: 0, low_alignment_identity: 0, low_protected_identity: 0, protected_indel: 0 }, primary_drop_reasons: emptyDropReasons(), sites: siteStats, haplotype_passed_qc: 0 };
}
