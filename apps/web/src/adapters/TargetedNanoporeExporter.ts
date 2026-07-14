import { TARGETED_NANOPORE_METHODS, formatMethodsAsText, translateDna } from "@cdna/core";
import type { TargetedCallingSettings, TargetedSiteForm } from "@/state/useTargetedNanoporeStore";
import type { TargetedNanoporeOutcome } from "@/worker/types";
import { aminoAcidTargetLabel } from "../tools/nanopore-targeted/targetNaming";

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
  ["Master_Enrichment_Matrix.csv.gz", "Complete per-target amino-acid count, RPM, round-to-baseline enrichment, variance and FDR matrix"],
  ["Combination_Enrichment_Matrix.csv.gz", "All target amino acids concatenated in confirmed target order and analyzed as one linked combination"],
  ["run_stats.json", "Machine-readable configuration, file QC, filter funnel, target callability and provenance"],
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
    ["Round", "Target", "Callable_Total", "Callable_Full", "Callable_Rescued", "Reference_AA_Count", "Low_Target_Q", "Target_Indel", "Not_Covered", "Ambiguous", "Off_Design", "Stop_Codon"],
    ...outcome.roundNames.flatMap((round) => outcome.siteNames.map((site) => { const s = outcome.statsByRound[round]!.sites[site]!; return [round, site, s.passed_qc, s.callable_full, s.callable_rescued, s.wt_count, s.low_quality, s.target_indel, s.not_covered, s.ambiguous, s.off_design, s.stop_codon]; })),
  ]);
}

export function buildFileQcCsv(outcome: TargetedNanoporeOutcome): string {
  const reasons = ["malformed_fastq", "duplicate_read_id", "low_read_q", "concatemer_or_chimera", "alignment_failed", "partial_reference", "low_alignment_identity", "low_protected_identity", "protected_indel"] as const;
  return csv([
    ["File", "Round", "Total_Reads", "Aligned", "Full_QC_Passed", "Rescued_Target_Calls", ...reasons],
    ...outcome.fileStats.map((f) => [f.name, f.round, f.totalReads, f.aligned, f.fullQcPassed, f.rescuedSiteCalls, ...reasons.map((reason) => f.primaryDropReasons[reason])]),
  ]);
}

export function buildRunStats(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot) {
  const statsByRound = Object.fromEntries(outcome.roundNames.map((round) => {
    const { sites, ...wholeRead } = outcome.statsByRound[round]!;
    const targets = Object.fromEntries(Object.entries(sites).map(([target, values]) => {
      const { wt_count, ...callability } = values;
      return [target, { ...callability, referenceAaCount: wt_count }];
    }));
    return [round, { ...wholeRead, targets }];
  }));
  return {
    schemaVersion: "targeted-nanopore-run/v2", generatedAt: new Date().toISOString(),
    project: snapshot.projectName, startedAt: toIso(snapshot.startedAt), finishedAt: toIso(snapshot.finishedAt),
    durationSeconds: snapshot.startedAt && snapshot.finishedAt ? (snapshot.finishedAt - snapshot.startedAt) / 1000 : null,
    rounds: outcome.roundNames, targets: outcome.targets, referenceDnaByTarget: outcome.wtBySite,
    effectiveSettings: { ...snapshot.settings, reportHaplotypes: snapshot.reportHaplotypes, rescueFlankBases: 30, concatemerLengthRatio: 1.5 },
    statsByRound, fileStats: outcome.fileStats,
    filterFunnel: outcome.roundNames.map((round) => ({ round, ...outcome.statsByRound[round]!.primary_drop_reasons })),
    targetCallability: outcome.roundNames.flatMap((round) => outcome.siteNames.map((target) => { const { wt_count, ...values } = outcome.statsByRound[round]!.sites[target]!; return { round, target, ...values, referenceAaCount: wt_count }; })),
    exactCodonCounts: outcome.exactCodonCounts,
    exactCombinationCounts: Object.fromEntries(outcome.roundNames.map((round) => [round,
      Object.entries(outcome.exactHaplotypeCounts[round] ?? {}).map(([joinedDna, count]) => ({
        combinationAa: outcome.siteNames.map((target, index) => `${target}${translateDna(joinedDna.split("_")[index] ?? "")}`).join("|"),
        combinationDna: joinedDna.replaceAll("_", "|"), count,
      })),
    ])),
    combinationStatistics: outcome.haplotypeStatistics,
    libraryMedianEnrichment: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts,
    statisticalModel: { level: "amino acid", referenceStateHandling: "analyzed as an ordinary AA state; never used as a special denominator", pseudocount: 1, enrichment: "log2((RPM_round + 1) / (RPM_Round0 + 1))", variance: "two-count Poisson delta method", pValue: "two-sided Wald z-test", fdr: "Benjamini-Hochberg per target/combination family", biologicalReplicatesModeled: false },
  };
}

export function buildLockedConfig(snapshot: TargetedExportSnapshot) {
  return { schemaVersion: "targeted-nanopore-config/v2", project: snapshot.projectName, reference: snapshot.referenceSeq, cds: { start1: snapshot.cdsStart, end1: snapshot.cdsEnd, strand: snapshot.cdsStrand }, targets: snapshot.sites.map(({ ntStart }) => ({ name: aminoAcidTargetLabel(snapshot.referenceSeq, snapshot.cdsStart, ntStart).name, ntStart, length: 3, design: "NNK" })), settings: { ...snapshot.settings, reportHaplotypes: snapshot.reportHaplotypes, rescueFlankBases: 30 }, fixedSafeguards: { concatemerLengthRatio: 1.5 } };
}

export function buildTargetedQcReport(outcome: TargetedNanoporeOutcome, snapshot: TargetedExportSnapshot): string {
  const total = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.total_reads);
  const passed = sum(outcome.roundNames, (r) => outcome.statsByRound[r]!.full_qc_passed);
  const lines = [
    "=".repeat(85), "              TARGETED NANOPORE NNK EXPERIMENT QC & SUMMARY REPORT", "=".repeat(85), "",
    `Project Name    : ${snapshot.projectName || "(unnamed)"}`, `Generation Time : ${new Date().toISOString()}`, `Total Reads     : ${total.toLocaleString()}`, `Full-QC Reads   : ${passed.toLocaleString()} (${total ? (passed / total * 100).toFixed(2) : "0.00"}%)`, "",
    "--- 1. EXCLUSIVE WHOLE-READ FILTER FUNNEL ---", buildFilterFunnelCsv(outcome).trim(), "",
    "A read receives one primary whole-read drop reason. Overlapping diagnostic failures remain in run_stats.json. Target rescue is reported separately and is never subtracted twice.", "",
    "--- 2. TARGET CALLABILITY & READ PRESERVATION ---", buildSiteCallabilityCsv(outcome).trim(), "",
    "Callable_Total = Callable_Full + Callable_Rescued. Target denominators are independent: failure at A304 does not erase a valid R233 call. Combinations use full-QC reads only.", "",
    "--- 3. MULTI-TARGET COMBINATION ENRICHMENT ---",
    "Combination_AA is self-describing and formed in locked target order (for example R233W|A304V|G331D).",
    "A read enters this matrix only when every target codon is callable and the full read passes QC. Partial rescued calls are excluded because an incomplete read cannot establish linkage.",
    "Counts, RPM, round-to-Round 0 enrichment, two-count variance, p-value and BH-FDR reuse the NGS statistical helpers; combination rows form their own multiple-testing family.", "",
    "--- 4. HOW SUBSTITUTIONS, INSERTIONS AND DELETIONS ARE HANDLED ---",
    "Substitution outside a target: retained while target-masked protected identity passes; accumulated mismatch can fail low_protected_identity.",
    "Substitution inside a target: called as a codon only when all three projected bases are unambiguous and meet target base Q. Intended target substitutions are excluded from protected-identity scoring.",
    "Insertion/deletion overlapping a target codon: that target enters target_indel and is non-callable; other covered targets remain eligible.",
    "Small indel outside targets: projected through CIGAR and tolerated up to the fixed protected-indel limit. Larger disruption fails protected_indel for the whole read.",
    "Partial read: may rescue one target only when both 30-nt flanks are covered and pass protected identity. It cannot create a linked combination.",
    "Off-NNK and stop codon: retained in exact counts and target QC as design/base-calling diagnostics; not silently removed.", "",
    "--- 5. INTERPRETATION LIMITS ---",
    "The primary enrichment matrix collapses synonymous codons to amino acids. The reference amino acid and reference combination are ordinary rows with their own enrichment; no WT/non-WT classification changes the statistics. Lossless exact-codon and exact target-combination counts remain in run_stats.json.",
    "Round 0 threshold gates inference only. It does not delete raw counts or RPM.",
    "Without biological replicates, Var/Z/p/FDR describe Poisson counting uncertainty and usually underestimate total experimental uncertainty. Use them for prioritization, not replicate-level claims.", "",
    formatMethodsAsText(TARGETED_NANOPORE_METHODS, { settings: methodSettings(snapshot), libraryMedian: outcome.libraryMedianFitness, hitCounts: outcome.hitCounts }),
  ];
  return lines.join("\n");
}

export function methodSettings(snapshot: TargetedExportSnapshot) { return [
  { label: "Minimum read Q", value: `≥ ${snapshot.settings.minReadQ}` }, { label: "Protected identity", value: `≥ ${snapshot.settings.minProtectedIdentity}` },
  { label: "Target base Q", value: `≥ ${snapshot.settings.minTargetBaseQ}` }, { label: "Round 0 score threshold", value: `≥ ${snapshot.settings.minInputCountToScore}` },
  { label: "Reference coverage (fixed)", value: `≥ ${snapshot.settings.minReferenceCoverage}` }, { label: "Alignment identity (fixed)", value: `≥ ${snapshot.settings.minAlignmentIdentity}` },
  { label: "Protected indel limit (fixed)", value: `≤ ${snapshot.settings.maxProtectedIndelBases} nt` }, { label: "Linked combinations", value: snapshot.reportHaplotypes ? "full-QC reads" : "off" },
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
