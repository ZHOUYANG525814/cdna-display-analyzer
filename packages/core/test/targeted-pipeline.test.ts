import { describe, expect, it } from "vitest";
import type { IFastqSource } from "@cdna/types";
import { runTargetedNanoporePipeline } from "../src/targeted-pipeline.js";

const REF = "ACGTTGCAAGTCGATCGTACGATGCTAGCTACGTCAGTGCATCGATGACCTGAGTACGAT" +
  "GCT" +
  "TCGACGATCAGTGCATGACCTAGTCGATGCTACGTTACGAGTCAGCTAGTCGATGCATG";
const TARGET = 61;
const Q = "I".repeat(REF.length);

class MemoryFastq implements IFastqSource {
  constructor(private name: string, private text: string) {}
  describe() { return { id: this.name, name: this.name, sizeBytes: this.text.length }; }
  async open() {
    const bytes = new TextEncoder().encode(this.text);
    return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 37)); c.enqueue(bytes.subarray(37)); c.close(); } });
  }
}

function record(id: string, seq: string, q = Q.slice(0, seq.length)): string {
  return `@${id} qs:f:20\n${seq}\n+\n${q}\n`;
}
function mutate(codon: string): string { return REF.slice(0, TARGET - 1) + codon + REF.slice(TARGET + 2); }
function rc(seq: string): string { return [...seq].reverse().map((x) => ({ A: "T", C: "G", G: "C", T: "A" }[x]!)).join(""); }

describe("runTargetedNanoporePipeline", () => {
  it("merges shards, removes duplicate IDs, handles reverse reads, and computes Round-0 fitness", async () => {
    const r0a = Array.from({ length: 10 }, (_, i) => record(`w${i}`, REF)).join("") + record("mut0", mutate("TGG"));
    const r0b = record("w0", REF) + record("rev", rc(mutate("TGG")));
    const r1 = record("w1x", REF) + Array.from({ length: 10 }, (_, i) => record(`m${i}`, mutate("TGG"))).join("");
    const result = await runTargetedNanoporePipeline({
      sources: [new MemoryFastq("r0a", r0a), new MemoryFastq("r0b", r0b), new MemoryFastq("r1", r1)],
      sourceRoundIndices: [0, 0, 1], roundNames: ["Round 0", "Round 1"], reference: REF,
      sites: [{ name: "site_01", ntStart: TARGET, length: 3, design: "ANY" }],
      settings: { minReadQ: 10, minReferenceCoverage: 0.9, minAlignmentIdentity: 0.85, minProtectedIdentity: 0.95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 1, reportHaplotypes: false },
    });
    expect(result.stats.get("Round 0")!.duplicate_read_ids).toBe(1);
    expect(result.dnaCounters.get("Round 0")!.get("site_01")!.get("TGG")).toBe(2);
    expect(result.dnaCounters.get("Round 1")!.get("site_01")!.get("TGG")).toBe(10);
    const trp = result.analyzer.perSiteRows.find((x) => x.Variant_AA === "W")!;
    expect(trp["Fitness_vs_WT_Round 1"] as number).toBeGreaterThan(4);
    expect(trp.Score_Eligible).toBe("yes");
  });

  it("rescues a locally high-quality target from a partial read without creating a haplotype", async () => {
    const partial = mutate("TGG").slice(20, 105);
    const result = await runTargetedNanoporePipeline({
      sources: [new MemoryFastq("r0", record("p0", partial)), new MemoryFastq("r1", record("p1", partial))],
      sourceRoundIndices: [0, 1], roundNames: ["Round 0", "Round 1"], reference: REF,
      sites: [{ name: "site_01", ntStart: TARGET, length: 3, design: "ANY" }],
      settings: { minReadQ: 10, minReferenceCoverage: 0.9, minAlignmentIdentity: 0.85, minProtectedIdentity: 0.95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 1, reportHaplotypes: true, rescueFlankBases: 20 },
    });
    expect(result.stats.get("Round 0")!.full_qc_passed).toBe(0);
    expect(result.stats.get("Round 0")!.sites.site_01.callable_rescued).toBe(1);
    expect(result.haplotypeCounters.get("Round 0")!.size).toBe(0);
  });

  it("does not let semiglobal alignment turn a concatemer into a valid read", async () => {
    const concatemer = REF + REF;
    const result = await runTargetedNanoporePipeline({
      sources: [new MemoryFastq("r0", record("c0", concatemer, "I".repeat(concatemer.length))), new MemoryFastq("r1", record("w", REF))],
      sourceRoundIndices: [0, 1], roundNames: ["Round 0", "Round 1"], reference: REF,
      sites: [{ name: "site_01", ntStart: TARGET, length: 3, design: "ANY" }],
      settings: { minReadQ: 10, minReferenceCoverage: 0.9, minAlignmentIdentity: 0.85, minProtectedIdentity: 0.95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 1, reportHaplotypes: false },
    });
    expect(result.stats.get("Round 0")!.primary_drop_reasons.concatemer_or_chimera).toBe(1);
    expect(result.stats.get("Round 0")!.aligned).toBe(0);
  });

  it("places malformed FASTQ records in an exclusive bucket without aborting later records", async () => {
    const malformed = `@bad qs:f:20\n${REF}\nnot-plus\n${Q}\n`;
    const result = await runTargetedNanoporePipeline({
      sources: [new MemoryFastq("r0.fastqsanger", malformed + record("good0", REF)), new MemoryFastq("r1.fastq", record("good1", REF))],
      sourceRoundIndices: [0, 1], roundNames: ["Round 0", "Round 1"], reference: REF,
      sites: [{ name: "site_01", ntStart: TARGET, length: 3, design: "NNK" }],
      settings: { minReadQ: 10, minReferenceCoverage: 0.9, minAlignmentIdentity: 0.85, minProtectedIdentity: 0.95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 1, reportHaplotypes: false },
    });
    expect(result.stats.get("Round 0")!.primary_drop_reasons.malformed_fastq).toBe(1);
    expect(result.stats.get("Round 0")!.full_qc_passed).toBe(1);
  });
});
