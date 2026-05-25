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

import { calculateGc, translateDna } from "./dna.js";
import type { RoundStats } from "./demultiplex.js";

export interface AnalyzerInput {
  roundNames: ReadonlyArray<string>;
  // round name → (DNA sequence → occurrence count)
  dnaCounters: ReadonlyMap<string, ReadonlyMap<string, number>>;
  // round name → demultiplex stats (only passed_qc is read; it's the RPM denominator)
  stats: ReadonlyMap<string, RoundStats>;
}

export type RowValue = string | number | boolean;

export interface AnalyzerRow {
  Peptide_Seq: string;
  Dominant_DNA_Seq: string;
  GC_Percent: number;
  Present_In_All: boolean;
  [key: string]: RowValue; // Count_*, RPM_*, Rank_*, Enrich_Step_*, Enrich_Global_*
}

export interface AnalyzerOutput {
  rows: AnalyzerRow[];
  columns: ReadonlyArray<ColumnSpec>;
  csv: string;
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
    { name: "GC_Percent", type: "float" },
  ];
  for (const r of roundNames) cols.push({ name: `Count_${r}`, type: "int" });
  for (const r of roundNames) {
    cols.push({ name: `RPM_${r}`, type: "float" });
    cols.push({ name: `Rank_${r}`, type: "int" });
  }
  for (let i = 1; i < roundNames.length; i++) {
    const prev = roundNames[i - 1];
    const curr = roundNames[i];
    cols.push({ name: `Enrich_Step_${curr}_vs_${prev}`, type: "float" });
  }
  const first = roundNames[0];
  if (first !== undefined) {
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i];
      cols.push({ name: `Enrich_Global_${curr}_vs_${first}`, type: "float" });
    }
  }
  cols.push({ name: "Present_In_All", type: "bool" });
  return cols;
}

// Competition ranking ('min' method), descending. Tied values share the
// minimum rank; the next distinct value skips ranks accordingly.
// Matches pandas.Series.rank(method='min', ascending=False).astype(int).
function rankMinDesc(values: ReadonlyArray<number>): number[] {
  const n = values.length;
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => values[b]! - values[a]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && values[idx[j]!] === values[idx[i]!]) j++;
    const r = i + 1; // 1-based, minimum rank for the tie group
    for (let k = i; k < j; k++) ranks[idx[k]!] = r;
    i = j;
  }
  return ranks;
}

interface AaRecord {
  counts: Map<string, number>;          // round name → total count
  dnaFreq: Map<string, number>;         // DNA seq → count (for dominant pick + GC%)
}

export function runAnalyzer(input: AnalyzerInput): AnalyzerOutput | null {
  const { roundNames, dnaCounters, stats } = input;

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
      // Strictly greater so the first-seen DNA wins on ties — matches Python's
      // max(...) which returns the first item with the maximum key.
      if (c > domCount) {
        domCount = c;
        domDna = dna;
      }
    }
    const row: AnalyzerRow = {
      Peptide_Seq: aa,
      Dominant_DNA_Seq: domDna,
      GC_Percent: calculateGc(domDna),
      Present_In_All: false, // filled in below
    };
    for (const rnd of roundNames) {
      row[`Count_${rnd}`] = rec.counts.get(rnd)!;
    }
    rows.push(row);
  }

  // 3. RPM (per million of passed_qc) + competition rank.
  for (const rnd of roundNames) {
    const totalValid = stats.get(rnd)?.passed_qc ?? 0;
    const rpms: number[] = [];
    for (const row of rows) {
      const c = row[`Count_${rnd}`] as number;
      const rpm = totalValid > 0 ? (c / totalValid) * 1e6 : 0.0;
      row[`RPM_${rnd}`] = rpm;
      rpms.push(rpm);
    }
    const ranks = rankMinDesc(rpms);
    for (let i = 0; i < rows.length; i++) {
      rows[i]![`Rank_${rnd}`] = ranks[i]!;
    }
  }

  // 4. Enrichment: stepwise then global. Pseudocount 1.0 inside the log.
  const PSEUDO = 1.0;
  for (let i = 1; i < roundNames.length; i++) {
    const prev = roundNames[i - 1]!;
    const curr = roundNames[i]!;
    const col = `Enrich_Step_${curr}_vs_${prev}`;
    for (const row of rows) {
      const a = row[`RPM_${curr}`] as number;
      const b = row[`RPM_${prev}`] as number;
      row[col] = Math.log2((a + PSEUDO) / (b + PSEUDO));
    }
  }
  const first = roundNames[0];
  if (first !== undefined) {
    for (let i = 1; i < roundNames.length; i++) {
      const curr = roundNames[i]!;
      const col = `Enrich_Global_${curr}_vs_${first}`;
      for (const row of rows) {
        const a = row[`RPM_${curr}`] as number;
        const b = row[`RPM_${first}`] as number;
        row[col] = Math.log2((a + PSEUDO) / (b + PSEUDO));
      }
    }
  }

  // 5. Present_In_All: every round has count > 0 for this peptide.
  for (const row of rows) {
    let all = true;
    for (const rnd of roundNames) {
      if ((row[`Count_${rnd}`] as number) <= 0) {
        all = false;
        break;
      }
    }
    row.Present_In_All = all;
  }

  // 6. Stable sort by primary enrichment desc, secondary Peptide_Seq asc.
  //    Mirrors the Python side after the kind='stable' patch.
  let sortCol: string;
  if (roundNames.length > 1) {
    sortCol = `Enrich_Global_${roundNames[roundNames.length - 1]}_vs_${roundNames[0]}`;
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
  const csv = serializeCsv(rows, columns);
  return { rows, columns, csv };
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

export function serializeCsv(
  rows: ReadonlyArray<AnalyzerRow>,
  columns: ReadonlyArray<ColumnSpec>,
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvCell(c.name)).join(","));
  for (const row of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      cells.push(formatCell(row[col.name], col.type));
    }
    lines.push(cells.join(","));
  }
  // pandas to_csv defaults to \n line terminator (lineterminator='\n').
  return lines.join("\n") + "\n";
}
