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
  };
  return { rounds, settings };
}

describe("LocalFastqSource via runPipeline → golden CSV", () => {
  it("Master_Enrichment_Matrix.csv matches byte-for-byte (both TS and WASM)", async () => {
    const fastqBytes = await readFile(path.join(CORE_FIX, "sample_1k.fastq"));
    const primersText = await readFile(path.join(CORE_FIX, "primers.yaml"), "utf8");
    const golden = await readFile(path.join(CORE_FIX, "golden/Master_Enrichment_Matrix.csv"), "utf8");

    const file = new File([fastqBytes], "sample_1k.fastq", { type: "application/octet-stream" });
    const source = new LocalFastqSource(file);
    const { rounds, settings } = loadConfig(primersText);

    for (const useWasm of [false, true]) {
      const result = await runPipeline({ sources: [source], rounds, settings, useWasm });
      expect(result.analyzer?.csv, `useWasm=${useWasm}`).toBe(golden);
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
