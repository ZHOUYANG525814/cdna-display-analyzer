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
//   - Targeted enrichment uses log2((RPM_round+p)/(RPM_round_0+p)).
//   - Legacy Fitness_vs_WT uses the same RPM pseudocount on the variant and
//     reference-state RPM values in both rounds.
//
// Sort order: per-site rows sort by Site (input order), then within each
// site by Fitness_vs_WT_<lastRound> desc with Variant_AA asc as the
// tiebreaker (stable sort). Haplotype rows sort the same way over the
// joined-codon AA string.

import { translateDna } from "./dna.js";
import { serializeCsv, type AnalyzerRow, type ColumnSpec, type RowValue } from "./analyzer.js";
import type { NanoporeRoundStats } from "./nanopore.js";
import {
  assertValidPseudocount,
  benjaminiHochberg,
  log2RpmRatio,
  log2RpmWtRatio,
  median,
  seLog2RpmRatio,
  seLog2RpmWtRatio,
  twoSidedPvalue,
  varLog2RpmRatio,
  varLog2RpmWtRatio,
} from "./stats.js";

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
  /** Minimum first-round count required for Z/p/BH inference. Fitness is
   * retained below the threshold, but inferential fields are blank. */
  minBaselineCountToScore?: number;
  /** Targeted full-reference mode uses biological target labels (R233) and
   * self-describing combination keys (R233W|A304V). Legacy SSM keeps its
   * historical Site/Haplotype columns. */
  displayMode?: "legacy" | "targeted-aa";
  /** Explicit RPM-unit pseudocount for auditability. Default is 0.5 RPM. */
  pseudocount: number;
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
  assertValidPseudocount(input.pseudocount);
  // Accumulator: keyed by `${siteName}:${round}` for per-site medians and
  // `__haplotype__:${round}` for haplotype medians. Pipeline lifts this into
  // run_stats.json so users can spot a systematic library shift.
  const libraryMedianFitness: Record<string, number> = {};

  const perSiteRows: NanoporeAnalyzerRow[] = [];
  for (const siteName of input.siteNames) {
    perSiteRows.push(...aggregatePerSite(input, siteName, libraryMedianFitness));
  }

  const perSiteColumns = buildPerSiteColumns(input.roundNames, input.minBaselineCountToScore != null, input.displayMode);
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
    haplotypeColumns = buildHaplotypeColumns(input.roundNames, input.minBaselineCountToScore != null, input.displayMode);
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

  // WT count per round uses the same amino-acid aggregation level as each
  // variant row. Synonymous codons encoding the reference amino acid belong
  // to the WT cohort; mixing AA-level variants with an exact-DNA WT
  // denominator makes the WT row non-zero and biases every fitness value.
  const site = input.sites.find((s) => s.name === siteName);
  const wtDna = site?.wtDna ?? "";
  const wtAa = translateDna(wtDna);
  const wtCounts = new Map<string, number>();
  for (const round of input.roundNames) {
    const siteDna = input.dnaCounters.get(round)?.get(siteName);
    let count = 0;
    for (const [dna, n] of siteDna ?? []) {
      if (input.displayMode === "targeted-aa" ? translateDna(dna) === wtAa : dna === wtDna) count += n;
    }
    wtCounts.set(round, count);
  }

  const firstRound = input.roundNames[0]!;
  const lastRound = input.roundNames[input.roundNames.length - 1]!;

  // ---- Pass 1: per-variant counts + per-round Fitness_vs_WT.
  //   Enrich_Global column removed in Phase 6.16 (recoverable as
  //   log₂((RPM+p)/(RPM₀+p)) if needed).
  const rows: NanoporeAnalyzerRow[] = [];
  for (const agg of aaMap.values()) {
    const dominantDna = pickDominant(agg.dnaTotals);
    const row: NanoporeAnalyzerRow = {
      [input.displayMode === "targeted-aa" ? "Target" : "Site"]: siteName,
      Variant_AA: agg.aa,
      Dominant_DNA: dominantDna,
    };
    const c0 = agg.perRound.get(firstRound) ?? 0;
    const wt0 = wtCounts.get(firstRound) ?? 0;
    const n0 = denom.get(firstRound) ?? 0;
    for (const round of input.roundNames) {
      const c = agg.perRound.get(round) ?? 0;
      const denomR = denom.get(round) ?? 0;
      const rpm = denomR > 0 ? (c / denomR) * 1e6 : 0;
      const wtR = wtCounts.get(round) ?? 0;
      row[`Count_${round}`] = c;
      row[`RPM_${round}`] = rpm;
      if (input.displayMode !== "targeted-aa") {
        row[`Fitness_vs_WT_${round}`] = log2RpmWtRatio(
          c, wtR, denomR, c0, wt0, n0, input.pseudocount,
        );
      }
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
    const targeted = input.displayMode === "targeted-aa";
    const fitnessCol = targeted ? `Enrichment_${round}_vs_${firstRound}` : `Fitness_vs_WT_${round}`;
    const centeredCol = targeted ? `Centered_Enrichment_${round}_vs_${firstRound}` : `Centered_Fitness_${round}`;
    const zCol = targeted ? `Z_Enrichment_${round}_vs_${firstRound}` : `Z_Fitness_${round}`;
    const pCol = targeted ? `Pval_Enrichment_${round}_vs_${firstRound}` : `Pval_Fitness_${round}`;
    const qCol = targeted ? `FDR_q_${round}_vs_${firstRound}` : `FDR_q_${round}`;
    const varCol = targeted ? `Var_Enrichment_${round}_vs_${firstRound}` : `Var_Fitness_${round}`;

    // Per-row SE / Z / p / Var. Targeted enrichment uses the same two-count
    // Poisson delta method as NGS; legacy SSM retains its four-count WT ratio.
    const pvals: number[] = [];
    const eligibleIndices: number[] = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const cR = row[`Count_${round}`] as number;
      const c0 = c0Cache[String(row.Variant_AA)] ?? 0;
      const nR = denom.get(round) ?? 0;
      const n0 = denom.get(firstRound) ?? 0;
      const score = targeted
        ? log2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : row[fitnessCol] as number;
      if (targeted) row[fitnessCol] = score;
      const eligible = c0 >= (input.minBaselineCountToScore ?? 0);
      if (input.minBaselineCountToScore != null) row.Score_Eligible = eligible ? "yes" : "no";
      if (!eligible) {
        row[zCol] = "";
        row[pCol] = "";
        row[varCol] = "";
        continue;
      }
      const variance = targeted
        ? varLog2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : varLog2RpmWtRatio(cR, wtR, nR, c0, wt0, n0, input.pseudocount);
      const se = targeted
        ? seLog2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : seLog2RpmWtRatio(cR, wtR, nR, c0, wt0, n0, input.pseudocount);
      const safeSe = se > 1e-12 ? se : 1e-12;
      const z = score / safeSe;
      const p = twoSidedPvalue(z);
      row[zCol] = z;
      row[pCol] = p;
      row[varCol] = variance;
      pvals.push(p);
      eligibleIndices.push(rowIndex);
    }

    // Library median of Fitness_vs_WT at (site, round) → centered score.
    const fitValues: number[] = [];
    for (const row of rows) {
      if (input.minBaselineCountToScore == null || row.Score_Eligible === "yes") fitValues.push(row[fitnessCol] as number);
    }
    const medFit = median(fitValues);
    libraryMedianFitness[targeted ? `${siteName}:Enrichment_${round}_vs_${firstRound}` : `${siteName}:${round}`] = medFit;
    for (const row of rows) {
      row[centeredCol] = (row[fitnessCol] as number) - medFit;
    }

    // BH-FDR per round, scoped within this site.
    const qvals = benjaminiHochberg(pvals);
    for (const row of rows) row[qCol] = "";
    for (let r = 0; r < eligibleIndices.length; r++) rows[eligibleIndices[r]!]![qCol] = qvals[r]!;
  }

  // Sort: Centered_Fitness of last round desc (Phase 6.16 — was Fitness_vs_WT;
  // both produce the same ordering since the median offset is a constant per
  // (site, round), but anchoring the sort on the column users will actually
  // see in the CSV keeps the top-N rows match the sort order they expect).
  // Tiebreaker: Variant_AA asc (stable).
  const sortKey = input.displayMode === "targeted-aa"
    ? `Centered_Enrichment_${lastRound}_vs_${firstRound}`
    : `Centered_Fitness_${lastRound}`;
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

  // WT combination is aggregated at the same AA-combination level as the
  // variant rows, including synonymous DNA haplotypes.
  const siteByName = new Map(input.sites.map((s) => [s.name, s] as const));
  const wtJoinedDna = input.siteNames
    .map((n) => siteByName.get(n)?.wtDna ?? "")
    .join("_");
  const wtJoinedAa = wtJoinedDna.split("_").map(translateDna).join("_");
  const wtCounts = new Map<string, number>();
  for (const round of input.roundNames) {
    let count = 0;
    for (const [dna, n] of input.haplotypeCounters.get(round) ?? []) {
      const isReference = input.displayMode === "targeted-aa"
        ? dna.split("_").map(translateDna).join("_") === wtJoinedAa
        : dna === wtJoinedDna;
      if (isReference) count += n;
    }
    wtCounts.set(round, count);
  }

  const firstRound = input.roundNames[0]!;
  const lastRound = input.roundNames[input.roundNames.length - 1]!;

  // ---- Pass 1: counts + Fitness_vs_WT (Enrich_Global removed in Phase 6.16).
  const rows: NanoporeAnalyzerRow[] = [];
  for (const agg of aaMap.values()) {
    const dominantDna = pickDominant(agg.dnaTotals);
    const targeted = input.displayMode === "targeted-aa";
    const row: NanoporeAnalyzerRow = targeted ? {
      Combination_AA: formatMutationCombination(input.siteNames, agg.aa),
      Combination_DNA: dominantDna.replaceAll("_", "|"),
    } : { Haplotype_AA: agg.aa, Haplotype_DNA: dominantDna };
    const c0 = agg.perRound.get(firstRound) ?? 0;
    const wt0 = wtCounts.get(firstRound) ?? 0;
    const n0 = denom.get(firstRound) ?? 0;
    for (const round of input.roundNames) {
      const c = agg.perRound.get(round) ?? 0;
      const denomR = denom.get(round) ?? 0;
      const rpm = denomR > 0 ? (c / denomR) * 1e6 : 0;
      const wtR = wtCounts.get(round) ?? 0;
      row[`Count_${round}`] = c;
      row[`RPM_${round}`] = rpm;
      if (input.displayMode !== "targeted-aa") {
        row[`Fitness_vs_WT_${round}`] = log2RpmWtRatio(
          c, wtR, denomR, c0, wt0, n0, input.pseudocount,
        );
      }
    }
    rows.push(row);
  }

  // ---- Pass 2: per-round stats columns (skip round 0).
  const wt0 = wtCounts.get(firstRound) ?? 0;
  for (let i = 1; i < input.roundNames.length; i++) {
    const round = input.roundNames[i]!;
    const wtR = wtCounts.get(round) ?? 0;
    const targeted = input.displayMode === "targeted-aa";
    const fitnessCol = targeted ? `Enrichment_${round}_vs_${firstRound}` : `Fitness_vs_WT_${round}`;
    const centeredCol = targeted ? `Centered_Enrichment_${round}_vs_${firstRound}` : `Centered_Fitness_${round}`;
    const zCol = targeted ? `Z_Enrichment_${round}_vs_${firstRound}` : `Z_Fitness_${round}`;
    const pCol = targeted ? `Pval_Enrichment_${round}_vs_${firstRound}` : `Pval_Fitness_${round}`;
    const qCol = targeted ? `FDR_q_${round}_vs_${firstRound}` : `FDR_q_${round}`;
    const varCol = targeted ? `Var_Enrichment_${round}_vs_${firstRound}` : `Var_Fitness_${round}`;

    const pvals: number[] = [];
    const eligibleIndices: number[] = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const cR = row[`Count_${round}`] as number;
      const c0 = row[`Count_${firstRound}`] as number;
      const nR = denom.get(round) ?? 0;
      const n0 = denom.get(firstRound) ?? 0;
      const score = targeted
        ? log2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : row[fitnessCol] as number;
      if (targeted) row[fitnessCol] = score;
      const eligible = c0 >= (input.minBaselineCountToScore ?? 0);
      if (input.minBaselineCountToScore != null) row.Score_Eligible = eligible ? "yes" : "no";
      if (!eligible) {
        row[zCol] = "";
        row[pCol] = "";
        row[varCol] = "";
        continue;
      }
      const variance = targeted
        ? varLog2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : varLog2RpmWtRatio(cR, wtR, nR, c0, wt0, n0, input.pseudocount);
      const se = targeted
        ? seLog2RpmRatio(cR, nR, c0, n0, input.pseudocount)
        : seLog2RpmWtRatio(cR, wtR, nR, c0, wt0, n0, input.pseudocount);
      const safeSe = se > 1e-12 ? se : 1e-12;
      const z = score / safeSe;
      const p = twoSidedPvalue(z);
      row[zCol] = z;
      row[pCol] = p;
      row[varCol] = variance;
      pvals.push(p);
      eligibleIndices.push(rowIndex);
    }

    const fitValues: number[] = [];
    for (const row of rows) {
      if (input.minBaselineCountToScore == null || row.Score_Eligible === "yes") fitValues.push(row[fitnessCol] as number);
    }
    const medFit = median(fitValues);
    // Targeted output uses combination terminology all the way through the
    // audit JSON. Legacy SSM retains its historical haplotype key.
    const family = input.displayMode === "targeted-aa" ? "__combination__" : "__haplotype__";
    libraryMedianFitness[targeted ? `${family}:Enrichment_${round}_vs_${firstRound}` : `${family}:${round}`] = medFit;
    for (const row of rows) {
      row[centeredCol] = (row[fitnessCol] as number) - medFit;
    }

    const qvals = benjaminiHochberg(pvals);
    for (const row of rows) row[qCol] = "";
    for (let r = 0; r < eligibleIndices.length; r++) rows[eligibleIndices[r]!]![qCol] = qvals[r]!;
  }

  // Sort by Centered_Fitness of last round desc (Phase 6.16).
  const sortKey = input.displayMode === "targeted-aa"
    ? `Centered_Enrichment_${lastRound}_vs_${firstRound}`
    : `Centered_Fitness_${lastRound}`;
  rows.sort((a, b) => {
    const fa = (a[sortKey] as number) ?? 0;
    const fb = (b[sortKey] as number) ?? 0;
    if (fb !== fa) return fb - fa;
    const key = input.displayMode === "targeted-aa" ? "Combination_AA" : "Haplotype_AA";
    return String(a[key]).localeCompare(String(b[key]));
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

function buildPerSiteColumns(roundNames: ReadonlyArray<string>, includeEligibility: boolean, displayMode: NanoporeAnalyzerInput["displayMode"] = "legacy"): ColumnSpec[] {
  const cols: ColumnSpec[] = [
    { name: displayMode === "targeted-aa" ? "Target" : "Site", type: "string" },
    { name: "Variant_AA", type: "string" },
    { name: "Dominant_DNA", type: "string" },
  ];
  if (includeEligibility) cols.push({ name: "Score_Eligible", type: "string" });
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) cols.push({ name: `RPM_${r}`, type: "float" });
  if (displayMode === "targeted-aa") {
    const first = roundNames[0]!;
    for (const r of roundNames.slice(1)) cols.push({ name: `Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Centered_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Z_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Pval_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `FDR_q_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Var_Enrichment_${r}_vs_${first}`, type: "float" });
    return cols;
  }
  // Phase 6.16: dropped Enrich_Global_<r> and NegLog10Pval_Fitness_<r>.
  // Centered_Fitness is the canonical fold-change column; raw Fitness_vs_WT
  // and Enrich_Global are recoverable as `Centered_Fitness + libraryMedian`
  // and the configured RPM+p ratio respectively.
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

function buildHaplotypeColumns(roundNames: ReadonlyArray<string>, includeEligibility: boolean, displayMode: NanoporeAnalyzerInput["displayMode"] = "legacy"): ColumnSpec[] {
  const cols: ColumnSpec[] = displayMode === "targeted-aa" ? [
    { name: "Combination_AA", type: "string" }, { name: "Combination_DNA", type: "string" },
  ] : [{ name: "Haplotype_AA", type: "string" }, { name: "Haplotype_DNA", type: "string" }];
  if (includeEligibility) cols.push({ name: "Score_Eligible", type: "string" });
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) cols.push({ name: `RPM_${r}`, type: "float" });
  if (displayMode === "targeted-aa") {
    const first = roundNames[0]!;
    for (const r of roundNames.slice(1)) cols.push({ name: `Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Centered_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Z_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Pval_Enrichment_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `FDR_q_${r}_vs_${first}`, type: "float" });
    for (const r of roundNames.slice(1)) cols.push({ name: `Var_Enrichment_${r}_vs_${first}`, type: "float" });
    return cols;
  }
  for (const r of roundNames) cols.push({ name: `Fitness_vs_WT_${r}`, type: "float" });
  const enrichableRounds = roundNames.slice(1);
  for (const r of enrichableRounds) cols.push({ name: `Centered_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Z_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Pval_Fitness_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `FDR_q_${r}`, type: "float" });
  for (const r of enrichableRounds) cols.push({ name: `Var_Fitness_${r}`, type: "float" });
  return cols;
}

function formatMutationCombination(targets: ReadonlyArray<string>, joinedAa: string): string {
  const aminoAcids = joinedAa.split("_");
  return targets.map((target, index) => {
    const observed = aminoAcids[index] ?? "X";
    const match = /^([A-Z*])(\d+)$/.exec(target);
    return match ? `${match[1]}${match[2]}${observed}` : `${target}:${observed}`;
  }).join("|");
}
