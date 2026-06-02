// Small numerical-stats helpers used by both analyzers (cDNA + Nanopore) to
// emit Z, p-value, BH-FDR q-value, and library-centered enrichment columns
// alongside the existing log2 fold-change.
//
// Design choices, kept explicit because each one is a method-choice that
// changes results:
//
//   • Pseudocount = 1.0 throughout. Same value the existing log2 columns
//     already use, so SE and the score stay internally consistent.
//
//   • Variance via Poisson delta-method on raw counts. For a log-ratio
//     L = log((c1 + p) / (c2 + p)), Var(L) ≈ 1/(c1+p) + 1/(c2+p) (in nats).
//     Multiply by (1/ln 2)² to get variance in log2 units.
//
//   • Z = score / SE, p = 2·(1 − Φ(|Z|)), two-sided. Wald-type, anti-
//     conservative at very low counts; pseudocount mitigates but doesn't
//     fully fix. Surface this honestly to users via the changelog.
//
//   • FDR: Benjamini-Hochberg, applied per round across all variants in
//     that round (per site for Nanopore). Standard for DMS workflows.
//
//   • Centering: median, not mean. Median is robust against the small
//     number of strong-hit outliers that pull the mean. Caveat: under
//     stringent selection where most variants drop out, the library median
//     itself becomes negative and the centered score over-corrects — we
//     surface the library median in run_stats.json so users can detect
//     this regime.

/** Natural-log → log2 conversion factor. Var(log2 X) = (1/ln 2)² · Var(ln X). */
export const INV_LN2 = 1 / Math.LN2;

/** Cumulative distribution function of the standard normal, computed via the
 *  Abramowitz & Stegun rational approximation to erf (#26.2.17). Max error
 *  ≈ 1.5e-7 for |z| ≤ 6 — more than enough for p-values in the 1e-6..0.5
 *  range we care about. For |z| > 6 we clamp to avoid p=0 from underflow.
 *
 *  Returns Φ(z) = P(Z ≤ z) for a standard normal Z. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  // Symmetry: Φ(z) = 1 − Φ(−z). Work with positive x, then mirror.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // A&S 26.2.17 erf approximation.
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  // y is erf(x) for x ≥ 0. Φ(z) = 0.5 · (1 + sign · erf(|z|/√2)).
  const phi = 0.5 * (1 + sign * y);
  // Clamp to a sane range. Values past ~1e-15 fall below double precision
  // anyway; clamping prevents NaN-from-log in the −log10(p) column.
  if (phi <= 0) return Number.MIN_VALUE;
  if (phi >= 1) return 1 - Number.EPSILON;
  return phi;
}

/** Two-sided p-value from a Z-statistic. Symmetric — sign of z doesn't matter. */
export function twoSidedPvalue(z: number): number {
  if (!Number.isFinite(z)) return Number.isNaN(z) ? Number.NaN : 0;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** −log10(p) with underflow guard. For p == 0 (or sub-MIN_VALUE) returns a
 *  large finite ceiling rather than +Infinity, so the column remains usable
 *  in CSV-rendered volcano plots without special-casing. */
export function negLog10P(p: number): number {
  if (!Number.isFinite(p)) return Number.NaN;
  if (p <= 0) return 300; // floor for p < 1e-300 (double-precision underflow)
  if (p >= 1) return 0;
  return -Math.log10(p);
}

/** Standard error of `log2((c1 + p) / (c2 + p))` under Poisson c1, c2.
 *  Pseudocount must match the pseudocount used in the score formula for
 *  Z = score / SE to be self-consistent. */
export function seLog2Ratio(c1: number, c2: number, pseudo = 1.0): number {
  return INV_LN2 * Math.sqrt(1 / (c1 + pseudo) + 1 / (c2 + pseudo));
}

/** σ² of `log2((c1 + p) / (c2 + p))` = SE². Exposed as a dedicated function
 *  because we emit it as a CSV column for ML inverse-variance weighting —
 *  `weight = 1 / σ²`. Mathematically identical to `seLog2Ratio² ` but skips a
 *  redundant `Math.sqrt` per row. */
export function varLog2Ratio(c1: number, c2: number, pseudo = 1.0): number {
  return INV_LN2 * INV_LN2 * (1 / (c1 + pseudo) + 1 / (c2 + pseudo));
}

/** Standard error of a four-term log2 ratio (Enrich2's L_v with explicit WT):
 *    L = log2((c_v + p)/(wt + p)) − log2((c_v0 + p)/(wt0 + p))
 *  All four counts contribute Poisson variance. */
export function seLog2WtRatio(
  cV: number,
  wt: number,
  cV0: number,
  wt0: number,
  pseudo = 1.0,
): number {
  return (
    INV_LN2 *
    Math.sqrt(
      1 / (cV + pseudo) +
        1 / (wt + pseudo) +
        1 / (cV0 + pseudo) +
        1 / (wt0 + pseudo),
    )
  );
}

/** σ² of the four-term log2 ratio = `seLog2WtRatio²`. ML weight = 1/σ². */
export function varLog2WtRatio(
  cV: number,
  wt: number,
  cV0: number,
  wt0: number,
  pseudo = 1.0,
): number {
  return (
    INV_LN2 *
    INV_LN2 *
    (1 / (cV + pseudo) + 1 / (wt + pseudo) + 1 / (cV0 + pseudo) + 1 / (wt0 + pseudo))
  );
}

/** Median of a finite-valued number array. NaN-tolerant: filters non-finite
 *  values out. Returns 0 for an empty input (so a centered column on an
 *  empty round is well-defined). */
export function median(values: ReadonlyArray<number>): number {
  const sorted: number[] = [];
  for (const v of values) {
    if (Number.isFinite(v)) sorted.push(v);
  }
  if (sorted.length === 0) return 0;
  sorted.sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Benjamini-Hochberg adjusted q-values for an array of raw two-sided
 *  p-values. Returns a parallel array of q-values in the same order as the
 *  input. Non-finite or NaN p-values get NaN q-values.
 *
 *  Algorithm: sort p ascending, walk from the largest downward keeping a
 *  running minimum of (p[i] · m / (i+1)). Cap at 1. */
export function benjaminiHochberg(pvals: ReadonlyArray<number>): number[] {
  const n = pvals.length;
  const out = new Array<number>(n).fill(Number.NaN);
  // Build the list of valid (p, original-index) pairs.
  const valid: { p: number; idx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = pvals[i]!;
    if (Number.isFinite(p) && p >= 0 && p <= 1) valid.push({ p, idx: i });
  }
  const m = valid.length;
  if (m === 0) return out;
  // Sort ascending by p.
  valid.sort((a, b) => a.p - b.p);
  // Walk from largest to smallest applying BH and the monotonicity correction.
  let runningMin = 1.0;
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1; // 1-based
    const q = Math.min(1.0, (valid[k]!.p * m) / rank);
    if (q < runningMin) runningMin = q;
    out[valid[k]!.idx] = runningMin;
  }
  return out;
}
