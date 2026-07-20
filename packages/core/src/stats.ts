// Small numerical-stats helpers used by both analyzers (cDNA + Nanopore) to
// emit Z, p-value, BH-FDR q-value, and library-centered enrichment columns
// alongside the existing log2 fold-change.
//
// Design choices, kept explicit because each one is a method-choice that
// changes results:
//
//   • Pseudocount is supplied explicitly by the caller in RPM units. The
//     product default is 0.5 RPM; 1.0 RPM remains selectable for historical
//     comparison. No helper has a silent default.
//
//   • Variance uses the Enrich2 Poisson delta method on raw counts. An RPM
//     pseudocount p is converted separately for each library to the
//     count-scale value q = p × N / 1e6. This keeps score and variance in the
//     same units while preserving log2((RPM_dest+p)/(RPM_src+p)).
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
export const READS_PER_MILLION = 1_000_000;
export const DEFAULT_ENRICHMENT_PSEUDOCOUNT = 0.5;
export const LEGACY_ENRICHMENT_PSEUDOCOUNT = 1.0;

/** Reject invalid user/config values at the analysis boundary. */
export function assertValidPseudocount(pseudo: number): void {
  if (!Number.isFinite(pseudo) || pseudo <= 0) {
    throw new Error("Enrichment pseudocount must be a finite number greater than 0.");
  }
}

/** Convert an RPM pseudocount to its count-scale value for one library. */
export function rpmPseudocountAsCount(total: number, pseudoRpm: number): number {
  assertValidPseudocount(pseudoRpm);
  return (pseudoRpm * total) / READS_PER_MILLION;
}

/** RPM-normalized log2 ratio between destination and source.
 *
 *  L = log2[(RPM_dest+p)/(RPM_src+p)]
 */
export function log2RpmRatio(
  cDest: number,
  nDest: number,
  cSrc: number,
  nSrc: number,
  pseudoRpm: number,
): number {
  assertValidPseudocount(pseudoRpm);
  const rpmDest = nDest > 0 ? (cDest / nDest) * READS_PER_MILLION : 0;
  const rpmSrc = nSrc > 0 ? (cSrc / nSrc) * READS_PER_MILLION : 0;
  return Math.log2((rpmDest + pseudoRpm) / (rpmSrc + pseudoRpm));
}

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
export function seLog2Ratio(c1: number, c2: number, pseudo: number): number {
  assertValidPseudocount(pseudo);
  return INV_LN2 * Math.sqrt(1 / (c1 + pseudo) + 1 / (c2 + pseudo));
}

/** σ² of `log2((c1 + p) / (c2 + p))` = SE². Exposed as a dedicated function
 *  because we emit it as a CSV column for ML inverse-variance weighting —
 *  `weight = 1 / σ²`. Mathematically identical to `seLog2Ratio² ` but skips a
 *  redundant `Math.sqrt` per row. */
export function varLog2Ratio(c1: number, c2: number, pseudo: number): number {
  assertValidPseudocount(pseudo);
  return INV_LN2 * INV_LN2 * (1 / (c1 + pseudo) + 1 / (c2 + pseudo));
}

/** Standard error of log2RpmRatio. The RPM pseudocount is converted to a
 *  library-specific count pseudocount before applying Enrich2's four-term
 *  Poisson delta-method variance. */
export function seLog2RpmRatio(
  cDest: number,
  nDest: number,
  cSrc: number,
  nSrc: number,
  pseudoRpm: number,
): number {
  return Math.sqrt(varLog2RpmRatio(cDest, nDest, cSrc, nSrc, pseudoRpm));
}

/** Variance of log2RpmRatio in log2 units. */
export function varLog2RpmRatio(
  cDest: number,
  nDest: number,
  cSrc: number,
  nSrc: number,
  pseudoRpm: number,
): number {
  const qDest = rpmPseudocountAsCount(nDest, pseudoRpm);
  const qSrc = rpmPseudocountAsCount(nSrc, pseudoRpm);
  return (
    INV_LN2 *
    INV_LN2 *
    (
      1 / (cDest + qDest) +
      1 / (nDest + qDest) +
      1 / (cSrc + qSrc) +
      1 / (nSrc + qSrc)
    )
  );
}

/** RPM-normalized variant-vs-reference ratio for the legacy Nanopore view.
 *  Each round uses its own count-scale equivalent of the same RPM
 *  pseudocount, so library depth does not change the smoothing unit. */
export function log2RpmWtRatio(
  cV: number,
  wt: number,
  total: number,
  cV0: number,
  wt0: number,
  total0: number,
  pseudoRpm: number,
): number {
  assertValidPseudocount(pseudoRpm);
  const rpmV = total > 0 ? (cV / total) * READS_PER_MILLION : 0;
  const rpmWt = total > 0 ? (wt / total) * READS_PER_MILLION : 0;
  const rpmV0 = total0 > 0 ? (cV0 / total0) * READS_PER_MILLION : 0;
  const rpmWt0 = total0 > 0 ? (wt0 / total0) * READS_PER_MILLION : 0;
  return Math.log2(
    ((rpmV + pseudoRpm) / (rpmWt + pseudoRpm)) /
    ((rpmV0 + pseudoRpm) / (rpmWt0 + pseudoRpm)),
  );
}

/** Standard error of log2RpmWtRatio. */
export function seLog2RpmWtRatio(
  cV: number,
  wt: number,
  total: number,
  cV0: number,
  wt0: number,
  total0: number,
  pseudoRpm: number,
): number {
  return Math.sqrt(varLog2RpmWtRatio(cV, wt, total, cV0, wt0, total0, pseudoRpm));
}

/** Four-count Enrich2 variance for log2RpmWtRatio in log2 units. */
export function varLog2RpmWtRatio(
  cV: number,
  wt: number,
  total: number,
  cV0: number,
  wt0: number,
  total0: number,
  pseudoRpm: number,
): number {
  const q = rpmPseudocountAsCount(total, pseudoRpm);
  const q0 = rpmPseudocountAsCount(total0, pseudoRpm);
  return (
    INV_LN2 *
    INV_LN2 *
    (1 / (cV + q) + 1 / (wt + q) + 1 / (cV0 + q0) + 1 / (wt0 + q0))
  );
}

/** Standard error of a four-term log2 ratio (Enrich2's L_v with explicit WT):
 *    L = log2((c_v + p)/(wt + p)) − log2((c_v0 + p)/(wt0 + p))
 *  All four counts contribute Poisson variance. */
export function seLog2WtRatio(
  cV: number,
  wt: number,
  cV0: number,
  wt0: number,
  pseudo: number,
): number {
  assertValidPseudocount(pseudo);
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
  pseudo: number,
): number {
  assertValidPseudocount(pseudo);
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
