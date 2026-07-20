// Statistical-significance helpers for peptide enrichment tests.
//
// For each peptide we model the round-late vs round-early counts as a 2×2
// contingency table:
//
//                 Round_late    Round_early
//   this peptide      a              b
//   all other reads   c              d
//
// H_0 = peptide frequency is unchanged between rounds. Right-tail (one-sided)
// p-value tests for enrichment specifically.
//
// We use a hybrid: Fisher's exact (right-tail) when any cell is small enough
// that the chi-square approximation is unreliable, and a Yates-corrected
// chi-square otherwise. This is the standard pattern in NGS count-stat tools
// (DESeq2, edgeR fall back to similar conditioning for very low counts).
//
// Multiple testing is handled with Benjamini-Hochberg FDR. All implementations
// are pure JS — for ≤ 50k peptides (already capped upstream by csvParse) the
// total work is well below 1 s on commodity hardware.

import type { PeptideRecord } from "./csvParse";
import { log2RpmRatio } from "@cdna/core";

const SMALL_COUNT = 5; // any cell < this → fall back to Fisher's exact

/** Lanczos lgamma. Accurate to ~1e-10 for x > 0. Numerical Recipes 6.1. */
function lgamma(x: number): number {
  if (x <= 0) return Infinity;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += c[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function lchoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** erfc via Abramowitz & Stegun 7.1.26. ~1.5e-7 accuracy across the real
 *  line — more than enough for an FDR threshold of 0.05. */
function erfc(x: number): number {
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.5 * ax);
  const r = t * Math.exp(
    -ax * ax - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 +
    t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 +
    t * 0.17087277))))))))
  );
  return x >= 0 ? r : 2 - r;
}

/** Fisher's exact, right-tail (one-sided), conditional on margins. Sums the
 *  hypergeometric PMF from `a` up to its maximum. Log-space to stay numerically
 *  stable on counts up to ~10⁸. */
function fishersExactRight(a: number, b: number, c: number, d: number): number {
  const n1 = a + b;
  const n2 = c + d;
  const K = a + c;
  const N = n1 + n2;
  if (N === 0 || n1 === 0 || K === 0 || K === N) return 1;
  const kMax = Math.min(K, n1);
  if (a > kMax) return 0;
  const lDenom = lchoose(N, n1);
  let p = 0;
  for (let k = a; k <= kMax; k++) {
    const lp = lchoose(K, k) + lchoose(N - K, n1 - k) - lDenom;
    p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Yates-corrected chi-square (1 dof), one-sided right tail (enrichment). */
function chiSquareYatesRight(a: number, b: number, c: number, d: number): number {
  const N = a + b + c + d;
  const n1 = a + b;
  const n2 = c + d;
  const r1 = a + c;
  const r2 = b + d;
  if (N === 0 || n1 === 0 || n2 === 0 || r1 === 0 || r2 === 0) return 1;
  // Expected count in cell a:
  const Ea = (n1 * r1) / N;
  if (a <= Ea) return 1; // not in the enriched direction → keep H_0
  const numer = Math.abs(a * d - b * c) - N / 2;
  if (numer <= 0) return 1;
  const chisq = (numer * numer * N) / (n1 * n2 * r1 * r2);
  // 1-dof chi-sq survival = erfc(sqrt(chisq/2)); halve for one-sided.
  return 0.5 * erfc(Math.sqrt(chisq / 2));
}

/** Hybrid one-sided enrichment test. */
export function enrichmentPvalue(a: number, b: number, c: number, d: number): number {
  if (a < SMALL_COUNT || b < SMALL_COUNT || c < SMALL_COUNT || d < SMALL_COUNT) {
    return fishersExactRight(a, b, c, d);
  }
  return chiSquareYatesRight(a, b, c, d);
}

/** Benjamini-Hochberg FDR. Returns adjusted p-values in input order. */
export function bhFdr(pvalues: number[]): number[] {
  const n = pvalues.length;
  if (n === 0) return [];
  const order = pvalues
    .map((p, i) => ({ p, i }))
    .sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(n);
  let cummin = 1;
  for (let rank = n; rank >= 1; rank--) {
    const { p, i } = order[rank - 1]!;
    const adj = Math.min(1, p * (n / rank));
    cummin = Math.min(cummin, adj);
    adjusted[i] = cummin;
  }
  return adjusted;
}

export interface EnrichmentResult {
  peptide: string;
  log2FC: number;
  countSrc: number;
  countDest: number;
  pValue: number;
  fdr: number;
}

/** Compute right-tail enrichment p-values + BH-FDR for every peptide.
 *
 *  Pass `nSrc` / `nDest` explicitly (total reads = passed_qc per round). The
 *  upstream `parseEnrichmentMatrix` caller may have truncated the rows for
 *  perf, so summing `rows[i].count[*]` here would underestimate the library
 *  size and inflate every p-value. */
export function computeEnrichmentTests(
  rows: ReadonlyArray<PeptideRecord>,
  srcRound: string,
  destRound: string,
  nSrc: number,
  nDest: number,
  pseudocount: number,
): EnrichmentResult[] {
  if (nSrc === 0 || nDest === 0) return [];

  const pvals = new Array<number>(rows.length);
  const partial: Omit<EnrichmentResult, "fdr">[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const a = r.count[destRound] ?? 0;
    const b = r.count[srcRound] ?? 0;
    const c = nDest - a;
    const d = nSrc - b;
    const p = enrichmentPvalue(a, b, c, d);
    pvals[i] = p;
    // Reuse the analyzer's one canonical score implementation so fallback
    // stepwise plots cannot silently diverge from exported CSV values.
    const log2FC = log2RpmRatio(a, nDest, b, nSrc, pseudocount);
    partial[i] = { peptide: r.peptide, log2FC, countSrc: b, countDest: a, pValue: p };
  }

  const fdrs = bhFdr(pvals);
  const result: EnrichmentResult[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    result[i] = { ...partial[i]!, fdr: fdrs[i]! };
  }
  return result;
}
