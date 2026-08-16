// Port of 01_scripts/analysis_engine.py EnrichmentAnalyzer. Same DNA → AA
// collapse, same RPM / rank / log2 enrichment math, same stable-sort tiebreaker
// (Peptide_Seq ascending) as the patched Python side.
//
// CSV formatting mirrors pandas.DataFrame.to_csv defaults:
//   - integer-typed columns rendered without decimal
//   - float-typed columns rendered via Python repr() semantics
//     (JS Number.toString matches for finite doubles; we add a trailing ".0"
//     for integer-valued floats to match pandas' "1.0" / "0.0" output)
//   - booleans capitalized: True / False
//   - NaN → empty cell, +Inf → "inf", -Inf → "-inf"

import { translateDna } from "./dna.js";
import type { RoundStats } from "./demultiplex.js";
import {
  assertValidPseudocount,
  benjaminiHochberg,
  log2RpmRatio,
  median,
  seLog2RpmRatio,
  twoSidedPvalue,
  varLog2RpmRatio,
} from "./stats.js";

export interface AnalyzerInput {
  roundNames: ReadonlyArray<string>;
  // round name → (DNA sequence → occurrence count)
  dnaCounters: ReadonlyMap<string, ReadonlyMap<string, number>>;
  // round name → demultiplex stats (only passed_qc is read; it's the RPM denominator)
  stats: ReadonlyMap<string, RoundStats>;
  /** Explicit analysis pseudocount. Product default is 0.5; 1.0 remains
   *  available for sensitivity and historical comparison. */
  pseudocount: number;
  /** Optional production serialization chunk size. Omit to retain the public
   * one-line-per-part contract used by small callers and parity tests. */
  csvChunkChars?: number;
}

export type RowValue = string | number | boolean;

export interface AnalyzerRow {
  Peptide_Seq: string;
  Dominant_DNA_Seq: string;
  [key: string]: RowValue;
  // Count_*, RPM_*, Enrich_Step_*, Centered_Enrich_*,
  // Z_Enrich_*, Pval_Enrich_*, FDR_q_*, Var_Enrich_*
  // (Rank_*, GC_Percent, Present_In_All dropped in Phase 6.12.
  //  Enrich_Global_* and NegLog10Pval_* dropped in Phase 6.16:
  //   - Enrich_Global is recoverable as `Centered_Enrich + libraryMedian`
  //   - NegLog10Pval is trivially `−log10(Pval)`
  //   Both were removable to make room for Var_Enrich without growing the CSV.)
}

export interface AnalyzerOutput {
  rows: AnalyzerRow[];
  /** Number of scientific rows. Production compact mode deliberately leaves
   * `rows` empty and exposes only this bounded scalar plus CSV chunks. */
  rowCount: number;
  columns: ReadonlyArray<ColumnSpec>;
  /** Library-wide median of the raw log₂((RPM+p)/(RPM₀+p)) ratio for
   *  each non-first round — the centering offset that produces Centered_Enrich.
   *  Exposed so the Methods card / run_stats.json can flag rounds where the
   *  median sits far from zero (which signals a stringent-selection regime
   *  where Centered_Enrich over-corrects). Keys are diagnostic labels of the
   *  form "Enrich_Global_<curr>_vs_<first>" — they refer to the underlying
   *  fold-change quantity even though the column itself is no longer emitted
   *  (Phase 6.16). */
  libraryMedianEnrich: Record<string, number>;
  /** CSV emitted as bounded chunks, each terminated with "\n". Splitting
   *  the output avoids materializing the entire CSV as one
   *  JS String, which would otherwise hit V8's ~537 MB string-length ceiling
   *  on multi-GB FASTQ inputs. Callers wanting the joined string can do
   *  `csvParts.join("")`; callers wanting a downloadable artifact can pass
   *  the array straight to `new Blob(csvParts, …)` — Blob accepts a list of
   *  strings and never concatenates them into one JS String. */
  csvParts: string[];
  /** Per-comparison FDR counts computed before compact columns are released. */
  fdrHitCounts: Record<string, { q05: number; q01: number }>;
}

type ColType = "string" | "int" | "float" | "bool";

export interface ColumnSpec {
  name: string;
  type: ColType;
}

export function buildColumnSpecs(roundNames: ReadonlyArray<string>): ColumnSpec[] {
  const cols: ColumnSpec[] = [
    { name: "Peptide_Seq", type: "string" },
    { name: "Dominant_DNA_Seq", type: "string" },
  ];
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) cols.push({ name: `RPM_${r}`, type: "float" });
  // Stepwise log2 fold-change (round_i vs round_{i-1}). Kept per user request
  // — Enrich_Step is occasionally useful for "did anything jump between R2 and
  // R3" diagnostics even when Enrich_Global is the headline number.
  for (let i = 1; i < roundNames.length; i++) {
    const prev = roundNames[i - 1];
    const curr = roundNames[i];
    cols.push({ name: `Enrich_Step_${curr}_vs_${prev}`, type: "float" });
  }
  const first = roundNames[0];
  if (first !== undefined) {
    // Centered_Enrich is now the canonical fold-change column (Phase 6.16).
    // Raw Enrich_Global is recoverable as `Centered_Enrich + libraryMedian`,
    // and the library median is surfaced in run_stats.json + MethodsCard.
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `Centered_Enrich_${curr}_vs_${first}`, type: "float" });
    }
    // Inference triple (Z / Pval / FDR_q) is intentionally computed against
    // the raw log2 fold-change. Centering changes the numerator and therefore
    // must not be substituted into Z. NegLog10Pval dropped — `−log10(Pval)` is one CSV column
    // away from any consumer who needs it.
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `Z_Enrich_${curr}_vs_${first}`, type: "float" });
    }
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `Pval_Enrich_${curr}_vs_${first}`, type: "float" });
    }
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `FDR_q_${curr}_vs_${first}`, type: "float" });
    }
    // σ² of the log₂ fold-change (Phase 6.16). Downstream ML uses 1/Var as
    // the inverse-variance training weight; rows with rare variants get
    // less weight because their fold-change estimate has larger σ².
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `Var_Enrich_${curr}_vs_${first}`, type: "float" });
    }
  }
  // Removed in Phase 6.12 (strictly derivable):
  //   Rank_<r> · GC_Percent · Present_In_All
  // Removed in Phase 6.16 (recoverable from kept columns, freed room for Var):
  //   Enrich_Global_<r>_vs_<first> · NegLog10Pval_Enrich_<r>_vs_<first>
  return cols;
}

interface AaRecord {
  counts: Map<string, number>;          // round name → total count
  dnaFreq: Map<string, number>;         // DNA seq → count (for dominant pick + GC%)
}

export function runAnalyzer(input: AnalyzerInput): AnalyzerOutput | null {
  const { roundNames, dnaCounters, stats, pseudocount } = input;
  assertValidPseudocount(pseudocount);

  // 1. Collapse DNA → AA across all rounds. Iteration order: roundNames as
  //    given, then dnaCounter Map insertion order (which mirrors Python's
  //    Counter / dict iteration). This determines the order of AA records,
  //    which doesn't affect output (we sort at the end) but determines tie-
  //    break for the dominant-DNA selection (first-seen wins on count tie).
  const aaRecords = new Map<string, AaRecord>();
  for (const rnd of roundNames) {
    const counter = dnaCounters.get(rnd);
    if (!counter) continue;
    for (const [dna, count] of counter) {
      const aa = translateDna(dna);
      let rec = aaRecords.get(aa);
      if (!rec) {
        rec = { counts: new Map(), dnaFreq: new Map() };
        for (const r of roundNames) rec.counts.set(r, 0);
        aaRecords.set(aa, rec);
      }
      rec.counts.set(rnd, rec.counts.get(rnd)! + count);
      rec.dnaFreq.set(dna, (rec.dnaFreq.get(dna) ?? 0) + count);
    }
  }

  if (aaRecords.size === 0) return null;

  // 2. Build rows with Peptide_Seq, Dominant_DNA_Seq, GC_Percent, Count_*.
  const rows: AnalyzerRow[] = [];
  for (const [aa, rec] of aaRecords) {
    let domDna = "";
    let domCount = -1;
    for (const [dna, c] of rec.dnaFreq) {
      // A lexical tie-break makes the scientific output independent of FASTQ
      // shard order while preserving the highest-total-count definition.
      if (c > domCount || (c === domCount && (domDna === "" || dna < domDna))) {
        domCount = c;
        domDna = dna;
      }
    }
    const row: AnalyzerRow = {
      Peptide_Seq: aa,
      Dominant_DNA_Seq: domDna,
    };
    for (const rnd of roundNames) {
      row[`Count_${rnd}`] = rec.counts.get(rnd)!;
    }
    rows.push(row);
  }

  // The DNA→AA aggregation maps can be very large. Rows now own every value
  // needed by the statistical passes, so release nested map storage before
  // allocating enrichment/FDR scratch arrays and CSV chunks.
  for (const record of aaRecords.values()) {
    record.counts.clear();
    record.dnaFreq.clear();
  }
  aaRecords.clear();

  // 3. RPM (per million of passed_qc).
  for (const rnd of roundNames) {
    const totalValid = stats.get(rnd)?.passed_qc ?? 0;
    for (const row of rows) {
      const c = row[`Count_${rnd}`] as number;
      row[`RPM_${rnd}`] = totalValid > 0 ? (c / totalValid) * 1e6 : 0.0;
    }
  }

  // 4. Enrichment: RPM-normalized ratio, stepwise then global. Pseudocount
  // is expressed in RPM so its meaning is stable across library depths.
  for (let i = 1; i < roundNames.length; i++) {
    const prev = roundNames[i - 1]!;
    const curr = roundNames[i]!;
    const col = `Enrich_Step_${curr}_vs_${prev}`;
    const nPrev = stats.get(prev)?.passed_qc ?? 0;
    const nCurr = stats.get(curr)?.passed_qc ?? 0;
    for (const row of rows) {
      const cCurr = row[`Count_${curr}`] as number;
      const cPrev = row[`Count_${prev}`] as number;
      row[col] = log2RpmRatio(cCurr, nCurr, cPrev, nPrev, pseudocount);
    }
  }
  const first = roundNames[0];
  const libraryMedianEnrich: Record<string, number> = {};
  if (first !== undefined) {
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i]!;
      // Key kept as `Enrich_Global_<curr>_vs_<first>` for continuity with the
      // run_stats.json schema + MethodsCard label. The COLUMN by that name is
      // no longer emitted in the CSV (Phase 6.16); this record describes "the
      // median of the underlying log₂ fold-change for this round vs first".
      const medianKey = `Enrich_Global_${curr}_vs_${first}`;
      const centeredCol = `Centered_Enrich_${curr}_vs_${first}`;
      const zCol = `Z_Enrich_${curr}_vs_${first}`;
      const pCol = `Pval_Enrich_${curr}_vs_${first}`;
      const qCol = `FDR_q_${curr}_vs_${first}`;
      const varCol = `Var_Enrich_${curr}_vs_${first}`;

      // First pass: raw log₂ fold-change (held in a scratch array, NOT a
      // column), Z, Pval, Var. Centered_Enrich needs the library median
      // across all variants, which we compute after this pass.
      const rawEnrich: number[] = new Array(rows.length);
      const pvals: number[] = new Array(rows.length);
      const nCurr = stats.get(curr)?.passed_qc ?? 0;
      const nFirst = stats.get(first)?.passed_qc ?? 0;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        const cCurr = row[`Count_${curr}`] as number;
        const cFirst = row[`Count_${first}`] as number;
        const enrich = log2RpmRatio(cCurr, nCurr, cFirst, nFirst, pseudocount);
        const variance = varLog2RpmRatio(cCurr, nCurr, cFirst, nFirst, pseudocount);
        const se = seLog2RpmRatio(cCurr, nCurr, cFirst, nFirst, pseudocount);
        // SE ≈ 0 implies overwhelming evidence (huge counts). Pick a tiny
        // floor instead of dividing by 0; Z stays large but finite.
        const safeSe = se > 1e-12 ? se : 1e-12;
        const z = enrich / safeSe;
        const p = twoSidedPvalue(z);
        rawEnrich[r] = enrich;
        row[zCol] = z;
        row[pCol] = p;
        row[varCol] = variance;
        pvals[r] = p;
      }

      // Library median of the raw log₂ fold-change → centered score.
      const medEnrich = median(rawEnrich);
      libraryMedianEnrich[medianKey] = medEnrich;
      for (let r = 0; r < rows.length; r++) {
        rows[r]![centeredCol] = rawEnrich[r]! - medEnrich;
      }

      // BH-FDR across all variants for this round's p-values.
      const qvals = benjaminiHochberg(pvals);
      for (let r = 0; r < rows.length; r++) {
        rows[r]![qCol] = qvals[r]!;
      }
    }
  }

  // 6. Stable sort by primary enrichment desc, secondary Peptide_Seq asc.
  //    Phase 6.16: sort key switched from Enrich_Global (deleted) to
  //    Centered_Enrich (the surviving canonical fold-change column).
  let sortCol: string;
  if (roundNames.length > 1) {
    sortCol = `Centered_Enrich_${roundNames[roundNames.length - 1]}_vs_${roundNames[0]}`;
  } else {
    sortCol = `RPM_${roundNames[0]}`;
  }
  rows.sort((x, y) => {
    const a = x[sortCol] as number;
    const b = y[sortCol] as number;
    if (a > b) return -1;
    if (a < b) return 1;
    // Tiebreaker: Peptide_Seq ascending (lexicographic, byte-equivalent).
    if (x.Peptide_Seq < y.Peptide_Seq) return -1;
    if (x.Peptide_Seq > y.Peptide_Seq) return 1;
    return 0;
  });

  const columns = buildColumnSpecs(roundNames);
  const csvParts = input.csvChunkChars
    ? serializeCsvChunked(rows, columns, input.csvChunkChars)
    : serializeCsv(rows, columns);
  return {
    rows,
    rowCount: rows.length,
    columns,
    csvParts,
    libraryMedianEnrich,
    fdrHitCounts: summarizeFdrHits(rows, roundNames),
  };
}

/** Production analyzer that never materializes one dynamic object per
 * peptide. Scientific values live in dense parallel arrays and are emitted
 * through a stable sort index directly into bounded CSV chunks. */
export function runAnalyzerCompact(input: AnalyzerInput): AnalyzerOutput | null {
  const { roundNames, dnaCounters, stats, pseudocount } = input;
  assertValidPseudocount(pseudocount);

  interface CompactAaRecord {
    counts: Float64Array;
    dnaFreq: Map<string, number>;
  }
  const roundIndex = new Map(roundNames.map((name, index) => [name, index]));
  const records = new Map<string, CompactAaRecord>();
  for (const round of roundNames) {
    const index = roundIndex.get(round)!;
    const counter = dnaCounters.get(round);
    if (!counter) continue;
    for (const [dna, count] of counter) {
      const peptide = translateDna(dna);
      let record = records.get(peptide);
      if (!record) {
        record = { counts: new Float64Array(roundNames.length), dnaFreq: new Map() };
        records.set(peptide, record);
      }
      record.counts[index]! += count;
      record.dnaFreq.set(dna, (record.dnaFreq.get(dna) ?? 0) + count);
    }
  }
  if (records.size === 0) return null;

  const rowCount = records.size;
  const peptides = new Array<string>(rowCount);
  const dominantDna = new Array<string>(rowCount);
  const counts = roundNames.map(() => new Float64Array(rowCount));
  let rowIndex = 0;
  for (const [peptide, record] of records) {
    peptides[rowIndex] = peptide;
    let dominant = "";
    let dominantCount = -1;
    for (const [dna, count] of record.dnaFreq) {
      if (count > dominantCount || (count === dominantCount && (dominant === "" || dna < dominant))) {
        dominant = dna;
        dominantCount = count;
      }
    }
    dominantDna[rowIndex] = dominant;
    for (let round = 0; round < roundNames.length; round++) {
      counts[round]![rowIndex] = record.counts[round]!;
    }
    record.dnaFreq.clear();
    rowIndex++;
  }
  records.clear();

  type DenseValues = string[] | Float64Array | number[];
  const values = new Map<string, DenseValues>();
  values.set("Peptide_Seq", peptides);
  values.set("Dominant_DNA_Seq", dominantDna);
  for (let round = 0; round < roundNames.length; round++) {
    values.set(`Count_${roundNames[round]}`, counts[round]!);
  }

  const rpms = roundNames.map(() => new Float64Array(rowCount));
  for (let round = 0; round < roundNames.length; round++) {
    const total = stats.get(roundNames[round]!)?.passed_qc ?? 0;
    const rpm = rpms[round]!;
    const count = counts[round]!;
    if (total > 0) {
      for (let row = 0; row < rowCount; row++) rpm[row] = count[row]! / total * 1e6;
    }
    values.set(`RPM_${roundNames[round]}`, rpm);
  }

  for (let round = 1; round < roundNames.length; round++) {
    const previousName = roundNames[round - 1]!;
    const currentName = roundNames[round]!;
    const previousTotal = stats.get(previousName)?.passed_qc ?? 0;
    const currentTotal = stats.get(currentName)?.passed_qc ?? 0;
    const output = new Float64Array(rowCount);
    for (let row = 0; row < rowCount; row++) {
      output[row] = log2RpmRatio(
        counts[round]![row]!, currentTotal,
        counts[round - 1]![row]!, previousTotal,
        pseudocount,
      );
    }
    values.set(`Enrich_Step_${currentName}_vs_${previousName}`, output);
  }

  const libraryMedianEnrich: Record<string, number> = {};
  const fdrHitCounts: Record<string, { q05: number; q01: number }> = {};
  const firstName = roundNames[0];
  if (firstName !== undefined) {
    const firstTotal = stats.get(firstName)?.passed_qc ?? 0;
    for (let round = 1; round < roundNames.length; round++) {
      const currentName = roundNames[round]!;
      const currentTotal = stats.get(currentName)?.passed_qc ?? 0;
      const raw = new Array<number>(rowCount);
      const centered = new Float64Array(rowCount);
      const zValues = new Float64Array(rowCount);
      const pValues = new Array<number>(rowCount);
      const variances = new Float64Array(rowCount);
      for (let row = 0; row < rowCount; row++) {
        const currentCount = counts[round]![row]!;
        const firstCount = counts[0]![row]!;
        const enrich = log2RpmRatio(currentCount, currentTotal, firstCount, firstTotal, pseudocount);
        const variance = varLog2RpmRatio(currentCount, currentTotal, firstCount, firstTotal, pseudocount);
        const standardError = seLog2RpmRatio(currentCount, currentTotal, firstCount, firstTotal, pseudocount);
        const z = enrich / (standardError > 1e-12 ? standardError : 1e-12);
        const p = twoSidedPvalue(z);
        raw[row] = enrich;
        zValues[row] = z;
        pValues[row] = p;
        variances[row] = variance;
      }
      const medianKey = `Enrich_Global_${currentName}_vs_${firstName}`;
      const medianEnrich = median(raw);
      libraryMedianEnrich[medianKey] = medianEnrich;
      for (let row = 0; row < rowCount; row++) centered[row] = raw[row]! - medianEnrich;
      const qValues = benjaminiHochberg(pValues);
      const qColumn = `FDR_q_${currentName}_vs_${firstName}`;
      let q05 = 0;
      let q01 = 0;
      for (const q of qValues) {
        if (!Number.isFinite(q)) continue;
        if (q < 0.05) q05++;
        if (q < 0.01) q01++;
      }
      fdrHitCounts[qColumn] = { q05, q01 };
      values.set(`Centered_Enrich_${currentName}_vs_${firstName}`, centered);
      values.set(`Z_Enrich_${currentName}_vs_${firstName}`, zValues);
      values.set(`Pval_Enrich_${currentName}_vs_${firstName}`, pValues);
      values.set(qColumn, qValues);
      values.set(`Var_Enrich_${currentName}_vs_${firstName}`, variances);
    }
  }

  const sortColumn = roundNames.length > 1
    ? `Centered_Enrich_${roundNames[roundNames.length - 1]}_vs_${roundNames[0]}`
    : `RPM_${roundNames[0]}`;
  const sortValues = values.get(sortColumn)!;
  const order = Array.from({ length: rowCount }, (_, index) => index);
  order.sort((left, right) => {
    const a = sortValues[left] as number;
    const b = sortValues[right] as number;
    if (a > b) return -1;
    if (a < b) return 1;
    return peptides[left]! < peptides[right]! ? -1 : peptides[left]! > peptides[right]! ? 1 : 0;
  });

  const columns = buildColumnSpecs(roundNames);
  const csvParts = serializeCompactCsvChunked(
    order,
    columns,
    values,
    input.csvChunkChars ?? 4 * 1024 * 1024,
  );
  values.clear();
  return {
    rows: [],
    rowCount,
    columns,
    csvParts,
    libraryMedianEnrich,
    fdrHitCounts,
  };
}

function summarizeFdrHits(
  rows: ReadonlyArray<AnalyzerRow>,
  roundNames: ReadonlyArray<string>,
): Record<string, { q05: number; q01: number }> {
  const output: Record<string, { q05: number; q01: number }> = {};
  const first = roundNames[0];
  if (!first) return output;
  for (const current of roundNames.slice(1)) {
    const column = `FDR_q_${current}_vs_${first}`;
    let q05 = 0;
    let q01 = 0;
    for (const row of rows) {
      const q = row[column] as number;
      if (!Number.isFinite(q)) continue;
      if (q < 0.05) q05++;
      if (q < 0.01) q01++;
    }
    output[column] = { q05, q01 };
  }
  return output;
}

function serializeCompactCsvChunked(
  order: ReadonlyArray<number>,
  columns: ReadonlyArray<ColumnSpec>,
  values: ReadonlyMap<string, string[] | Float64Array | number[]>,
  targetChars: number,
): string[] {
  const output: string[] = [];
  const pending: string[] = [];
  let pendingChars = 0;
  const append = (line: string): void => {
    pending.push(line);
    pendingChars += line.length;
    if (pendingChars >= targetChars) {
      output.push(pending.join(""));
      pending.length = 0;
      pendingChars = 0;
    }
  };
  append(columns.map((column) => csvCell(column.name)).join(",") + "\n");
  for (const row of order) {
    const cells = new Array<string>(columns.length);
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex]!;
      cells[columnIndex] = formatCell(values.get(column.name)?.[row], column.type);
    }
    append(cells.join(",") + "\n");
  }
  if (pending.length > 0) output.push(pending.join(""));
  return output;
}

// CSV cell formatting per pandas.to_csv defaults (na_rep='', quoting=QUOTE_MINIMAL).
// Quotes only when the cell contains comma, double-quote, CR, or LF;
// embedded double-quotes are doubled.
function csvCell(s: string): string {
  if (/[,"\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Python repr() equivalent for a finite IEEE 754 double. JS Number.toString
// uses the same shortest-round-trip algorithm; the only divergence is integer-
// valued floats (Python emits "1.0", JS emits "1") which we patch here.
function pyFloatStr(n: number): string {
  if (Number.isNaN(n)) return "";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  const s = n.toString();
  // If toString omitted the decimal but the value is finite and integer-valued,
  // append ".0" to match pandas / Python repr behavior. Caveat: exponential
  // notation (e.g. "1e+21") already differs from Python repr for very large
  // numbers; not exercised by NGS-scale data so left unhandled here.
  if (Number.isInteger(n) && !/[.eE]/.test(s)) return s + ".0";
  return s;
}

function formatCell(value: RowValue | undefined, type: ColType): string {
  if (value === undefined || value === null) return "";
  switch (type) {
    case "string":
      return csvCell(String(value));
    case "int":
      return Number.isFinite(value as number) ? Math.trunc(value as number).toString() : "";
    case "float":
      return pyFloatStr(value as number);
    case "bool":
      return value ? "True" : "False";
  }
}

/** Serialize rows to CSV as a list of newline-terminated rows. */
export function serializeCsv(
  rows: ReadonlyArray<AnalyzerRow>,
  columns: ReadonlyArray<ColumnSpec>,
): string[] {
  const out = [columns.map((column) => csvCell(column.name)).join(",") + "\n"];
  for (const row of rows) {
    const cells: string[] = [];
    for (const column of columns) cells.push(formatCell(row[column.name], column.type));
    out.push(cells.join(",") + "\n");
  }
  return out;
}

/** Serialize rows to bounded newline-aligned chunks.
 *
 *  `parts.join("")` reproduces the historical output exactly. Bounded chunks
 *  avoid both V8's single-string ceiling and millions of one-line string
 *  objects on highly diverse libraries.
 *
 *  pandas to_csv defaults to "\n" line terminator (lineterminator='\n').
 */
export function serializeCsvChunked(
  rows: ReadonlyArray<AnalyzerRow>,
  columns: ReadonlyArray<ColumnSpec>,
  targetChars = 4 * 1024 * 1024,
): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  let pendingChars = 0;
  const append = (line: string): void => {
    pending.push(line);
    pendingChars += line.length;
    if (pendingChars >= targetChars) {
      out.push(pending.join(""));
      pending.length = 0;
      pendingChars = 0;
    }
  };
  append(columns.map((c) => csvCell(c.name)).join(",") + "\n");
  for (const row of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      cells.push(formatCell(row[col.name], col.type));
    }
    append(cells.join(",") + "\n");
  }
  if (pending.length > 0) out.push(pending.join(""));
  return out;
}
