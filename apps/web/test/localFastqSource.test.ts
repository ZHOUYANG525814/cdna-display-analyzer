// Phase 3 gate: verify the LocalFastqSource → runPipeline path produces the
// same byte-identical CSV as the Node/desktop golden. This is the
// "everything below the worker boundary" check; the actual worker is
// exercised by manual browser verification (vitest can't host a real Worker
// without the browser-mode runner).

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { runPipeline, type DemultiplexSettings, type RoundConfigInput } from "@cdna/core";
import { LocalFastqSource } from "../src/adapters/LocalFastqSource";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Reuse the fixture from packages/core — same sample FASTQ + same golden CSV.
const CORE_FIX = path.resolve(HERE, "../../../packages/core/test/fixtures");

interface PrimersFile {
  rounds: Record<string, { fw_primer: string; rv_primer: string; cds_start: number; cds_end: number }>;
  settings?: { adaptive?: boolean; filter_stop?: boolean };
}

// Inline YAML → typed config. The production app builds these from per-round
// form fields directly; the test exercises the same shape from the YAML
// fixture so we don't drift from the desktop tool's input.
function loadConfig(text: string): { rounds: RoundConfigInput[]; settings: DemultiplexSettings } {
  const cfg = parseYaml(text) as PrimersFile;
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

describe("LocalFastqSource via runPipeline → golden CSV (shared columns)", () => {
  it("Master_Enrichment_Matrix.csv: Peptide_Seq / Count_* / RPM_* / Enrich_* match golden", async () => {
    // Phase 6.12 introduced new columns (Centered/Z/Pval/NegLog10Pval/FDR_q)
    // and dropped derivable ones (Rank/GC/Present_In_All), so byte-for-byte
    // equality vs the desktop Python golden no longer holds. The columns
    // common to both must still match exactly — that's the algorithmic
    // contract this test guards.
    const fastqBytes = await readFile(path.join(CORE_FIX, "sample_1k.fastq"));
    const primersText = await readFile(path.join(CORE_FIX, "primers.yaml"), "utf8");
    const golden = await readFile(path.join(CORE_FIX, "golden/Master_Enrichment_Matrix.csv"), "utf8");

    const file = new File([fastqBytes], "sample_1k.fastq", { type: "application/octet-stream" });
    const source = new LocalFastqSource(file);
    const { rounds, settings } = loadConfig(primersText);

    for (const useWasm of [false, true]) {
      const result = await runPipeline({ sources: [source], rounds, settings, pseudocount: 0.5, useWasm });
      const csv = result.analyzer!.csvParts.join("");
      // Build a header-name → column-index map for both, intersect, and
      // compare cell values for the shared columns. Join on Peptide_Seq so
      // a sort drift can't mask a numerical divergence.
      const aLines = csv.split("\n").filter((l) => l.length > 0);
      const gLines = golden.split("\n").filter((l) => l.length > 0);
      const aHeaders = aLines[0]!.split(",");
      const gHeaders = gLines[0]!.split(",");
      const shared = gHeaders
        .map((name, gIdx) => ({ name, gIdx, aIdx: aHeaders.indexOf(name) }))
        .filter((c) => c.aIdx !== -1);
      expect(shared.length, `useWasm=${useWasm}`).toBeGreaterThan(3);
      const pepCol = shared.find((c) => c.name === "Peptide_Seq")!;
      const gByPep = new Map<string, string[]>();
      for (let i = 1; i < gLines.length; i++) {
        const cells = gLines[i]!.split(",");
        gByPep.set(cells[pepCol.gIdx]!, cells);
      }
      for (let i = 1; i < aLines.length; i++) {
        const aCells = aLines[i]!.split(",");
        const pep = aCells[pepCol.aIdx]!;
        const gCells = gByPep.get(pep);
        expect(gCells, `useWasm=${useWasm}, peptide ${pep}`).toBeTruthy();
        for (const c of shared) {
          expect(
            aCells[c.aIdx],
            `useWasm=${useWasm}, peptide ${pep}, column ${c.name}`,
          ).toBe(gCells![c.gIdx]);
        }
      }
    }
  });

  it("describe() reports name + sizeBytes", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "x.fastq");
    const source = new LocalFastqSource(file);
    const d = source.describe();
    expect(d.name).toBe("x.fastq");
    expect(d.sizeBytes).toBe(3);
  });
});
