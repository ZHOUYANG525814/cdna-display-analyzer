// Shared CSV parser for the visualization components. Walks the analyzer's
// Master_Enrichment_Matrix.csv once, returning a typed array of peptide
// records along with the discovered round names. The CSV is already sorted
// (analyzer step) so the first N records are the top-N by global enrichment.
//
// We parse line-by-line via indexOf rather than csv.split("\n") so we never
// allocate the full N-row array of substrings when the caller only wants a
// prefix.

export interface PeptideRecord {
  peptide: string;
  gc: number;
  dominantDna: string;
  /** Round name → raw count for this peptide. */
  count: Record<string, number>;
  /** Round name → reads per million (counts normalised by passed_qc). */
  rpm: Record<string, number>;
  /** Enrich_Step_<roundB>_vs_<roundA>, indexed by the destination round. */
  stepwise: Record<string, number>;
  /** Library-median-centered log₂ fold-change (Centered_Enrich_<dest>_vs_<first>).
   *  This is the canonical fold-change column post-Phase 6.16; the volcano
   *  plot's X-axis reads from here. */
  centered: Record<string, number>;
  /** Analyzer-side Wald p-value (Pval_Enrich_<dest>_vs_<first>). Lets the
   *  volcano render without recomputing Fisher's exact on the main thread. */
  pval: Record<string, number>;
  /** Analyzer-side BH-adjusted q-value (FDR_q_<dest>_vs_<first>). */
  fdr: Record<string, number>;
  /** σ² of the log₂ fold-change (Var_Enrich_<dest>_vs_<first>). Surfaced for
   *  downstream ML inverse-variance weighting (`weight = 1/Var`). */
  variance: Record<string, number>;
}

export interface ParsedMatrix {
  rows: PeptideRecord[];
  /** Round names extracted from the column headers, in input order. */
  roundNames: string[];
}

/** Walk the CSV up to `limit` data rows (or to end if limit omitted). */
export function parseEnrichmentMatrix(csv: string, limit?: number): ParsedMatrix {
  const empty: ParsedMatrix = { rows: [], roundNames: [] };
  if (!csv) return empty;

  const headerEnd = csv.indexOf("\n");
  if (headerEnd === -1) return empty;
  const headers = csv.slice(0, headerEnd).split(",");

  const pepCol = headers.indexOf("Peptide_Seq");
  const gcCol = headers.indexOf("GC_Percent");
  const dnaCol = headers.indexOf("Dominant_DNA_Seq");

  // Column-name maps for the per-round series so we don't re-scan headers
  // for every row.
  const countCols: { round: string; idx: number }[] = [];
  const rpmCols: { round: string; idx: number }[] = [];
  const stepwiseCols: { dest: string; idx: number }[] = [];
  const centeredCols: { dest: string; idx: number }[] = [];
  const varCols: { dest: string; idx: number }[] = [];
  const roundNamesSet = new Set<string>();

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (h.startsWith("Count_")) {
      const round = h.slice("Count_".length);
      countCols.push({ round, idx: i });
      roundNamesSet.add(round);
    } else if (h.startsWith("RPM_")) {
      const round = h.slice("RPM_".length);
      rpmCols.push({ round, idx: i });
      roundNamesSet.add(round);
    } else if (h.startsWith("Enrich_Step_")) {
      // Header pattern: Enrich_Step_<dest>_vs_<src>. We key by dest.
      // (Phase 6.16.3: was incorrectly looking for "Enrich_Stepwise_" which
      // doesn't match the analyzer's actual column name — the scatter's
      // stepwise tooltip always read undefined and rendered 0.)
      const rest = h.slice("Enrich_Step_".length);
      const sepIdx = rest.indexOf("_vs_");
      const dest = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
      stepwiseCols.push({ dest, idx: i });
    } else if (h.startsWith("Centered_Enrich_")) {
      const rest = h.slice("Centered_Enrich_".length);
      const sepIdx = rest.indexOf("_vs_");
      const dest = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
      centeredCols.push({ dest, idx: i });
    } else if (h.startsWith("Var_Enrich_")) {
      const rest = h.slice("Var_Enrich_".length);
      const sepIdx = rest.indexOf("_vs_");
      const dest = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
      varCols.push({ dest, idx: i });
    }
  }

  const roundNames = Array.from(roundNamesSet);

  const rows: PeptideRecord[] = [];
  let lineStart = headerEnd + 1;
  while (limit === undefined || rows.length < limit) {
    const lineEnd = csv.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? csv.length : lineEnd;
    if (end <= lineStart) {
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
      continue;
    }
    const cells = csv.slice(lineStart, end).split(",");
    const rec: PeptideRecord = {
      peptide: cells[pepCol] ?? "",
      gc: Number(cells[gcCol] ?? "0"),
      dominantDna: cells[dnaCol] ?? "",
      count: {},
      rpm: {},
      stepwise: {},
      centered: {},
      pval: {},
      fdr: {},
      variance: {},
    };
    for (const { round, idx } of countCols) {
      rec.count[round] = Number(cells[idx] ?? "0");
    }
    for (const { round, idx } of rpmCols) {
      rec.rpm[round] = Number(cells[idx] ?? "0");
    }
    for (const { dest, idx } of stepwiseCols) {
      const v = cells[idx];
      if (v != null && v !== "") rec.stepwise[dest] = Number(v);
    }
    for (const { dest, idx } of centeredCols) {
      const v = cells[idx];
      if (v != null && v !== "") rec.centered[dest] = Number(v);
    }
    for (const { dest, idx } of varCols) {
      const v = cells[idx];
      if (v != null && v !== "") rec.variance[dest] = Number(v);
    }
    rows.push(rec);
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return { rows, roundNames };
}

export interface PerRoundCounts {
  /** Round name → sorted-descending array of per-peptide counts. Reservoir-
   *  capped at COUNTS_CAP_PER_ROUND entries (see streamParseEnrichmentBlob);
   *  for libraries with more unique peptides than the cap, this is a uniform
   *  random sample of the full distribution. Use `nByRound` to recover the
   *  true library size when scaling absolute ranks for display. */
  countsByRound: Record<string, number[]>;
  /** Round name → total reads passing QC (= sum of counts; the TRUE total,
   *  unaffected by reservoir sampling). Same value RPM normalisation uses. */
  totalsByRound: Record<string, number>;
  /** Round name → number of distinct peptides observed with count > 0 (the
   *  TRUE peptide-distinct count, unaffected by sampling). Lets rank-abundance
   *  scale the x-axis to absolute rank rather than sample rank. */
  nByRound: Record<string, number>;
  /** Round names in CSV column order. */
  roundNames: string[];
}

/** Streaming pass over the analyzer CSV that pulls *only* the per-round Count
 *  columns into compact number arrays — no PeptideRecord objects, no row cap.
 *  Used by viz components that need to see the full per-round distribution
 *  (rank-abundance, count histogram) without being biased by the matrix sort
 *  + top-N cap that `parseEnrichmentMatrix` uses for the per-peptide UI.
 *
 *  Memory: O(unique peptides × rounds) numbers. For a 500k-peptide library
 *  with 4 rounds that's ~16 MB — fine on commodity hardware. */
export function parsePerRoundCounts(csv: string): PerRoundCounts {
  const empty: PerRoundCounts = {
    countsByRound: {},
    totalsByRound: {},
    nByRound: {},
    roundNames: [],
  };
  if (!csv) return empty;

  const headerEnd = csv.indexOf("\n");
  if (headerEnd === -1) return empty;
  const headers = csv.slice(0, headerEnd).split(",");

  const countCols: { round: string; idx: number }[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (h.startsWith("Count_")) {
      countCols.push({ round: h.slice("Count_".length), idx: i });
    }
  }
  if (countCols.length === 0) return empty;

  const countsByRound: Record<string, number[]> = {};
  const totalsByRound: Record<string, number> = {};
  const nByRound: Record<string, number> = {};
  for (const { round } of countCols) {
    countsByRound[round] = [];
    totalsByRound[round] = 0;
    nByRound[round] = 0;
  }

  const maxIdx = countCols.reduce((m, c) => Math.max(m, c.idx), 0);
  const csvLen = csv.length;
  let lineStart = headerEnd + 1;
  while (lineStart < csvLen) {
    const lineEnd = csv.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? csvLen : lineEnd;
    if (end <= lineStart) {
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
      continue;
    }
    // Walk commas manually — only collect the cells we actually need. This
    // avoids allocating an N-element array per row when N can be 15+.
    const cellStarts = new Array<number>(maxIdx + 2);
    cellStarts[0] = lineStart;
    let col = 1;
    for (let i = lineStart; i < end && col <= maxIdx + 1; i++) {
      if (csv.charCodeAt(i) === 44) { // ','
        cellStarts[col++] = i + 1;
      }
    }
    cellStarts[col] = end + 1;

    for (const { round, idx } of countCols) {
      const s = cellStarts[idx];
      const e = cellStarts[idx + 1];
      if (s == null || e == null) continue;
      // e is the position *after* the comma → real cell end is e - 1.
      const v = Number(csv.slice(s, e - 1));
      if (Number.isFinite(v) && v > 0) {
        countsByRound[round]!.push(v);
        totalsByRound[round]! += v;
        nByRound[round]!++;
      }
    }

    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  for (const round of Object.keys(countsByRound)) {
    countsByRound[round]!.sort((a, b) => b - a);
  }

  return {
    countsByRound,
    totalsByRound,
    nByRound,
    roundNames: countCols.map((c) => c.round),
  };
}

// --------------------------------------------------------------------------
// Streaming Blob parser
// --------------------------------------------------------------------------
//
// The string-input helpers above require the whole CSV materialized as one
// JS String. On multi-GB FASTQ runs the analyzer's CSV exceeds V8's
// ~537 MB string-length ceiling, and `await blob.text()` throws
// `RangeError: Invalid string length` before we can ever call them.
//
// `streamParseEnrichmentBlob` reads the Blob via `blob.stream()` + a streaming
// TextDecoder, processes records line-by-line with a carry buffer for
// partial-line bytes at chunk boundaries, and fills all three downstream
// accumulators (top peptides head, capped matrix, per-round counts) in a
// single pass. Nothing larger than a few KB is ever held as one string.

export interface TopRow {
  peptide: string;
  gc: number;
  rpm: Record<string, number>;
  sortValue: number;
}

export interface TopPreview {
  rows: TopRow[];
  totalRows: number;
  sortColumn: string;
  roundColumns: string[];
}

export interface StreamCsvResult {
  matrix: ParsedMatrix;
  perRoundCounts: PerRoundCounts;
  top: TopPreview;
  /** Bottom-N rows by the sort column (= most-depleted variants since the
   *  analyzer pre-sorts Centered_Enrich desc). Phase 6.16.3: makes the
   *  depleted half of the library visible in the dashboard so users don't
   *  mistake "Excel can't show > 1M rows" for "CSV has no depleted variants
   *  for ML training". */
  bottom: TopPreview;
  /** Total data rows seen (not capped by matrixLimit / topLimit). */
  totalRows: number;
}

export interface StreamCsvOptions {
  /** Cap matrix.rows at this many rows (analyzer pre-sorts so the head is
   *  the most-enriched). Default 50_000. */
  matrixLimit?: number;
  /** Cap top.rows at this many rows. Default 20. */
  topLimit?: number;
  /** Optional AbortSignal — aborting interrupts the stream read. */
  signal?: AbortSignal;
}

const EMPTY_RESULT: StreamCsvResult = {
  matrix: { rows: [], roundNames: [] },
  perRoundCounts: { countsByRound: {}, totalsByRound: {}, nByRound: {}, roundNames: [] },
  top: { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] },
  bottom: { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] },
  totalRows: 0,
};

/** Reservoir cap on per-round count arrays.
 *
 *  Phase 6.15.1: dropped 100k → 30k. Downstream consumers either log-bin
 *  the counts (CountHistogram: 24 bins) or log-space-subsample them
 *  (RankAbundance: 200 points), so 30k is statistically equivalent to
 *  100k or full population for both viz. At 30k the `Array.sort` inside
 *  `giniCoefficient` and the log10/min/max scan inside CountHistogram run
 *  in <50 ms per round — eliminates the visible blocking on first-mount.
 *
 *  The TRUE library size (sum of all counts, number of distinct peptides)
 *  is still tracked exactly via `totalsByRound` / `nByRound`, so downstream
 *  consumers that need absolute rank or total can scale up from the sample. */
const COUNTS_CAP_PER_ROUND = 30_000;

/** Hierarchical-sampling K: number of top-by-count peptides per round that
 *  we ALWAYS keep deterministically (in addition to the reservoir sample).
 *
 *  Phase 6.16.1: at 3.6M unique peptides reservoir-sampled to 30k, the
 *  effective sampling rate is ~0.83% — the top-20 highest-count peptides
 *  have ~0.17 expected hits in a uniform reservoir, i.e. almost certainly
 *  missing. That leaves the right tail of the count histogram empty even
 *  though those peptides exist. Tracking top-K deterministically alongside
 *  the reservoir guarantees the histogram's right tail and the rank-
 *  abundance plot's head are always rendered. K matches the Top-20 table
 *  so the rendered head of each chart corresponds to those rows exactly. */
const COUNTS_TOP_K_PER_ROUND = 20;

export async function streamParseEnrichmentBlob(
  blob: Blob,
  opts: StreamCsvOptions = {},
): Promise<StreamCsvResult> {
  const matrixLimit = opts.matrixLimit ?? 50_000;
  const topLimit = opts.topLimit ?? 20;

  if (blob.size === 0) return EMPTY_RESULT;

  const reader = blob.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let carry = "";

  // Lazily filled once we've parsed the header line.
  let header: HeaderPlan | null = null;
  let totalRows = 0;

  const matrixRows: PeptideRecord[] = [];
  const topRows: TopRow[] = [];
  const countsByRound: Record<string, number[]> = {};
  const totalsByRound: Record<string, number> = {};
  const nByRound: Record<string, number> = {};
  // Per-round top-K-by-count: sorted-ascending min-array of size ≤ K.
  // arr[0] is the running min; we replace it when a larger count arrives.
  const topKByRound: Record<string, number[]> = {};
  // Sliding window of the last `topLimit` raw lines. Since the analyzer pre-
  // sorts the CSV desc by Centered_Enrich, the last N lines == bottom-N by
  // enrichment == the most-depleted variants. Storing raw lines (not parsed
  // records) keeps the steady-state overhead at ~20 short strings; parse
  // happens once at end-of-stream.
  const bottomLineWindow: string[] = [];

  try {
    while (true) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      carry += decoder.decode(value, { stream: true });
      // Drain every complete line currently in `carry`. The unfinished tail
      // (everything past the last "\n") stays in `carry` for the next chunk.
      let nlIdx = carry.indexOf("\n");
      while (nlIdx !== -1) {
        const line = carry.slice(0, nlIdx);
        carry = carry.slice(nlIdx + 1);
        if (line.length > 0) {
          if (header === null) {
            header = planHeader(line);
            if (!header) return EMPTY_RESULT;
            for (const r of header.countRounds) {
              countsByRound[r] = [];
              totalsByRound[r] = 0;
              nByRound[r] = 0;
              topKByRound[r] = [];
            }
          } else {
            consumeRow(line, header, {
              matrixLimit,
              topLimit,
              matrixRows,
              topRows,
              countsByRound,
              totalsByRound,
              nByRound,
              topKByRound,
            });
            // Maintain sliding window of last `topLimit` lines for bottom-N.
            bottomLineWindow.push(line);
            if (bottomLineWindow.length > topLimit) bottomLineWindow.shift();
            totalRows++;
          }
        }
        nlIdx = carry.indexOf("\n");
      }
    }
    // Flush the decoder + any trailing line without "\n".
    carry += decoder.decode();
    if (carry.length > 0 && header !== null) {
      consumeRow(carry, header, {
        matrixLimit,
        topLimit,
        matrixRows,
        topRows,
        countsByRound,
        totalsByRound,
        nByRound,
        topKByRound,
      });
      bottomLineWindow.push(carry);
      if (bottomLineWindow.length > topLimit) bottomLineWindow.shift();
      totalRows++;
    }
  } finally {
    reader.releaseLock();
  }

  if (!header) return EMPTY_RESULT;

  // Hierarchical merge: union top-K-by-count with the reservoir sample, then
  // sort desc. Duplicates are fine for downstream binning + log-spaced
  // sampling (a single observed count can legitimately appear multiple
  // times if multiple peptides have the same Count_<r>). The result is no
  // longer a perfectly uniform sample, but downstream consumers care about
  // shape + tail visibility more than perfect statistical purity here.
  for (const r of header.countRounds) {
    const topK = topKByRound[r]!;
    const reservoir = countsByRound[r]!;
    for (const v of topK) reservoir.push(v);
    reservoir.sort((a, b) => b - a);
  }

  // Parse the bottom window once — same TopRow shape so the UI can render it
  // through the existing table component. With analyzer pre-sort desc, these
  // are the most-depleted variants. The window list is in the order they
  // arrived (oldest → newest in the CSV stream); reverse so the most-depleted
  // (last-in-CSV) appears first in the table.
  const bottomRows: TopRow[] = [];
  if (header.topSortColumnIdx >= 0) {
    for (let i = bottomLineWindow.length - 1; i >= 0; i--) {
      const line = bottomLineWindow[i]!;
      const cells = line.split(",");
      const rpm: Record<string, number> = {};
      for (const c of header.rpmCols) rpm[c.name] = Number(cells[c.idx] ?? "0");
      bottomRows.push({
        peptide: cells[header.pepCol] ?? "",
        gc: header.gcCol >= 0 ? Number(cells[header.gcCol] ?? "0") : 0,
        rpm,
        sortValue: Number(cells[header.topSortColumnIdx] ?? "0"),
      });
    }
  }

  return {
    matrix: { rows: matrixRows, roundNames: header.matrixRoundNames },
    perRoundCounts: {
      countsByRound,
      totalsByRound,
      nByRound,
      roundNames: header.countRounds.slice(),
    },
    top: {
      rows: topRows,
      totalRows,
      sortColumn: header.topSortColumnName,
      roundColumns: header.rpmCols.map((c) => c.name),
    },
    bottom: {
      rows: bottomRows,
      totalRows,
      sortColumn: header.topSortColumnName,
      roundColumns: header.rpmCols.map((c) => c.name),
    },
    totalRows,
  };
}

// Compact representation of which columns we care about, all pre-located by
// header index so the per-row hot loop just reads cells[idx].
interface HeaderPlan {
  pepCol: number;
  gcCol: number;
  dnaCol: number;
  countCols: { round: string; idx: number }[];
  rpmCols: { name: string; round: string; idx: number }[];
  stepwiseCols: { dest: string; idx: number }[];
  /** Centered_Enrich_<dest>_vs_<first> — canonical fold-change column. */
  centeredCols: { dest: string; idx: number }[];
  /** Pval_Enrich_<dest>_vs_<first>. */
  pvalCols: { dest: string; idx: number }[];
  /** FDR_q_<dest>_vs_<first>. */
  fdrCols: { dest: string; idx: number }[];
  /** Var_Enrich_<dest>_vs_<first> — σ² for downstream ML weighting. */
  varCols: { dest: string; idx: number }[];
  matrixRoundNames: string[];
  countRounds: string[];
  // Sort column for the top-N preview.
  topSortColumnName: string;
  topSortColumnIdx: number;
  // The cell index up to which we need to capture in the per-row split.
  maxIdxNeeded: number;
}

function planHeader(headerLine: string): HeaderPlan | null {
  const headers = headerLine.split(",");
  const pepCol = headers.indexOf("Peptide_Seq");
  // GC_Percent was dropped from the CSV in Phase 6.12 (derivable from
  // Dominant_DNA_Seq). The streaming parser must NOT bail when it's absent —
  // otherwise the whole result is empty and the dashboard hides every
  // visualization that depends on the matrix. Tolerate gcCol === -1 and let
  // downstream consumers treat gc as 0 / NaN.
  const gcCol = headers.indexOf("GC_Percent"); // may be -1 post-Phase 6.12
  const dnaCol = headers.indexOf("Dominant_DNA_Seq");
  if (pepCol === -1) return null;

  const countCols: HeaderPlan["countCols"] = [];
  const rpmCols: HeaderPlan["rpmCols"] = [];
  const stepwiseCols: HeaderPlan["stepwiseCols"] = [];
  const centeredCols: HeaderPlan["centeredCols"] = [];
  const pvalCols: HeaderPlan["pvalCols"] = [];
  const fdrCols: HeaderPlan["fdrCols"] = [];
  const varCols: HeaderPlan["varCols"] = [];
  const roundNamesSet = new Set<string>();

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (h.startsWith("Count_")) {
      const round = h.slice("Count_".length);
      countCols.push({ round, idx: i });
      roundNamesSet.add(round);
    } else if (h.startsWith("RPM_")) {
      const round = h.slice("RPM_".length);
      rpmCols.push({ name: h, round, idx: i });
      roundNamesSet.add(round);
    } else if (h.startsWith("Enrich_Step_")) {
      // Phase 6.16.3 fix — see parseEnrichmentMatrix for context.
      const rest = h.slice("Enrich_Step_".length);
      const sepIdx = rest.indexOf("_vs_");
      stepwiseCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    } else if (h.startsWith("Centered_Enrich_")) {
      const rest = h.slice("Centered_Enrich_".length);
      const sepIdx = rest.indexOf("_vs_");
      centeredCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    } else if (h.startsWith("Pval_Enrich_")) {
      const rest = h.slice("Pval_Enrich_".length);
      const sepIdx = rest.indexOf("_vs_");
      pvalCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    } else if (h.startsWith("FDR_q_")) {
      const rest = h.slice("FDR_q_".length);
      const sepIdx = rest.indexOf("_vs_");
      fdrCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    } else if (h.startsWith("Var_Enrich_")) {
      const rest = h.slice("Var_Enrich_".length);
      const sepIdx = rest.indexOf("_vs_");
      varCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    }
  }

  const matrixRoundNames = Array.from(roundNamesSet);

  // Sort column for top-N: prefer the last Centered_Enrich_* (the analyzer's
  // primary sort key post-Phase 6.16), else fall back to the first RPM
  // column for single-round runs.
  let topSortColumnName = "";
  let topSortColumnIdx = -1;
  if (centeredCols.length > 0) {
    for (let i = headers.length - 1; i >= 0; i--) {
      const h = headers[i]!;
      if (h.startsWith("Centered_Enrich_")) {
        topSortColumnName = h;
        topSortColumnIdx = i;
        break;
      }
    }
  } else if (rpmCols.length > 0) {
    topSortColumnName = rpmCols[0]!.name;
    topSortColumnIdx = rpmCols[0]!.idx;
  }

  let maxIdxNeeded = Math.max(pepCol, gcCol, dnaCol, topSortColumnIdx);
  for (const c of countCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of rpmCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of stepwiseCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of centeredCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of pvalCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of fdrCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);
  for (const c of varCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);

  return {
    pepCol,
    gcCol,
    dnaCol,
    countCols,
    rpmCols,
    stepwiseCols,
    centeredCols,
    pvalCols,
    fdrCols,
    varCols,
    matrixRoundNames,
    countRounds: countCols.map((c) => c.round),
    topSortColumnName,
    topSortColumnIdx,
    maxIdxNeeded,
  };
}

interface RowSinkState {
  matrixLimit: number;
  topLimit: number;
  matrixRows: PeptideRecord[];
  topRows: TopRow[];
  countsByRound: Record<string, number[]>;
  totalsByRound: Record<string, number>;
  nByRound: Record<string, number>;
  /** Per-round top-K-by-count, kept sorted ascending so arr[0] is the
   *  running min (cheapest comparison point for the "should this replace
   *  the smallest of the top K?" test). */
  topKByRound: Record<string, number[]>;
}

function consumeRow(line: string, plan: HeaderPlan, sink: RowSinkState): void {
  // Walk commas manually and collect cell boundaries. Cheaper than split()
  // because we only need up to plan.maxIdxNeeded cells, not the full row.
  const cellStarts: number[] = new Array(plan.maxIdxNeeded + 2);
  cellStarts[0] = 0;
  let col = 1;
  const len = line.length;
  for (let i = 0; i < len && col <= plan.maxIdxNeeded + 1; i++) {
    if (line.charCodeAt(i) === 44 /* ',' */) {
      cellStarts[col++] = i + 1;
    }
  }
  cellStarts[col] = len + 1;

  const cell = (idx: number): string => {
    if (idx < 0) return "";
    const s = cellStarts[idx];
    const e = cellStarts[idx + 1];
    if (s == null || e == null) return "";
    return line.slice(s, e - 1);
  };

  // (1) per-round counts — totals + distinct-peptide counts are tracked
  // exactly; the count arrays themselves are HIERARCHICALLY sampled:
  //   - top-K-by-count kept deterministically  (Phase 6.16.1: K = 20)
  //   - reservoir sample of size COUNTS_CAP_PER_ROUND for everyone else
  // The merge happens after streaming. This guarantees the rank-abundance
  // head and the count-histogram right tail render correctly even when the
  // reservoir miss rate for rare-but-extreme variants is high.
  for (const { round, idx } of plan.countCols) {
    const v = Number(cell(idx));
    if (Number.isFinite(v) && v > 0) {
      sink.totalsByRound[round]! += v;
      const seen = sink.nByRound[round]! + 1;
      sink.nByRound[round] = seen;
      // Reservoir branch (uniform random sample of the full distribution).
      const arr = sink.countsByRound[round]!;
      if (arr.length < COUNTS_CAP_PER_ROUND) {
        arr.push(v);
      } else {
        const j = Math.floor(Math.random() * seen);
        if (j < COUNTS_CAP_PER_ROUND) arr[j] = v;
      }
      // Top-K-by-count branch (deterministic head). K is small (20) so
      // insertion-sort is cheaper than a full heap. arr[0] is the running
      // min, so we only do work when v could replace it.
      const topK = sink.topKByRound[round]!;
      if (topK.length < COUNTS_TOP_K_PER_ROUND) {
        topK.push(v);
        topK.sort((a, b) => a - b);
      } else if (v > topK[0]!) {
        topK[0] = v;
        topK.sort((a, b) => a - b);
      }
    }
  }

  // (2) matrix.rows — capped.
  if (sink.matrixRows.length < sink.matrixLimit) {
    const rec: PeptideRecord = {
      peptide: cell(plan.pepCol),
      gc: Number(cell(plan.gcCol)),
      dominantDna: cell(plan.dnaCol),
      count: {},
      rpm: {},
      stepwise: {},
      centered: {},
      pval: {},
      fdr: {},
      variance: {},
    };
    for (const c of plan.countCols) rec.count[c.round] = Number(cell(c.idx));
    for (const c of plan.rpmCols) rec.rpm[c.round] = Number(cell(c.idx));
    for (const c of plan.stepwiseCols) {
      const v = cell(c.idx);
      if (v !== "") rec.stepwise[c.dest] = Number(v);
    }
    for (const c of plan.centeredCols) {
      const v = cell(c.idx);
      if (v !== "") rec.centered[c.dest] = Number(v);
    }
    for (const c of plan.pvalCols) {
      const v = cell(c.idx);
      if (v !== "") rec.pval[c.dest] = Number(v);
    }
    for (const c of plan.fdrCols) {
      const v = cell(c.idx);
      if (v !== "") rec.fdr[c.dest] = Number(v);
    }
    for (const c of plan.varCols) {
      const v = cell(c.idx);
      if (v !== "") rec.variance[c.dest] = Number(v);
    }
    sink.matrixRows.push(rec);
  }

  // (3) top.rows — capped (analyzer is pre-sorted, so head = top).
  if (sink.topRows.length < sink.topLimit && plan.topSortColumnIdx >= 0) {
    const rpm: Record<string, number> = {};
    for (const c of plan.rpmCols) rpm[c.name] = Number(cell(c.idx));
    sink.topRows.push({
      peptide: cell(plan.pepCol),
      gc: Number(cell(plan.gcCol)),
      rpm,
      sortValue: Number(cell(plan.topSortColumnIdx)),
    });
  }
}
