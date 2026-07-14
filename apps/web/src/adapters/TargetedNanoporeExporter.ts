import { TARGETED_NANOPORE_METHODS, formatMethodsAsText } from "@cdna/core";
import type { TargetedCallingSettings, TargetedSiteForm } from "@/state/useTargetedNanoporeStore";
import type { TargetedNanoporeOutcome } from "@/worker/types";

export interface TargetedExportSnapshot {
  projectName: string;
  referenceSeq: string;
  cdsStart: number;
  cdsEnd: number;
  cdsStrand: "+" | "-";
  sites: TargetedSiteForm[];
  settings: TargetedCallingSettings;
  reportHaplotypes: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export const TARGETED_EXPORT_FILES = [
  ["Master_Enrichment_Matrix.csv.gz", "Complete per-site amino-acid count, RPM, fitness, variance and FDR matrix"],
  ["Combination_Enrichment_Matrix.csv.gz", "All target amino acids concatenated in confirmed site order and analyzed as one multi-site haplotype"],
  ["run_stats.json", "Machine-readable configuration, file QC, filter funnel, site callability and provenance"],
  ["QC_Summary_Report.txt", "Human-readable QC logic, abnormal-event handling, formulas and caveats"],
] as const;

export async function exportTargetedOutcome(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot): Promise<void> {
  const base = sanitize(snapshot.projectName || "nanopore_run");
  const downloads: Array<[Blob, string]> = [];
  await addGzip(downloads, outcome.perSiteCsvBlob, `${base}_Master_Enrichment_Matrix.csv.gz`);
  await addGzip(downloads, outcome.haplotypeCsvBlob, `${base}_Combination_Enrichment_Matrix.csv.gz`);
  downloads.push(
    [jsonBlob(buildRunStats(outcome, snapshot)), `${base}_run_stats.json`],
    [textBlob(buildTargetedQcReport(outcome, snapshot), "text/plain;charset=utf-8"), `${base}_QC_Summary_Report.txt`],
  );
  for (const [blob, name] of downloads) downloadBlob(blob, name);
}

export function buildFilterFunnelCsv(outcome: TargetedNanoporeOutcome): string {
  const reasons = ["malformed_fastq", "duplicate_read_id", "low_read_q", "concatemer_or_chimera", "alignment_failed", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as const;
  return csv([
    ["Round", "Total_Reads", "Aligned", "Full_QC_Passed", ...reasons],
    ...outcome.roundNames.map((round) => { const s = outcome.statsByRound[round]!; return [round, s.total_reads, s.aligned, s.full_qc_passed, ...reasons.map((reason) => s.primary_drop_reasons[reason])]; }),
  ]);
}

export function buildSiteCallabilityCsv(outcome: TargetedNanoporeOutcome): string {
  return csv([
    ["Round", "Site", "Callable_Total", "Callable_Full", "Callable_Rescued", "WT", "Low_Target_Q", "Target_Indel", "Not_Covered", "Ambiguous", "Off_Design", "Stop_Codon"],
    ...outcome.roundNames.flatMap((round) => outcome.siteNames.map((site) => { const s = outcome.statsByRound[round]!.sites[site]!; return [round, site, s.passed_qc, s.callable_full, s.callable_rescued, s.wt_count, s.low_quality, s.target_indel, s.not_covered, s.ambiguous, s.off_design, s.stop_codon]; })),
  ]);
}

export function buildFileQcCsv(outcome: TargetedNanoporeOutcome): string {
  const reasons = ["malformed_fastq", "duplicate_read_id", "low_read_q", "concatemer_or_chimera", "alignment_failed", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as const;
  return csv([
    ["File", "Round", "Total_Reads", "Aligned", "Full_QC_Passed", "Rescued_Site_Calls", ...reasons],
    ...outcome.fileStats.map((f) => [f.name, f.round, f.totalReads, f.aligned, f.fullQcPassed, f.rescuedSiteCalls, ...reasons.map((reason) => f.primaryDropReasons[reason])]),
  ]);
}

export function buildRunStats(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot) {
  return {
    schemaVersion: "targeted-nanopore-run/v1", generatedAt: new Date().toISOString(),
    project: snapshot.projectName, startedAt: toIso(snapshot.startedAt), finishedAt: toIso(snapshot.finishedAt),
    durationSeconds: snapshot.startedAt && snapshot.finishedAt ? (snapshot.finishedAt - snapshot.startedAt) / 1000 : null,
    rounds: outcome.roundNames, sites: snapshot.sites, wtBySite: outcome.wtBySite,
    effectiveSettings: { ...snapshot.settings, reportHaplotypes: snapshot.reportHaplotypes, rescueFlankBases: 30, concatemerLengthRatio: 1.5 },
    statsByRound: outcome.statsByRound, fileStats: outcome.fileStats,
    filterFunnel: outcome.roundNames.map((round) => ({ round, ...outcome.statsByRound[round]!.primary_drop_reasons })),
    siteCallability: outcome.roundNames.flatMap((round) => outcome.siteNames.map((site) => ({ round, site, ...outcome.statsByRound[round]!.sites[site] }))),
    exactCodonCounts: outcome.exactCodonCounts,
    exactHaplotypeCounts: outcome.exactHaplotypeCounts,
    haplotypeStatistics: outcome.haplotypeStatistics,
    libraryMedianFitness: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts,
    statisticalModel: { pseudocount: 1, variance: "four-term Poisson delta method", pValue: "two-sided Wald z-test", fdr: "Benjamini-Hochberg per site/haplotype family", biologicalReplicatesModeled: false },
  };
}

export function buildLockedConfig(snapshot: TargetedExportSnapshot) {
  return { schemaVersion: "targeted-nanopore-config/v1", project: snapshot.projectName, reference: snapshot.referenceSeq, cds: { start1: snapshot.cdsStart, end1: snapshot.cdsEnd, strand: snapshot.cdsStrand }, targets: snapshot.sites.map(({ name, ntStart }) => ({ name, ntStart, length: 3, design: "NNK" })), settings: { ...snapshot.settings, reportHaplotypes: snapshot.reportHaplotypes, rescueFlankBases: 30 }, fixedSafeguards: { concatemerLengthRatio: 1.5 } };
}

export function buildTargetedQcReport(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot): string {
  const total = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.total_reads);
  const passed = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.full_qc_passed);
  const lines = [
    "=".repeat(85), "              TARGETED NANOPORE NNK EXPERIMENT QC & SUMMARY REPORT", "=".repeat(85), "",
    `Project Name    : ${snapshot.projectName || "(unnamed)"}`, `Generation Time : ${new Date().toISOString()}`, `Total Reads     : ${total.toLocaleString()}`, `Full-QC Reads   : ${passed.toLocaleString()} (${total ? (passed / total * 100).toFixed(2) : "0.00"}%)`, "",
    "--- 1. EXCLUSIVE WHOLE-READ FILTER FUNNEL ---", buildFilterFunnelCsv(outcome).trim(), "",
    "A read receives one primary whole-read drop reason. Overlapping diagnostic failures remain in run_stats.json. Site rescue is reported separately and is never subtracted twice.", "",
    "--- 2. SITE CALLABILITY & READ PRESERVATION ---", buildSiteCallabilityCsv(outcome).trim(), "",
    "Callable_Total = Callable_Full + Callable_Rescued. Site denominators are independent: failure at site_02 does not erase a valid site_01 call. Haplotypes use full-QC reads only.", "",
    "--- 3. MULTI-SITE COMBINATION ENRICHMENT ---",
    "Haplotype_AA in Combination_Enrichment_Matrix is formed by concatenating target-site amino acids in the locked site order (for example F_L_W).",
    "A read enters this matrix only when every target codon is callable and the full read passes QC. Partial rescued calls are excluded because an incomplete read cannot establish linkage.",
    "Counts, RPM, WT-normalized fitness, four-term variance, p-value and BH-FDR reuse the same analyzer; combination rows form their own haplotype multiple-testing family.", "",
    "--- 4. HOW SUBSTITUTIONS, INSERTIONS AND DELETIONS ARE HANDLED ---",
    "Substitution outside a target: retained while target-masked protected identity passes; accumulated mismatch can fail low_protected_identity.",
    "Substitution inside a target: called as a codon only when all three projected bases are unambiguous and meet target base Q. Intended target substitutions are excluded from protected-identity scoring.",
    "Insertion/deletion overlapping a target codon: that site enters target_indel and is non-callable; other covered sites remain eligible.",
    "Small indel outside targets: projected through CIGAR and tolerated up to the fixed protected-indel limit. Larger disruption fails protected_indel for the whole read.",
    "Partial read: may rescue one site only when both 30-nt flanks are covered and pass protected identity. It cannot create a haplotype.",
    "Off-NNK and stop codon: retained in exact counts and site QC as design/base-calling diagnostics; not silently removed.", "",
    "--- 5. INTERPRETATION LIMITS ---",
    "The primary enrichment matrix collapses synonymous codons to amino acids. Lossless exact-codon counts, exact target haplotypes and haplotype statistics are retained under dedicated keys in run_stats.json.",
    "Round 0 threshold gates inference only. It does not delete raw counts or RPM.",
    "Without biological replicates, Var/Z/p/FDR describe Poisson counting uncertainty and usually underestimate total experimental uncertainty. Use them for prioritization, not replicate-level claims.",
    "Low WT depth makes every WT-normalized fitness at that site unstable; inspect wt_count and Var_Fitness before interpretation.", "",
    formatMethodsAsText(TARGETED_NANOPORE_METHODS, { settings: methodSettings(snapshot), libraryMedian: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts }),
  ];
  return lines.join("\n");
}

export function methodSettings(snapshot: TargetedExportSnapshot) { return [
  { label: "Minimum read Q", value: `≥ ${snapshot.settings.minReadQ}` }, { label: "Protected identity", value: `≥ ${snapshot.settings.minProtectedIdentity}` },
  { label: "Target base Q", value: `≥ ${snapshot.settings.minTargetBaseQ}` }, { label: "Round 0 score threshold", value: `≥ ${snapshot.settings.minInputCountToScore}` },
  { label: "Reference coverage (fixed)", value: `≥ ${snapshot.settings.minReferenceCoverage}` }, { label: "Alignment identity (fixed)", value: `≥ ${snapshot.settings.minAlignmentIdentity}` },
  { label: "Protected indel limit (fixed)", value: `≤ ${snapshot.settings.maxProtectedIndelBases} nt` }, { label: "Haplotypes", value: snapshot.reportHaplotypes ? "full-QC reads" : "off" },
]; }

function csv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string { return rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n"; }
function sum(rounds: string[], fn: (round: string) => number): number { return rounds.reduce((n, round) => n + fn(round), 0); }
function toIso(value: number | null): string | null { return value == null ? null : new Date(value).toISOString(); }
function textBlob(text: string, type = "text/csv;charset=utf-8"): Blob { return new Blob([text], { type }); }
function jsonBlob(value: unknown): Blob { return new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); }
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80); }
async function gzipBlob(blob: Blob): Promise<Blob> { return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob(); }
async function addGzip(out: Array<[Blob, string]>, blob: Blob | null, name: string) { if (blob) out.push([await gzipBlob(blob), name]); }
function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
