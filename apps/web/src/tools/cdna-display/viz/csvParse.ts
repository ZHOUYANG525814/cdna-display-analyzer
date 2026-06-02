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
  /** Enrich_Stepwise_<roundB>_vs_<roundA>, indexed by the destination round. */
  stepwise: Record<string, number>;
  /** Enrich_Global_<roundN>_vs_<round0>, indexed by the destination round. */
  global: Record<string, number>;
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
  const globalCols: { dest: string; idx: number }[] = [];
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
    } else if (h.startsWith("Enrich_Stepwise_")) {
      // Header pattern: Enrich_Stepwise_<dest>_vs_<src>. We key by dest.
      const rest = h.slice("Enrich_Stepwise_".length);
      const sepIdx = rest.indexOf("_vs_");
      const dest = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
      stepwiseCols.push({ dest, idx: i });
    } else if (h.startsWith("Enrich_Global_")) {
      const rest = h.slice("Enrich_Global_".length);
      const sepIdx = rest.indexOf("_vs_");
      const dest = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
      globalCols.push({ dest, idx: i });
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
      global: {},
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
    for (const { dest, idx } of globalCols) {
      const v = cells[idx];
      if (v != null && v !== "") rec.global[dest] = Number(v);
    }
    rows.push(rec);
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return { rows, roundNames };
}

export interface PerRoundCounts {
  /** Round name → sorted-descending array of per-peptide counts. Length = number
   *  of distinct peptides observed in that round (peptides with count 0 are
   *  excluded). */
  countsByRound: Record<string, number[]>;
  /** Round name → total reads passing QC (= sum of counts). This is the same
   *  value RPM normalisation uses upstream. */
  totalsByRound: Record<string, number>;
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
  const empty: PerRoundCounts = { countsByRound: {}, totalsByRound: {}, roundNames: [] };
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
  for (const { round } of countCols) {
    countsByRound[round] = [];
    totalsByRound[round] = 0;
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
  perRoundCounts: { countsByRound: {}, totalsByRound: {}, roundNames: [] },
  top: { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] },
  totalRows: 0,
};

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
            }
          } else {
            consumeRow(line, header, {
              matrixLimit,
              topLimit,
              matrixRows,
              topRows,
              countsByRound,
              totalsByRound,
            });
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
      });
      totalRows++;
    }
  } finally {
    reader.releaseLock();
  }

  if (!header) return EMPTY_RESULT;

  // Sort per-round counts desc, matching the legacy parsePerRoundCounts shape.
  for (const r of header.countRounds) {
    countsByRound[r]!.sort((a, b) => b - a);
  }

  return {
    matrix: { rows: matrixRows, roundNames: header.matrixRoundNames },
    perRoundCounts: {
      countsByRound,
      totalsByRound,
      roundNames: header.countRounds.slice(),
    },
    top: {
      rows: topRows,
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
  globalCols: { dest: string; idx: number }[];
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
  const globalCols: HeaderPlan["globalCols"] = [];
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
    } else if (h.startsWith("Enrich_Stepwise_")) {
      const rest = h.slice("Enrich_Stepwise_".length);
      const sepIdx = rest.indexOf("_vs_");
      stepwiseCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    } else if (h.startsWith("Enrich_Global_")) {
      const rest = h.slice("Enrich_Global_".length);
      const sepIdx = rest.indexOf("_vs_");
      globalCols.push({ dest: sepIdx === -1 ? rest : rest.slice(0, sepIdx), idx: i });
    }
  }

  const matrixRoundNames = Array.from(roundNamesSet);

  // Sort column for top-N: prefer the last Enrich_Global_*, else the first
  // RPM column. Same selection as the legacy parseTopPeptides.
  let topSortColumnName = "";
  let topSortColumnIdx = -1;
  if (globalCols.length > 0) {
    // Manual reverse scan keeps lib target unconstrained (Array.findLast is ES2023).
    for (let i = headers.length - 1; i >= 0; i--) {
      const h = headers[i]!;
      if (h.startsWith("Enrich_Global_")) {
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
  for (const c of globalCols) maxIdxNeeded = Math.max(maxIdxNeeded, c.idx);

  return {
    pepCol,
    gcCol,
    dnaCol,
    countCols,
    rpmCols,
    stepwiseCols,
    globalCols,
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

  // (1) per-round counts — always tallied so the rank-abundance / count-
  // histogram cover the full library, not just the head.
  for (const { round, idx } of plan.countCols) {
    const v = Number(cell(idx));
    if (Number.isFinite(v) && v > 0) {
      sink.countsByRound[round]!.push(v);
      sink.totalsByRound[round]! += v;
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
      global: {},
    };
    for (const c of plan.countCols) rec.count[c.round] = Number(cell(c.idx));
    for (const c of plan.rpmCols) rec.rpm[c.round] = Number(cell(c.idx));
    for (const c of plan.stepwiseCols) {
      const v = cell(c.idx);
      if (v !== "") rec.stepwise[c.dest] = Number(v);
    }
    for (const c of plan.globalCols) {
      const v = cell(c.idx);
      if (v !== "") rec.global[c.dest] = Number(v);
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
