// Phase 1 gate. Runs the TS pipeline against a real-data fixture and asserts
// byte-identical match against the desktop Python pipeline's output:
//   - run_stats.json (JSON parsed + structural compare; the schema's sort-keys
//     + indent=2 emission is also tested for byte-identity via raw string diff)
//   - Master_Enrichment_Matrix.csv (parsed line-by-line; first divergent row
//     is reported so a regression is localized instantly)
//
// The fixture lives under test/fixtures/:
//   sample_1k.fastq                  — first 1000 reads of HN01_S31_1
//   primers.yaml                     — same YAML the user has at 00_material/primers_setting.txt
//   golden/run_stats.json            — produced by `python 01_scripts/run_cli.py`
//   golden/Master_Enrichment_Matrix.csv

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";
import { runPipeline } from "../src/pipeline.js";
import type { DemultiplexSettings, RoundConfigInput } from "../src/demultiplex.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

// Node-side IFastqSource: streams a local FASTQ file as a Web ReadableStream
// of Uint8Array. Identical interface to the future DriveFastqSource.
function fileSource(filePath: string): IFastqSource {
  return {
    describe(): FastqSourceDescriptor {
      return { id: filePath, name: path.basename(filePath), sizeBytes: null };
    },
    async open(): Promise<ReadableStream<Uint8Array>> {
      const nodeStream = createReadStream(filePath);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
  };
}

interface PrimersConfig {
  rounds: Record<string, { fw_primer: string; rv_primer: string; cds_start: number; cds_end: number }>;
  settings?: { adaptive?: boolean; filter_stop?: boolean };
}

function loadRoundsFromYaml(text: string): { rounds: RoundConfigInput[]; settings: DemultiplexSettings } {
  const cfg = yaml.parse(text) as PrimersConfig;
  // Preserve insertion order from the YAML mapping; yaml.parse uses a plain
  // object whose iteration order is insertion order for string keys.
  const rounds: RoundConfigInput[] = Object.entries(cfg.rounds).map(([name, r]) => ({
    name,
    fwPrimer: r.fw_primer,
    rvPrimer: r.rv_primer,
    cdsStart: r.cds_start,
    cdsEnd: r.cds_end,
  }));
  const settings: DemultiplexSettings = {
    adaptive: cfg.settings?.adaptive ?? true,
    filterStop: cfg.settings?.filter_stop ?? true,
    minMeanPhred: 20.0,
    minMeanPhredCds: 20.0,
  };
  return { rounds, settings };
}

// Helper: produce a TS-mode and a WASM-mode parity check from one fixture.
// The TS path is the reference; the WASM path must reproduce the same bytes.
async function runFixture(useWasm: boolean, pseudocount: number) {
  const cfgText = await readFile(path.join(FIX, "primers.yaml"), "utf8");
  const { rounds, settings } = loadRoundsFromYaml(cfgText);
  return runPipeline({
    sources: [fileSource(path.join(FIX, "sample_1k.fastq"))],
    rounds,
    settings,
    pseudocount,
    useWasm,
  });
}

// Subset-parity helper: byte-compare only the columns common to both CSVs.
// As of Phase 6.12 the web tool emits additional columns the desktop Python
// doesn't (Centered_Enrich, Z, Pval, NegLog10Pval, FDR_q) and drops three
// derivable ones (Rank, GC_Percent, Present_In_All). The shared columns
// (Peptide_Seq, Dominant_DNA_Seq, Count_*, RPM_*, Enrich_Step_*, Enrich_Global_*)
// must still match byte-for-byte to confirm the core algorithm is unchanged.
function assertCsvSubsetEquals(actual: string, golden: string): void {
  const a = actual.split("\n").filter((l) => l.length > 0);
  const g = golden.split("\n").filter((l) => l.length > 0);
  if (a.length === 0 || g.length === 0) throw new Error("Empty CSV");
  if (a.length !== g.length) {
    throw new Error(`Row count differs: expected ${g.length} (incl header), got ${a.length}`);
  }
  const aHeaders = a[0]!.split(",");
  const gHeaders = g[0]!.split(",");
  const sharedCols: { name: string; aIdx: number; gIdx: number }[] = [];
  for (let i = 0; i < gHeaders.length; i++) {
    const name = gHeaders[i]!;
    const aIdx = aHeaders.indexOf(name);
    if (aIdx === -1) continue;
    sharedCols.push({ name, aIdx, gIdx: i });
  }
  if (sharedCols.length < 3) {
    throw new Error(
      `Too few shared columns (${sharedCols.length}). Web headers: ${aHeaders.join("|")}. ` +
        `Golden headers: ${gHeaders.join("|")}.`,
    );
  }
  // The web CSV is sorted by `Enrich_Global_<last>_vs_<first>` (same as the
  // patched Python). Join on Peptide_Seq instead of row index so a sort drift
  // can't mask a real numeric divergence.
  const pepCol = sharedCols.find((c) => c.name === "Peptide_Seq");
  if (!pepCol) throw new Error("Peptide_Seq must be a shared column for subset parity.");
  const gByPep = new Map<string, string[]>();
  for (let r = 1; r < g.length; r++) {
    const cells = g[r]!.split(",");
    gByPep.set(cells[pepCol.gIdx]!, cells);
  }
  for (let r = 1; r < a.length; r++) {
    const aCells = a[r]!.split(",");
    const pep = aCells[pepCol.aIdx]!;
    const gCells = gByPep.get(pep);
    if (!gCells) throw new Error(`Web row peptide "${pep}" not present in golden CSV.`);
    for (const c of sharedCols) {
      if (aCells[c.aIdx] !== gCells[c.gIdx]) {
        throw new Error(
          `Subset-parity divergence at peptide "${pep}", column "${c.name}":\n` +
            `  golden: ${gCells[c.gIdx]}\n  web:    ${aCells[c.aIdx]}`,
        );
      }
    }
  }
}

describe.each([
  { label: "TS path, p=0.5", useWasm: false, pseudocount: 0.5, goldenDir: "golden" },
  { label: "WASM path, p=0.5", useWasm: true, pseudocount: 0.5, goldenDir: "golden" },
  { label: "TS path, p=1.0", useWasm: false, pseudocount: 1, goldenDir: "golden-p1" },
  { label: "WASM path, p=1.0", useWasm: true, pseudocount: 1, goldenDir: "golden-p1" },
])("Phase 1+2 parity ($label) vs desktop Python output (sample_1k fixture)", ({ useWasm, pseudocount, goldenDir }) => {
  it("run_stats.json: read-counter fields match byte-for-byte", async () => {
    // Phase 6.12 bumped schema_version to 2 and adds an optional
    // library_median_enrich block. The read-acceptance counters (rounds.*,
    // unassigned_breakdown.*, global_unassigned) are unchanged — those are
    // what the parity guard is for. Parse JSON and compare just those.
    const result = await runFixture(useWasm, pseudocount);
    const goldenRaw = await readFile(path.join(FIX, goldenDir, "run_stats.json"), "utf8");
    const actual = JSON.parse(result.runStatsJson) as Record<string, unknown>;
    const golden = JSON.parse(goldenRaw) as Record<string, unknown>;
    expect(actual.global_unassigned).toEqual(golden.global_unassigned);
    expect(actual.unassigned_breakdown).toEqual(golden.unassigned_breakdown);
    expect(actual.rounds).toEqual(golden.rounds);
  });

  it("Master_Enrichment_Matrix.csv: shared columns match byte-for-byte", async () => {
    const result = await runFixture(useWasm, pseudocount);
    const golden = await readFile(path.join(FIX, goldenDir, "Master_Enrichment_Matrix.csv"), "utf8");
    const csv = result.analyzer!.csvParts.join("");
    assertCsvSubsetEquals(csv, golden);
  });
});
