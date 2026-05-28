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
async function runFixture(useWasm: boolean) {
  const cfgText = await readFile(path.join(FIX, "primers.yaml"), "utf8");
  const { rounds, settings } = loadRoundsFromYaml(cfgText);
  return runPipeline({
    sources: [fileSource(path.join(FIX, "sample_1k.fastq"))],
    rounds,
    settings,
    useWasm,
  });
}

function assertCsvEquals(actual: string, golden: string): void {
  if (actual === golden) return;
  const a = actual.split("\n");
  const g = golden.split("\n");
  const lines = Math.min(a.length, g.length);
  for (let i = 0; i < lines; i++) {
    if (a[i] !== g[i]) {
      throw new Error(`CSV diverges at line ${i + 1}:\n  expected: ${g[i]}\n  actual:   ${a[i]}`);
    }
  }
  if (a.length !== g.length) {
    throw new Error(`CSV row count differs: expected ${g.length} lines, got ${a.length}`);
  }
}

describe.each([
  { label: "TS path", useWasm: false },
  { label: "WASM path", useWasm: true },
])("Phase 1+2 parity ($label) vs desktop Python output (sample_1k fixture)", ({ useWasm }) => {
  it("run_stats.json matches byte-for-byte", async () => {
    const result = await runFixture(useWasm);
    const golden = await readFile(path.join(FIX, "golden", "run_stats.json"), "utf8");
    expect(result.runStatsJson).toBe(golden);
  });

  it("Master_Enrichment_Matrix.csv matches byte-for-byte", async () => {
    const result = await runFixture(useWasm);
    const golden = await readFile(path.join(FIX, "golden", "Master_Enrichment_Matrix.csv"), "utf8");
    assertCsvEquals(result.analyzer!.csv, golden);
    expect(result.analyzer!.csv).toBe(golden);
  });
});
