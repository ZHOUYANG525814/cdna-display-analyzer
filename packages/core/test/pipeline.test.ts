import { describe, expect, it } from "vitest";
import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";
import { runPipeline } from "../src/pipeline.js";
import type { DemultiplexSettings, RoundConfigInput } from "../src/demultiplex.js";

const ENC = new TextEncoder();

// In-memory IFastqSource backed by a string. Splits into chunks of `chunkSize`
// bytes so we can exercise the same chunk-boundary code path the Drive stream
// will hit. We also feed `qual` lines of length matching `seq` and made of
// 'I' (Phred 40) so the reads always pass the mean-Q filter unless we want them not to.
function makeSource(name: string, content: string, chunkSize: number = 64): IFastqSource {
  const bytes = ENC.encode(content);
  return {
    describe(): FastqSourceDescriptor {
      return { id: name, name, sizeBytes: bytes.length };
    },
    async open(): Promise<ReadableStream<Uint8Array>> {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.length, offset + chunkSize);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
    },
  };
}

const STRICT: DemultiplexSettings = {
  adaptive: true,
  filterStop: true,
  minMeanPhred: 20.0,
  minMeanPhredCds: 20.0,
};

const ROUND: RoundConfigInput = {
  name: "R0",
  fwPrimer: "GGGGGAAAAACCCCC",      // barcode GGGGG + anchor AAAAACCCCC
  rvPrimer: "TTTTTGGGGG",             // rv_anchor = CCCCCAAAAA
  cdsStart: 1,
  cdsEnd: 9,                          // 9 bp CDS = 3 codons
};

function mkFastq(records: { id: string; seq: string }[]): string {
  let out = "";
  for (const r of records) {
    const qual = "I".repeat(r.seq.length); // all Phred 40
    out += `@${r.id}\n${r.seq}\n+\n${qual}\n`;
  }
  return out;
}

describe("runPipeline (end-to-end on in-memory source)", () => {
  it("processes a clean record stream to passed_qc + populated counters", async () => {
    const fq = mkFastq([
      { id: "r1", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" },
      { id: "r2", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" },
      { id: "r3", seq: "GGGGG" + "AAAAACCCCC" + "ATGTCATTT" + "TTTT" }, // different peptide
    ]);
    const src = makeSource("test.fastq", fq);
    const result = await runPipeline({ sources: [src], rounds: [ROUND], settings: STRICT, pseudocount: 0.5 });
    expect(result.stats.get("R0")!.passed_qc).toBe(3);
    expect(result.dnaCounters.get("R0")!.get("ATGGCCAAA")).toBe(2);
    expect(result.dnaCounters.get("R0")!.get("ATGTCATTT")).toBe(1);
    expect(result.globalUnassigned).toBe(0);
  });

  it("retries reverse-complement when the sense strand has no anchor", async () => {
    const senseRead = "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT";
    // Reverse-complement the entire sense read to simulate an antisense FASTQ entry.
    const rc = "AAAA" + "TTTGGCCAT" + "GGGGGTTTTT" + "CCCCC";
    const fq = mkFastq([{ id: "anti", seq: rc }]);
    const src = makeSource("test.fastq", fq);
    const result = await runPipeline({ sources: [src], rounds: [ROUND], settings: STRICT, pseudocount: 0.5 });
    expect(result.stats.get("R0")!.passed_qc).toBe(1);
    expect(result.globalUnassigned).toBe(0);
  });

  it("drops a low-quality read and charges low_quality bucket", async () => {
    // Build a record with qual mean < 20. Phred 19 → ASCII 52 = '4'.
    const seq = "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT";
    const qual = "4".repeat(seq.length);
    const fq = `@r1\n${seq}\n+\n${qual}\n`;
    const src = makeSource("test.fastq", fq);
    const result = await runPipeline({ sources: [src], rounds: [ROUND], settings: STRICT, pseudocount: 0.5 });
    expect(result.stats.get("R0")!.passed_qc).toBe(0);
    expect(result.unassignedBreakdown.low_quality).toBe(1);
    expect(result.globalUnassigned).toBe(1);
  });

  it("produces run_stats.json matching the Python schema (sorted keys, indent=2)", async () => {
    const fq = mkFastq([{ id: "r1", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" }]);
    const src = makeSource("test.fastq", fq);
    const result = await runPipeline({ sources: [src], rounds: [ROUND], settings: STRICT, pseudocount: 0.5 });

    // Schema: top-level keys sorted alphabetically.
    const parsed = JSON.parse(result.runStatsJson);
    expect(Object.keys(parsed)).toEqual([
      "global_unassigned",
      "rounds",
      "schema_version",
      "statistical_model",
      "unassigned_breakdown",
    ]);
    expect(parsed.statistical_model.pseudocount).toBe(0.5);
    expect(parsed.statistical_model.pseudocount_unit).toBe("RPM");

    // Per-round stats keys sorted too.
    const rndKeys = Object.keys(parsed.rounds.R0);
    expect(rndKeys).toEqual([...rndKeys].sort());

    // 2-space indent observable in the raw string.
    expect(result.runStatsJson).toContain('\n  "global_unassigned":');

    // No trailing newline (matches Python json.dump which doesn't append one).
    expect(result.runStatsJson.endsWith("}")).toBe(true);
  });

  it("survives a small chunk size (1-byte chunks) without losing records", async () => {
    const fq = mkFastq([
      { id: "r1", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" },
      { id: "r2", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" },
    ]);
    const src = makeSource("test.fastq", fq, 1);
    const result = await runPipeline({ sources: [src], rounds: [ROUND], settings: STRICT, pseudocount: 0.5 });
    expect(result.stats.get("R0")!.passed_qc).toBe(2);
  });

  it("merges counters across multiple sources for the same round", async () => {
    const fq1 = mkFastq([{ id: "a", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" }]);
    const fq2 = mkFastq([{ id: "b", seq: "GGGGG" + "AAAAACCCCC" + "ATGGCCAAA" + "TTTT" }]);
    const result = await runPipeline({
      sources: [makeSource("a", fq1), makeSource("b", fq2)],
      rounds: [ROUND],
      settings: STRICT,
      pseudocount: 0.5,
    });
    expect(result.stats.get("R0")!.passed_qc).toBe(2);
    expect(result.dnaCounters.get("R0")!.get("ATGGCCAAA")).toBe(2);
  });
});
