// Nanopore SSM analyzer — converts the engine's per-site DNA counters +
// haplotype counters into two CSVs:
//
//   enrichment_per_site.csv (long format):
//     Site, Variant_AA, Dominant_DNA, GC_Percent,
//     Count_<round>, RPM_<round>, Rank_<round>,
//     Enrich_Global_<round>, Fitness_vs_WT_<round>
//   (iterates over rounds; one row per (site, AA-variant))
//
//   enrichment_haplotype.csv (only when ≥2 sites + reportHaplotype was on):
//     Haplotype_AA, Haplotype_DNA, GC_Percent,
//     Count_<round>, RPM_<round>, Rank_<round>,
//     Enrich_Global_<round>, Fitness_vs_WT_<round>
//
// Metrics:
//   - RPM denominator is per-site `passed_qc` (analyzer is the only consumer
//     of this counter — total_reads isn't tracked because RC-retry would
//     double-count it).
//   - Enrich_Global_<round> = log2((RPM_round + 1) / (RPM_round_0 + 1))
//   - Fitness_vs_WT_<round> = log2( ((count + 1) / (wt_count_round + 1)) /
//                                   ((count_round_0 + 1) / (wt_count_round_0 + 1)) )
//     (DiMSum / Enrich2 convention; pseudocount 1.0 on every term so the
//     formula is defined even when a variant or WT has zero reads in a round)
//
// Sort order: per-site rows sort by Site (input order), then within each
// site by Fitness_vs_WT_<lastRound> desc with Variant_AA asc as the
// tiebreaker (stable sort). Haplotype rows sort the same way over the
// joined-codon AA string.

import { translateDna } from "./dna.js";
import { serializeCsv, type AnalyzerRow, type ColumnSpec, type RowValue } from "./analyzer.js";
import type { NanoporeRoundStats } from "./nanopore.js";
import {
  benjaminiHochberg,
  median,
  seLog2WtRatio,
  twoSidedPvalue,
  varLog2WtRatio,
} from "./stats.js";

const PSEUDO = 1.0;

export interface NanoporeAnalyzerInput {
  /** Round insertion order. Used for column ordering AND as the reference
   *  round (index 0) for `Enrich_Global_*` and `Fitness_vs_WT_*`. */
  roundNames: ReadonlyArray<string>;
  siteNames: ReadonlyArray<string>;
  dnaCounters: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>;
  haplotypeCounters: ReadonlyMap<string, ReadonlyMap<string, number>>;
  stats: ReadonlyMap<string, NanoporeRoundStats>;
  /** WT DNA per site, used both as the per-site WT match and (in joined form)
   *  as the haplotype WT denominator. */
  sites: ReadonlyArray<{ name: string; wtDna: string }>;
  /** Off by default — only emits haplotype CSV when the engine was configured
   *  with this on AND ≥2 sites are configured. */
  emitHaplotype: boolean;
}

export interface NanoporeAnalyzerRow {
  [key: string]: RowValue;
}

export interface NanoporeAnalyzerOutput {
  perSiteRows: NanoporeAnalyzerRow[];
  haplotypeRows: NanoporeAnalyzerRow[];
  perSiteColumns: ColumnSpec[];
  haplotypeColumns: ColumnSpec[];
  /** Per-line parts (each entry terminated with "\n"). Pass directly to
   *  `new Blob(parts, …)` for downloads; or `parts.join("")` for inspection.
   *  Avoids the V8 ~537 MB single-string ceiling on multi-GB runs. */
  perSiteCsvParts: string[];
  /** Empty array when haplotype output is disabled or empty. */
  haplotypeCsvParts: string[];
  /** Library median of `Fitness_vs_WT_<r>`, per (site, round). Surfaces a
   *  systematic library-wide shift that the Centered_Fitness_<r> column
   *  corrects for. Keyed as `"<siteName>:<round>"`. Pipeline exposes this
   *  in run_stats.json so users can spot the strong-dropout regime where
   *  the centered score over-corrects. */
  libraryMedianFitness: Record<string, number>;
}

interface AaAgg {
  aa: string;
  dnaTotals: Map<string, number>; // dna → total count across rounds (for picking dominant)
  perRound: Map<string, number>;  // round → summed count for this AA at this site
}

export function runNanoporeAnalyzer(input: NanoporeAnalyzerInput): NanoporeAnalyzerOutput {
  // Accumulator: keyed by `${siteName}:${round}` for per-site medians and
  // `__haplotype__:${round}` for haplotype medians. Pipeline lifts this into
  // run_stats.json so users can spot a systematic library shift.
  const libraryMedianFitness: Record<string, number> = {};

  const perSiteRows: NanoporeAnalyzerRow[] = [];
  for (const siteName of input.siteNames) {
    perSiteRows.push(...aggregatePerSite(input, siteName, libraryMedianFitness));
  }

  const perSiteColumns = buildPerSiteColumns(input.roundNames);
  // serializeCsv's input type is tied to cDNA's AnalyzerRow shape, but it
  // only ever does column-by-name lookups, so the per-site rows (different
  // schema, same index-signature shape) work fine. Cast at the boundary.
  const perSiteCsvParts = serializeCsv(perSiteRows as unknown as AnalyzerRow[], perSiteColumns);

  const wantHaplotype = input.emitHaplotype && input.siteNames.length >= 2;
  let haplotypeRows: NanoporeAnalyzerRow[] = [];
  let haplotypeColumns: ColumnSpec[] = [];
  let haplotypeCsvParts: string[] = [];
  if (wantHaplotype) {
    haplotypeRows = aggregateHaplotypes(input, libraryMedianFitness);
    haplotypeColumns = buildHaplotypeColumns(input.roundNames);
    haplotypeCsvParts =
      haplotypeRows.length > 0
        ? serializeCsv(haplotypeRows as unknown as AnalyzerRow[], haplotypeColumns)
        : [];
  }

  return {
    perSiteRows,
    haplotypeRows,
    perSiteColumns,
    haplotypeColumns,
    perSiteCsvParts,
    haplotypeCsvParts,
    libraryMedianFitness,
  };
}

// --- Per-site aggregation ---------------------------------------------------

function aggregatePerSite(
  input: NanoporeAnalyzerInput,
  siteName: string,
  libraryMedianFitness: Record<string, number>,
): NanoporeAnalyzerRow[] {
  // Collapse DNA → AA, tracking dominant DNA per AA and per-round count.
  const aaMap = new Map<string, AaAgg>();
  for (const round of input.roundNames) {
    const siteDna = input.dnaCounters.get(round)?.get(siteName);
    if (!siteDna) continue;
    for (const [dna, count] of siteDna) {
      const aa = translateDna(dna);
      let agg = aaMap.get(aa);
      if (!agg) {
        agg = { aa, dnaTotals: new Map(), perRound: new Map() };
        aaMap.set(aa, agg);
      }
      agg.dnaTotals.set(dna, (agg.dnaTotals.get(dna) ?? 0) + count);
      agg.perRound.set(round, (agg.perRound.get(round) ?? 0) + count);
    }
  }

  // RPM denominator per round = passed_qc for this site in that round.
  const denom = new Map<string, number>();
  for (const round of input.roundNames) {
    const ss = input.stats.get(round)?.sites?.[siteName];
    denom.set(round, ss?.passed_qc ?? 0);
  }

  // WT count per round = count of the WT DNA in dnaCounters.
  const site = input.sites.find((s) => s.name === siteName);
  const wtDna = site?.wtDna ?? "";
  const wtCounts = new Map<string, number>();
  for (const round of input.roundNames) {
    const siteDna = input.dnaCounters.get(round)?.get(siteName);
    wtCounts.set(round, siteDna?.get(wtDna) ?? 0);
  }

  const firstRound = input.roundNames[0]!;
  const lastRound = input.roundNames[input.roundNames.length - 1]!;

  // ---- Pass 1: per-variant counts + per-round Fitness_vs_WT.
  //   Enrich_Global column removed in Phase 6.16 (recoverable as
  //   log₂((RPM+1)/(RPM₀+1)) if a consumer ever needs it).
  const rows: NanoporeAnalyzerRow[] = [];
  for (const agg of aaMap.values()) {
    const dominantDna = pickDominant(agg.dnaTotals);
    const row: NanoporeAnalyzerRow = {
      Site: siteName,
      Variant_AA: agg.aa,
      Dominant_DNA: dominantDna,
    };
    const c0 = agg.perRound.get(firstRound) ?? 0;
    const wt0 = wtCounts.get(firstRound) ?? 0;
    for (const round of input.roundNames) {
      const c = agg.perRound.get(round) ?? 0;
      const denomR = denom.get(round) ?? 0;
      const rpm = denomR > 0 ? (c / denomR) * 1e6 : 0;
      const wtR = wtCounts.get(round) ?? 0;
      row[`Count_${round}`] = c;
      row[`RPM_${round}`] = rpm;
      row[`Fitness_vs_WT_${round}`] = Math.log2(
        ((c + PSEUDO) / (wtR + PSEUDO)) / ((c0 + PSEUDO) / (wt0 + PSEUDO)),
      );
    }
    rows.push(row);
  }

  // ---- Pass 2: per-round stats columns (skip round 0 — Fitness_vs_WT_0 is
  // identically 0 by construction and Z/p/centered would be degenerate).
  const c0Cache: Record<string, number> = {};
  const wt0 = wtCounts.get(firstRound) ?? 0;
  for (const row of rows) c0Cache[String(row.Variant_AA)] = row[`Count_${firstRound}`] as number;

  for (let i = 1; i < input.roundNames.length; i++) {
    const round = input.roundNames[i]!;
    const wtR = wtCounts.get(round) ?? 0;
    const fitnessCol = `Fitness_vs_WT_${round}`;
    const centeredCol = `Centered_Fitness_${round}`;
    const zCol = `Z_Fitness_${round}`;
    const pCol = `Pval_Fitness_${round}`;
    const qCol = `FDR_q_${round}`;
    const varCol = `Var_Fitness_${round}`;

    // Per-row SE / Z / p / Var (four-term Poisson δ-method).
    const pvals: number[] = [];
    for (const row of rows) {
      const cR = row[`Count_${round}`] as number;
      const c0 = c0Cache[String(row.Variant_AA)] ?? 0;
      const variance = varLog2WtRatio(cR, wtR, c0, wt0, PSEUDO);
      const se = seLog2WtRatio(cR, wtR, c0, wt0, PSEUDO);
      const safeSe = se > 1e-12 ? se : 1e-12;
      const fitness = row[fitnessCol] as number;
      const z = fitness / safeSe;
      const p = twoSidedPvalue(z);
      row[zCol] = z;
      row[pCol] = p;
      row[varCol] = variance;
      pvals.push(p);
    }

    // Library median of Fitness_vs_WT at (site, round) → centered score.
    const fitValues: number[] = [];
    for (const row of rows) fitValues.push(row[fitnessCol] as number);
    const medFit = median(fitValues);
    libraryMedianFitness[`${siteName}:${round}`] = medFit;
    for (const row of rows) {
      row[centeredCol] = (row[fitnessCol] as number) - medFit;
    }

    // BH-FDR per round, scoped within this site.
    const qvals = benjaminiHochberg(pvals);
    for (let r = 0; r < rows.length; r++) {
      rows[r]![qCol] = qvals[r]!;
    }
  }

  // Sort: Centered_Fitness of last round desc (Phase 6.16 — was Fitness_vs_WT;
  // both produce the same ordering since the median offset is a constant per
  // (site, round), but anchoring the sort on the column users will actually
  // see in the CSV keeps the top-N rows match the sort order they expect).
  // Tiebreaker: Variant_AA asc (stable).
  const sortKey = `Centered_Fitness_${lastRound}`;
  rows.sort((a, b) => {
    const fa = (a[sortKey] as number) ?? 0;
    const fb = (b[sortKey] as number) ?? 0;
    if (fb !== fa) return fb - fa;
    return String(a.Variant_AA).localeCompare(String(b.Variant_AA));
  });
  return rows;
}

// --- Haplotype aggregation ------------------------------------------------

function aggregateHaplotypes(
  input: NanoporeAnalyzerInput,
  libraryMedianFitness: Record<string, number>,
): NanoporeAnalyzerRow[] {
  // Collapse joined-DNA → joined-AA, tracking dominant DNA + per-round count.
  // joined_dna = "GCT_TGG" etc., split on "_" to translate each codon.
  const aaMap = new Map<string, AaAgg>();
  for (const round of input.roundNames) {
    const counter = input.haplotypeCounters.get(round);
    if (!counter) continue;
    for (const [joinedDna, count] of counter) {
      const aa = joinedDna.split("_").map(translateDna).join("_");
      let agg = aaMap.get(aa);
      if (!agg) {
        agg = { aa, dnaTotals: new Map(), perRound: new Map() };
        aaMap.set(aa, agg);
      }
      agg.dnaTotals.set(joinedDna, (agg.dnaTotals.get(joinedDna) ?? 0) + count);
      agg.perRound.set(round, (agg.perRound.get(round) ?? 0) + count);
    }
  }

  // RPM denominator = haplotype_passed_qc per round.
  const denom = new Map<string, number>();
  for (const round of input.roundNames) {
    denom.set(round, input.stats.get(round)?.haplotype_passed_qc ?? 0);
  }

  // WT haplotype DNA = joined wtDna of each site (in siteNames order).
  const siteByName = new Map(input.sites.map((s) => [s.name, s] as const));
  const wtJoinedDna = input.siteNames
    .map((n) => siteByName.get(n)?.wtDna ?? "")
    .join("_");
  const wtCounts = new Map<string, number>();
  for (const round of input.roundNames) {
    wtCounts.set(round, input.haplotypeCounters.get(round)?.get(wtJoinedDna) ?? 0);
  }

  const firstRound = input.roundNames[0]!;
  const lastRound = input.roundNames[input.roundNames.length - 1]!;

  // ---- Pass 1: counts + Fitness_vs_WT (Enrich_Global removed in Phase 6.16).
  const rows: NanoporeAnalyzerRow[] = [];
  for (const agg of aaMap.values()) {
    const dominantDna = pickDominant(agg.dnaTotals);
    const row: NanoporeAnalyzerRow = {
      Haplotype_AA: agg.aa,
      Haplotype_DNA: dominantDna,
    };
    const c0 = agg.perRound.get(firstRound) ?? 0;
    const wt0 = wtCounts.get(firstRound) ?? 0;
    for (const round of input.roundNames) {
      const c = agg.perRound.get(round) ?? 0;
      const denomR = denom.get(round) ?? 0;
      const rpm = denomR > 0 ? (c / denomR) * 1e6 : 0;
      const wtR = wtCounts.get(round) ?? 0;
      row[`Count_${round}`] = c;
      row[`RPM_${round}`] = rpm;
      row[`Fitness_vs_WT_${round}`] = Math.log2(
        ((c + PSEUDO) / (wtR + PSEUDO)) / ((c0 + PSEUDO) / (wt0 + PSEUDO)),
      );
    }
    rows.push(row);
  }

  // ---- Pass 2: per-round stats columns (skip round 0).
  const wt0 = wtCounts.get(firstRound) ?? 0;
  for (let i = 1; i < input.roundNames.length; i++) {
    const round = input.roundNames[i]!;
    const wtR = wtCounts.get(round) ?? 0;
    const fitnessCol = `Fitness_vs_WT_${round}`;
    const centeredCol = `Centered_Fitness_${round}`;
    const zCol = `Z_Fitness_${round}`;
    const pCol = `Pval_Fitness_${round}`;
    const qCol = `FDR_q_${round}`;
    const varCol = `Var_Fitness_${round}`;

    const pvals: number[] = [];
    for (const row of rows) {
      const cR = row[`Count_${round}`] as number;
      const c0 = row[`Count_${firstRound}`] as number;
      const variance = varLog2WtRatio(cR, wtR, c0, wt0, PSEUDO);
      const se = seLog2WtRatio(cR, wtR, c0, wt0, PSEUDO);
      const safeSe = se > 1e-12 ? se : 1e-12;
      const fitness = row[fitnessCol] as number;
      const z = fitness / safeSe;
      const p = twoSidedPvalue(z);
      row[zCol] = z;
      row[pCol] = p;
      row[varCol] = variance;
      pvals.push(p);
    }

    const fitValues: number[] = [];
    for (const row of rows) fitValues.push(row[fitnessCol] as number);
    const medFit = median(fitValues);
    // Haplotype median keyed with `__haplotype__:<round>` so it's distinct
    // from per-site medians in the unified libraryMedianFitness record.
    libraryMedianFitness[`__haplotype__:${round}`] = medFit;
    for (const row of rows) {
      row[centeredCol] = (row[fitnessCol] as number) - medFit;
    }

    const qvals = benjaminiHochberg(pvals);
    for (let r = 0; r < rows.length; r++) {
      rows[r]![qCol] = qvals[r]!;
    }
  }

  // Sort by Centered_Fitness of last round desc (Phase 6.16).
  const sortKey = `Centered_Fitness_${lastRound}`;
  rows.sort((a, b) => {
    const fa = (a[sortKey] as number) ?? 0;
    const fb = (b[sortKey] as number) ?? 0;
    if (fb !== fa) return fb - fa;
    return String(a.Haplotype_AA).localeCompare(String(b.Haplotype_AA));
  });
  return rows;
}

// --- Helpers --------------------------------------------------------------

function pickDominant(dnaTotals: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [dna, c] of dnaTotals) {
    if (c > bestCount || (c === bestCount && dna < best)) {
      best = dna;
      bestCount = c;
    }
  }
  return best;
}

// Phase 6.12: dropped Rank_* and GC_Percent columns; the rank is derivable
// from Count_* via a 5-line sort, and GC% from `calculateGc(Dominant_DNA)`.
// Removing them offsets the new statistical columns (Centered_Fitness, Z,
// Pval, NegLog10Pval, FDR_q) so net CSV width grows modestly. The
// `computeRanks` helper used to fill Rank_* is no longer needed.

function buildPerSiteColumns(roundNames: ReadonlyArray<string>): ColumnSpec[] {
  const cols: ColumnSpec[] = [
    { name: "Site", type: "string" },
    { name: "Variant_AA", type: "string" },
    { name: "Dominant_DNA", type: "string" },
  ];
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) cols.push({ name: `RPM_${r}`, type: "float" });
  // Phase 6.16: dropped Enrich_Global_<r> and NegLog10Pval_Fitness_<r>.
  // Centered_Fitness is the canonical fold-change column; raw Fitness_vs_WT
  // and Enrich_Global are recoverable as `Centered_Fitness + libraryMedian`
  // and `log₂((RPM+1)/(RPM₀+1))` respectively. NegLog10Pval is one CSV
  // column away (`−log₁₀(Pval)`). Removing them frees room for Var_Fitness
  // without growing CSV width.
  for (const r of roundNames) cols.push({ name: `Fitness_vs_WT_${r}`, type: "float" });
  // Stats columns skip round 0 — Fitness_vs_WT_0 is identically 0 by
  // construction and the derived Z / p / centered would be degenerate.
  const enrichableRounds = roundNames.slice(1);
  for (const r of enrichableRounds) cols.push({ name: `Centered_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Z_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Pval_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `FDR_q_${r}`, type: "float" });
  // σ² of Fitness_vs_WT (four-term Poisson delta). ML inverse-variance weight
  // = 1/Var_Fitness; the four-term form correctly reflects that the WT
  // denominator is itself a Poisson count (unlike cDNA where the library
  // total is treated as fixed).
  for (const r of enrichableRounds) cols.push({ name: `Var_Fitness_${r}`, type: "float" });
  return cols;
}

function buildHaplotypeColumns(roundNames: ReadonlyArray<string>): ColumnSpec[] {
  const cols: ColumnSpec[] = [
    { name: "Haplotype_AA", type: "string" },
    { name: "Haplotype_DNA", type: "string" },
  ];
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) cols.push({ name: `RPM_${r}`, type: "float" });
  for (const r of roundNames) cols.push({ name: `Fitness_vs_WT_${r}`, type: "float" });
  const enrichableRounds = roundNames.slice(1);
  for (const r of enrichableRounds) cols.push({ name: `Centered_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Z_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Pval_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `FDR_q_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Var_Fitness_${r}`, type: "float" });
  return cols;
}
