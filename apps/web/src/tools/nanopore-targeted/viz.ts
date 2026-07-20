import { log2RpmRatio, type NanoporeAnalyzerRow } from "@cdna/core";
import type { PeptideRecord } from "@/tools/cdna-display/viz/csvParse";
import type { TargetedNanoporeOutcome } from "@/worker/types";

export interface TargetedSankeyNode { name: string; kind: "total" | "round" | "pass" | "drop"; }
export interface TargetedSankeyLink { source: number; target: number; value: number; }

export function buildTargetedSankeyData(outcome: TargetedNanoporeOutcome): { nodes: TargetedSankeyNode[]; links: TargetedSankeyLink[] } {
  const nodes: TargetedSankeyNode[] = [{ name: "Total reads", kind: "total" }], links: TargetedSankeyLink[] = [];
  const add = (name: string, kind: TargetedSankeyNode["kind"]) => (nodes.push({ name, kind }), nodes.length - 1);
  for (const round of outcome.roundNames) {
    const stats = outcome.statsByRound[round]!;
    const roundNode = add(round, "round"); links.push({ source: 0, target: roundNode, value: stats.total_reads });
    const bucket = (name: string, value: number, kind: TargetedSankeyNode["kind"] = "drop") => { if (value > 0) links.push({ source: roundNode, target: add(`${name} · ${round}`, kind), value }); };
    bucket("Passed full QC", stats.full_qc_passed, "pass");
    bucket("Malformed FASTQ", stats.primary_drop_reasons.malformed_fastq); bucket("Duplicate ID", stats.primary_drop_reasons.duplicate_read_id);
    bucket("Low read Q", stats.primary_drop_reasons.low_read_q); bucket("Concatemer/chimera", stats.primary_drop_reasons.concatemer_or_chimera);
    bucket("Alignment failed", stats.primary_drop_reasons.alignment_failed); bucket("Partial reference", stats.primary_drop_reasons.partial_reference);
    bucket("Low alignment identity", stats.primary_drop_reasons.low_alignment_identity); bucket("Low protected identity", stats.primary_drop_reasons.low_protected_identity);
    bucket("Protected indel", stats.primary_drop_reasons.protected_indel);
  }
  return { nodes, links };
}

/** Adapt the targeted round-to-baseline enrichment table to the shared NGS chart contract.
 * `peptide` includes the target label so points from distinct target-scoped FDR
 * families remain identifiable. */
export function targetedRowsToChartRows(
  rows: ReadonlyArray<NanoporeAnalyzerRow>,
  rounds: ReadonlyArray<string>,
  pseudocount: number,
): PeptideRecord[] {
  const totalsByTarget = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const target = String(row.Target);
    const totals = totalsByTarget.get(target) ?? {};
    for (const round of rounds) {
      totals[round] = (totals[round] ?? 0) + finite(row[`Count_${round}`]);
    }
    totalsByTarget.set(target, totals);
  }
  return rows.map((row) => {
    const count: Record<string, number> = {}, rpm: Record<string, number> = {};
    const stepwise: Record<string, number> = {}, centered: Record<string, number> = {};
    const pval: Record<string, number> = {}, fdr: Record<string, number> = {}, variance: Record<string, number> = {};
    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i]!;
      count[round] = finite(row[`Count_${round}`]);
      rpm[round] = finite(row[`RPM_${round}`]);
      if (i > 0) {
        const prev = rounds[i - 1]!;
        const first = rounds[0]!;
        const totals = totalsByTarget.get(String(row.Target))!;
        stepwise[round] = log2RpmRatio(
          count[round]!,
          totals[round]!,
          count[prev]!,
          totals[prev]!,
          pseudocount,
        );
        centered[round] = finite(row[`Centered_Enrichment_${round}_vs_${first}`]);
        pval[round] = finite(row[`Pval_Enrichment_${round}_vs_${first}`], 1);
        fdr[round] = finite(row[`FDR_q_${round}_vs_${first}`], 1);
        variance[round] = finite(row[`Var_Enrichment_${round}_vs_${first}`], Number.NaN);
      }
    }
    return {
      peptide: `${String(row.Target)}:${String(row.Variant_AA)}`,
      gc: 0, dominantDna: String(row.Dominant_DNA ?? ""), count, rpm,
      stepwise, centered, pval, fdr, variance,
    };
  });
}

function finite(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
